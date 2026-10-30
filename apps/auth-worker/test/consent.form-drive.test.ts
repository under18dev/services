import { SELF } from "cloudflare:test";
import { scopeLabel } from "@u18/web-ui";
import { beforeEach, describe, expect, it } from "vitest";
import { freshIpFactory } from "./fresh-ip";
import { resetDatabase } from "./helpers";
import {
  PUBLIC_CLIENT_ID,
  REDIRECT_URI,
  authorizeQuery,
  createPkcePair,
  seedDefaultClients,
  seedLoggedInUser,
  sessionCookie,
  type SeededUser,
} from "./helpers.oauth";

/**
 * **描かれた form だけで同意を完走する**（#332 の P2）。
 *
 * `login.form-drive.test.ts` の同意画面版である。あちらと同じ理由で要る
 * ——「パスとフィールド名を直書きして POST する」検査は、**画面を
 * 組み直したときに継ぎ目がずれても緑のまま**になる。
 *
 * ## ここが無かったときに何が通ったか（実測）
 *
 * `consent-page.tsx` から **CSRF の hidden input を 1 行消して、
 * auth-worker の 918 本が全部通った。** `oauth-authorize.test.ts` は
 * `consent()` helper が**自分で `csrf_token` を組み立てて送っている**ので、
 * 画面が描かなくなったことを見ていない。
 *
 * 本番では「許可する」を押すたびに 403 の
 * 「ログインを続行できません」が出る —— **u18 のアカウントで他の
 * サービスへログインできなくなる**。状態コードも HTML も壊れていないので
 * 外形監視にも出ない。
 *
 * ## 何を見ているか
 *
 * 画面が言っている `action` / `method` / 入力の名前**だけ**を使って送る。
 * `decision` だけは `<button>` の `name`/`value` で、利用者が押す値なので
 * こちらが入れる（どちらのボタンを押したかが入力である）。
 */

const BASE = "http://localhost";
const ORIGIN = "http://localhost:8787";

const freshIp = freshIpFactory("consent-form-drive");

type Form = {
  readonly action: string;
  readonly method: string;
  readonly fields: Readonly<Record<string, string>>;
};

/** HTML から form を 1 つ取り出す。既定へ落ちたことが分かるよう空文字で返す。 */
function formIn(html: string, marker: string): Form {
  const tags = [...html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/g)];
  const found = tags.find(([, attrs, body]) => `${attrs}${body}`.includes(marker));
  if (found === undefined) throw new Error(`${marker} を含む form が無い`);

  const [, attrs = "", body = ""] = found;
  const fields: Record<string, string> = {};
  for (const [, tag] of [...body.matchAll(/(<input\b[^>]*>)/g)]) {
    const name = /\bname="([^"]*)"/.exec(tag ?? "")?.[1];
    if (name === undefined) continue;
    fields[name] = /\bvalue="([^"]*)"/.exec(tag ?? "")?.[1] ?? "";
  }

  return {
    action: /\baction="([^"]*)"/.exec(attrs)?.[1] ?? "",
    method: (/\bmethod="([^"]*)"/.exec(attrs)?.[1] ?? "").toLowerCase(),
    fields,
  };
}

const cookiePairs = (r: Response): string[] =>
  r.headers.getSetCookie().map((raw) => raw.split(";")[0] ?? "");

/** 同意画面を開く。HTML と、CSRF Cookie を足した Cookie 列を返す。 */
async function openConsent(
  user: SeededUser,
  overrides: Record<string, string | undefined>,
): Promise<{ html: string; cookie: string }> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(authorizeQuery(overrides))) {
    if (value !== undefined) params.set(key, value);
  }

  const response = await SELF.fetch(`${BASE}/oauth/authorize?${params.toString()}`, {
    headers: { Cookie: sessionCookie(user), "CF-Connecting-IP": freshIp() },
  });
  expect(response.status, "同意画面が 200 で出ていない").toBe(200);

  return {
    html: await response.text(),
    cookie: [sessionCookie(user), ...cookiePairs(response)].join("; "),
  };
}

/** form が言っているとおりに送る。**こちらでパスも名前も足さない。** */
function send(
  form: Form,
  filled: Readonly<Record<string, string>>,
  cookie: string,
): Promise<Response> {
  return SELF.fetch(`${BASE}${form.action}`, {
    method: form.method,
    redirect: "manual",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "CF-Connecting-IP": freshIp(),
      Origin: ORIGIN,
      Cookie: cookie,
    },
    body: new URLSearchParams({ ...form.fields, ...filled }).toString(),
  });
}

describe("描かれた form だけで同意を完走する", () => {
  let user: SeededUser;
  let challenge: string;

  beforeEach(async () => {
    await resetDatabase();
    await seedDefaultClients();
    user = await seedLoggedInUser();
    challenge = (await createPkcePair()).challenge;
  });

  const thirdParty = (overrides: Record<string, string | undefined> = {}) => ({
    client_id: PUBLIC_CLIENT_ID,
    code_challenge: challenge,
    ...overrides,
  });

  it("form が POST で、認可要求を 1 つ残らず hidden で運んでいる", async () => {
    const { html } = await openConsent(user, thirdParty({ nonce: "nonce-123" }));
    const form = formIn(html, 'name="client_id"');

    // **`method` が消えるとブラウザは GET で送る。** CSRF トークンも
    // 認可要求もクエリに載り、Origin 検証で弾かれる前に履歴へ残る。
    expect(form.method, "method が post でない（既定の GET になる）").toBe("post");
    expect(form.action, "action が空（現在の URL へ送られる）").not.toBe("");

    // **CSRF トークン。これが欠けると、許可を押すたびに 403 になる。**
    expect(form.fields["csrf_token"], "CSRF トークンが hidden に無い").toBeTruthy();

    // 認可要求は POST 側で検証し直される（hidden は「覚えておく」ため）。
    // **運ばれていなければ検証のしようがない。**
    expect(form.fields).toMatchObject({
      client_id: PUBLIC_CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      response_type: "code",
      scope: "openid profile email",
      state: "state-123",
      nonce: "nonce-123",
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
  });

  it("「許可する」を押すだけでコードが発行される", async () => {
    const { html, cookie } = await openConsent(user, thirdParty());
    const form = formIn(html, 'name="client_id"');

    // `decision` は `<button>` の name/value。**どちらを押したかが入力**なので
    // ここで入れる。値そのものは画面の文言（許可する）と対になっている。
    const allowed = await send(form, { decision: "allow" }, cookie);

    expect(allowed.status, "許可してもコードへ進めない").toBe(303);
    const location = new URL(allowed.headers.get("Location") ?? "", BASE);
    expect(`${location.origin}${location.pathname}`).toBe(REDIRECT_URI);
    expect(location.searchParams.get("code"), "認可コードが無い").toBeTruthy();
    expect(location.searchParams.get("state")).toBe("state-123");
  });

  it("「許可しない」は access_denied で戻る", async () => {
    const { html, cookie } = await openConsent(user, thirdParty());
    const form = formIn(html, 'name="client_id"');

    const denied = await send(form, { decision: "deny" }, cookie);

    expect(denied.status).toBe(303);
    const location = new URL(denied.headers.get("Location") ?? "", BASE);
    expect(location.searchParams.get("error")).toBe("access_denied");
    expect(location.searchParams.get("code")).toBeNull();
  });

  it("prompt は hidden で運ばれない（運ぶと同意から進めなくなる）", async () => {
    // `prompt=consent` は「同意画面を出せ」という指示で、**同意画面が出て
    // いる時点で果たされている。** 運ぶと POST でもう一度同意画面が出て、
    // 利用者は永遠に先へ進めない。`consent-page.tsx` の設計判断を、
    // **押して確かめる**形にしてある。
    const { html, cookie } = await openConsent(user, thirdParty({ prompt: "consent" }));
    const form = formIn(html, 'name="client_id"');

    expect(Object.keys(form.fields)).not.toContain("prompt");
    expect(Object.keys(form.fields)).not.toContain("max_age");

    const allowed = await send(form, { decision: "allow" }, cookie);
    expect(allowed.status, "同意画面へ戻っている（prompt を運んでいる）").toBe(303);
  });

  it("要求された scope の文言が、連携アプリ画面と同じ語彙で出ている", async () => {
    // `scopeLabel` は dashboard の `grants-page.tsx` と共有している。
    // **許可したときと取り消すときで言葉が違うと、利用者は同じものを
    // 取り消そうとしていると確信できない。**
    const { html } = await openConsent(user, thirdParty());

    for (const scope of ["openid", "profile", "email"]) {
      expect(html, `${scope} の文言が出ていない`).toContain(scopeLabel(scope));
    }
  });
});

import { SELF, env } from "cloudflare:test";
import { sessionCookieName } from "@u18/contracts";
import { createIdentityDatabase, users } from "@u18/db";
import { newId } from "@u18/domain";
import { aUser } from "@u18/testing";
import { beforeEach, describe, expect, it } from "vitest";
import { Sha256TokenHasher } from "../src/infrastructure/crypto/web-crypto";
import { DrizzleEmailChallengeRepository } from "../src/infrastructure/persistence/drizzle-email-challenge.repository";
import { freshIpFactory } from "./fresh-ip";
import { resetDatabase } from "./helpers";

/**
 * **描かれた form だけを頼りに、JS 無しでログインを完走する**（#332）。
 *
 * ## すでにある検査では足りない
 *
 * `login.ui.test.ts` の「メール OTP ログイン（JavaScript 無し）」は、
 * **form を読んでいない。** `submit("/login/start", { email, csrf_token })`
 * のように**パスとフィールド名を直書きして POST している**ので、
 *
 *  - form の `action` が変わっても
 *  - `method="post"` が消えても
 *  - `name="email"` が `name="mail"` になっても
 *
 * **全部そのまま緑で通る。** 画面を組み直す側から見ると、**最も壊しやすい
 * ものが、最も見られていない。**
 *
 * `method` に至っては**どこでも検査されていない。** 属性が無い form を
 * ブラウザは GET として送るので、**OTP がクエリ文字列に載る** ——
 * 履歴・Referer・サーバーのログに残る。応答は 200 のままである。
 *
 * ## ここでやること
 *
 * HTML から form を取り出し、**その form が言っている `action` /
 * `method` / 入力の名前だけ**を使って送る。画面を組み直したときに
 * 継ぎ目がずれたら、ここで落ちる。
 *
 * **#332 の P2（auth-worker を Kiwa UI へ）の前に入れている。** 移行と
 * 同時に足すと、「前から通っていなかった」のか「移行で壊した」のかが
 * 言えない。
 */

const BASE = "http://localhost";
const ORIGIN = "http://localhost:8787";
const REGISTERED = "taro@example.com";

const user = aUser({ email: REGISTERED, displayName: "山田 太郎", username: "taro" });
const freshIp = freshIpFactory("login-form-drive");

async function seedRegisteredUser(): Promise<void> {
  const db = createIdentityDatabase(env.IDENTITY_DB);
  await db
    .insert(users)
    .values({
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      primaryEmail: user.email,
      emailVerified: user.emailVerified,
    })
    .run();
}

async function seedOtpChallenge(email: string, code: string): Promise<void> {
  const repository = new DrizzleEmailChallengeRepository(createIdentityDatabase(env.IDENTITY_DB));
  await repository.create({
    id: newId("emc"),
    userId: null,
    email,
    codeHash: await new Sha256TokenHasher().hash(code),
    purpose: "login",
    expiresAt: new Date(Date.now() + 5 * 60 * 1000),
    maxAttempts: 5,
    sentAt: new Date(),
  });
}

const cookiePairs = (r: Response): string[] =>
  r.headers.getSetCookie().map((raw) => raw.split(";")[0] ?? "");

type Form = {
  readonly action: string;
  readonly method: string;
  /** `name` -> 既定値。利用者が埋める欄は空文字。 */
  readonly fields: Readonly<Record<string, string>>;
};

/**
 * HTML から form を 1 つ取り出す。
 *
 * **ブラウザが見るものだけを見る。** `action` が無ければ現在の URL へ、
 * `method` が無ければ GET —— どちらも既定が「黙って別のことをする」側
 * なので、**既定へ落ちたことが分かるように空文字で返す**（下の検査が
 * 落とす）。
 */
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

beforeEach(async () => {
  await resetDatabase();
  await seedRegisteredUser();
});

describe("描かれた form だけでログインを完走する", () => {
  it("GET /login の form が POST で、自分の行き先を言っている", async () => {
    const page = await SELF.fetch(`${BASE}/login`);
    const form = formIn(await page.text(), 'name="email"');

    // **`method` が消えるとブラウザは GET で送る。** OTP がクエリに載り、
    // 履歴・Referer・ログに残る。応答は 200 のままなので外からは見えない。
    expect(form.method, "method が post でない（既定の GET になる）").toBe("post");
    expect(form.action, "action が空（現在の URL へ送られる）").not.toBe("");
    // 利用者が埋める欄と、サーバーが運ぶ hidden。どちらが欠けても進めない。
    expect(Object.keys(form.fields).sort()).toContain("email");
    expect(form.fields["csrf_token"], "CSRF トークンが hidden に無い").toBeTruthy();
  });

  it("form の言うとおりに 2 回送るだけでセッションが発行される", async () => {
    // 1 段目。**パスもフィールド名も、画面から読んだものしか使わない。**
    const page = await SELF.fetch(`${BASE}/login`);
    const cookie = cookiePairs(page).join("; ");
    const emailForm = formIn(await page.text(), 'name="email"');

    const sent = await send(emailForm, { email: REGISTERED }, cookie);
    expect(sent.status, "コード入力画面へ進めない").toBe(200);

    // 2 段目。コードの form も同じ読み方で取り出す。
    await seedOtpChallenge(REGISTERED, "123456");
    const codeForm = formIn(await sent.text(), 'name="code"');

    expect(codeForm.method, "コードの form が post でない").toBe("post");
    // **メールアドレスは hidden で運ばれている。** ここが欠けると、
    // 2 段目でもう一度入力させることになる（クエリに載せるのは論外）。
    expect(codeForm.fields["email"], "メールアドレスが hidden で運ばれていない").toBe(REGISTERED);

    const verified = await send(codeForm, { code: "123456" }, cookie);

    const session = cookiePairs(verified).find((pair) =>
      pair.startsWith(`${sessionCookieName("development")}=`),
    );
    expect(session, "セッション Cookie が発行されていない").toBeDefined();

    // **OTP を URL へ載せていない。** GET へ落ちた form はここでも落ちる。
    expect(verified.headers.get("Location") ?? "").not.toContain("123456");
  });
});

import { SELF, env } from "cloudflare:test";
import { sessionCookieName } from "@u18/contracts";
import { createIdentityDatabase, users } from "@u18/db";
import { newId } from "@u18/domain";
import { aUser } from "@u18/testing";
import { beforeEach, describe, expect, it } from "vitest";
import { Sha256TokenHasher } from "../src/infrastructure/crypto/web-crypto";
import { DrizzleEmailChallengeRepository } from "../src/infrastructure/persistence/drizzle-email-challenge.repository";
import { resetDatabase } from "./helpers";

/**
 * 新規登録画面（#36 の残り / 仕様書 §6.1）。
 *
 * **API は `purpose: "signup"` を受けていたが、画面が無かった。**
 * `login.routes.tsx` が「新規登録の導線は別画面で扱う」と書いたまま、
 * その別画面が作られておらず、**UI からは誰も登録できなかった。**
 *
 * ここでしか確かめられないのは 3 つ:
 *  1. JS 無しで登録が最後まで通り、セッションが発行されること
 *  2. 応答から「そのアドレスが登録済みか」が分からないこと
 *  3. ログイン画面と相互に行き来できること
 */

const BASE = "http://localhost";
const ORIGIN = "http://localhost:8787";

/**
 * 要求ごとに違う IP を名乗る。
 *
 * **ここを共有していたせいで、このファイルは `/signup/start` の IP
 * レート制限の枠を全テストで食い合っていた。** 枠が足りているうちは
 * 誰も気づかないが、テストを 1 本足した人が無関係な 429 で落ちる。
 *
 * それとは別に、**共有していたこと自体が `rate-limit-form.test.ts` の
 * 「制限は CSRF の後ろ」という順序を偶然固定していた**（CSRF に落ちる
 * 要求が枠を食い尽くすので、順序を前へ動かすとここが 429 で落ちた）。
 * 支えとしては弱いうえ、落ちたときのメッセージが
 * `expected 429 to be 403` なので、読んだ人は順序ではなく干渉を疑う。
 * 順序そのものを見るテストを `rate-limit-form.test.ts` に置いたので、
 * こちらは本来の形に戻してよい。
 *
 * ## レンジはファイルごとに分ける
 *
 * **巡回する IP を使うファイルが同じレンジを踏むと、同じ食い合いが
 * ファイルをまたいで戻る。** しかも今度は 1 ファイルを読んでも分からない。
 * ここは `192.0.2.x`、`rate-limit-form.test.ts` は `203.0.113.x`、
 * `helpers.oauth.ts` は `198.51.100.x` を使う。固定の IP を置いている
 * ファイル（`audit-request-context` / `audit-secrets`）も `198.51.100.x`
 * なので、巡回はそこを避ける。
 */
let ipCounter = 0;
const freshIp = (): string => `192.0.2.${(ipCounter += 1) % 250}`;

const REGISTERED = "taro@example.com";
const NEW_ADDRESS = "newcomer@example.com";

const user = aUser({ email: REGISTERED, displayName: "山田 太郎", username: "taro" });

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

/** 既知のコードで signup のチャレンジを 1 件作る。 */
async function seedSignupChallenge(email: string, code: string): Promise<void> {
  const repository = new DrizzleEmailChallengeRepository(createIdentityDatabase(env.IDENTITY_DB));
  await repository.create({
    id: newId("emc"),
    userId: null,
    email,
    codeHash: await new Sha256TokenHasher().hash(code),
    purpose: "signup",
    expiresAt: new Date(Date.now() + 5 * 60 * 1000),
    maxAttempts: 5,
    sentAt: new Date(),
  });
}

function cookiePairs(response: Response): string[] {
  return response.headers.getSetCookie().map((raw) => raw.split(";")[0] ?? "");
}

function csrfTokenOf(html: string): string {
  const match = /name="csrf_token" value="([^"]+)"/.exec(html);
  if (match?.[1] === undefined) throw new Error("CSRF トークンが描画されていない");
  return match[1];
}

async function openSignupPage(): Promise<{ cookie: string; csrf: string; html: string }> {
  const response = await SELF.fetch(`${BASE}/signup`);
  const html = await response.text();
  return { cookie: cookiePairs(response).join("; "), csrf: csrfTokenOf(html), html };
}

function submit(
  path: string,
  fields: Record<string, string>,
  options: { cookie?: string; origin?: string | null; secFetchSite?: string } = {},
): Promise<Response> {
  const { cookie, origin = ORIGIN, secFetchSite } = options;
  return SELF.fetch(`${BASE}${path}`, {
    method: "POST",
    redirect: "manual",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "CF-Connecting-IP": freshIp(),
      ...(origin === null ? {} : { Origin: origin }),
      ...(secFetchSite === undefined ? {} : { "Sec-Fetch-Site": secFetchSite }),
      ...(cookie === undefined ? {} : { Cookie: cookie }),
    },
    body: new URLSearchParams(fields).toString(),
  });
}

beforeEach(resetDatabase);

describe("JS 無しで登録できる", () => {
  it("アドレス入力 → コード入力 → セッション発行", async () => {
    const page = await openSignupPage();
    expect(page.html).toContain("新規登録");

    const started = await submit(
      "/signup/start",
      { email: NEW_ADDRESS, csrf_token: page.csrf },
      { cookie: page.cookie },
    );
    expect(started.status).toBe(200);
    const codeHtml = await started.text();
    expect(codeHtml).toContain("確認コード");

    // 本物の送信経路からコードは取り出せないので、UseCase が作るのと
    // 同じ行を直接入れる（login.ui.test.ts と同じ手）。
    await seedSignupChallenge(NEW_ADDRESS, "123456");

    const verified = await submit(
      "/signup/verify",
      { email: NEW_ADDRESS, code: "123456", csrf_token: csrfTokenOf(codeHtml) },
      { cookie: page.cookie },
    );

    expect(verified.status).toBe(303);
    // 戻り先が無ければアカウント画面へ着地させる（/login ではない）。
    expect(verified.headers.get("Location")).toBe("/account");

    const issued = cookiePairs(verified).find((pair) =>
      pair.startsWith(sessionCookieName(env.ENVIRONMENT)),
    );
    expect(issued).toBeDefined();
  });

  it("アカウントが実際に作られる", async () => {
    const page = await openSignupPage();
    await submit(
      "/signup/start",
      { email: NEW_ADDRESS, csrf_token: page.csrf },
      { cookie: page.cookie },
    );
    await seedSignupChallenge(NEW_ADDRESS, "123456");
    const codeHtml = await (
      await submit(
        "/signup/start",
        { email: NEW_ADDRESS, csrf_token: page.csrf },
        { cookie: page.cookie },
      )
    ).text();
    await seedSignupChallenge(NEW_ADDRESS, "123456");

    await submit(
      "/signup/verify",
      { email: NEW_ADDRESS, code: "123456", csrf_token: csrfTokenOf(codeHtml) },
      { cookie: page.cookie },
    );

    const db = createIdentityDatabase(env.IDENTITY_DB);
    const rows = await db.select().from(users).all();
    expect(rows.some((row) => row.primaryEmail === NEW_ADDRESS)).toBe(true);
  });
});

describe("アカウントの有無を漏らさない", () => {
  it("登録済みのアドレスでも応答が変わらない", async () => {
    await seedRegisteredUser();
    const page = await openSignupPage();

    const forNew = await submit(
      "/signup/start",
      { email: NEW_ADDRESS, csrf_token: page.csrf },
      { cookie: page.cookie },
    );
    const forExisting = await submit(
      "/signup/start",
      { email: REGISTERED, csrf_token: page.csrf },
      { cookie: page.cookie },
    );

    expect(forExisting.status).toBe(forNew.status);

    // 本文の差はメールアドレスの表示だけ。そこを揃えて比較する。
    const normalize = (html: string, email: string): string => html.split(email).join("<EMAIL>");
    expect(normalize(await forExisting.text(), REGISTERED)).toBe(
      normalize(await forNew.text(), NEW_ADDRESS),
    );
  });

  it("未登録のアドレスには signup のコードを作る", async () => {
    // **`purpose` が `signup` であること自体を見る。** ここを見ないと、
    // `/signup/start` が `purpose: "login"` を渡していても気づけない
    // （未登録のアドレスなら login では送られないので、他のテストは
    // どれも素通りする）。revert 確認で実際に素通りした。
    const page = await openSignupPage();

    await submit(
      "/signup/start",
      { email: NEW_ADDRESS, csrf_token: page.csrf },
      { cookie: page.cookie },
    );

    const repository = new DrizzleEmailChallengeRepository(createIdentityDatabase(env.IDENTITY_DB));
    const active = await repository.findActive(NEW_ADDRESS, "signup", new Date());
    expect(active).not.toBeNull();
  });

  it("登録済みのアドレスにはコードを作らない", async () => {
    await seedRegisteredUser();
    const page = await openSignupPage();

    await submit(
      "/signup/start",
      { email: REGISTERED, csrf_token: page.csrf },
      { cookie: page.cookie },
    );

    // 応答は同じでも、チャレンジは作られていない（StartEmailOtpUseCase の
    // shouldSend が signup では未登録のアドレスにだけ送る）。
    const repository = new DrizzleEmailChallengeRepository(createIdentityDatabase(env.IDENTITY_DB));
    const active = await repository.findActive(REGISTERED, "signup", new Date());
    expect(active).toBeNull();
  });
});

describe("ブラウザが Origin: null を送る場合（本番で踏んだ）", () => {
  /**
   * Fetch 仕様では、referrer policy が参照元を落とすとき**ナビゲーション
   * 要求の `Origin` も `null` になる**。`secureHeaders()` の既定
   * （`no-referrer`）のままだと、自分のページから出した form 送信が
   * `Origin: null` で届く。
   *
   * **本番で JS 無しの form 経路が全滅していた**（ログイン・新規登録・
   * ログアウト）。テストが `Origin` を明示的に付けていたため気づけなかった。
   */
  it("Sec-Fetch-Site が same-origin なら通す", async () => {
    const page = await openSignupPage();
    const response = await submit(
      "/signup/start",
      { email: NEW_ADDRESS, csrf_token: page.csrf },
      { cookie: page.cookie, origin: "null", secFetchSite: "same-origin" },
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("確認コード");
  });

  it("Sec-Fetch-Site が cross-site なら拒む", async () => {
    // クロスサイトの攻撃者が送らせた form はこちらになる。
    const page = await openSignupPage();
    const response = await submit(
      "/signup/start",
      { email: NEW_ADDRESS, csrf_token: page.csrf },
      { cookie: page.cookie, origin: "null", secFetchSite: "cross-site" },
    );

    expect(response.status).toBe(403);
  });

  it("Sec-Fetch-Site が無ければ拒む（fail-closed）", async () => {
    // 送らないブラウザでは Origin 側で判定する。null のままは通さない。
    const page = await openSignupPage();
    const response = await submit(
      "/signup/start",
      { email: NEW_ADDRESS, csrf_token: page.csrf },
      { cookie: page.cookie, origin: "null" },
    );

    expect(response.status).toBe(403);
  });

  it("Sec-Fetch-Site が same-origin でもトークンが無ければ拒む", async () => {
    // Origin の救済は**二重の片方**を緩めるだけで、トークンは依然要る。
    const page = await openSignupPage();
    const response = await submit(
      "/signup/start",
      { email: NEW_ADDRESS },
      { cookie: page.cookie, origin: "null", secFetchSite: "same-origin" },
    );

    expect(response.status).toBe(403);
  });
});

describe("CSRF と Origin", () => {
  it("拒否されても登録画面のまま戻る（ログイン画面に飛ばさない）", async () => {
    // 既定を login に落とすと、**新規登録で失敗した人がログイン画面へ
    // 戻されたうえで「操作を受け付けられませんでした」と言われる。**
    // 自分が何をしようとしていたのか分からなくなり、やり直す先も変わる。
    const page = await openSignupPage();
    const response = await submit("/signup/start", { email: NEW_ADDRESS }, { cookie: page.cookie });

    expect(response.status).toBe(403);
    const html = await response.text();
    expect(html).toContain("新規登録");
    expect(html).toContain('action="/signup/start"');
    expect(html).not.toContain('action="/login/start"');
  });

  it("CSRF トークンが無いと受け付けない", async () => {
    const page = await openSignupPage();
    const response = await submit("/signup/start", { email: NEW_ADDRESS }, { cookie: page.cookie });
    expect(response.status).not.toBe(200);
  });

  it("Origin が無いと受け付けない", async () => {
    const page = await openSignupPage();
    const response = await submit(
      "/signup/start",
      { email: NEW_ADDRESS, csrf_token: page.csrf },
      { cookie: page.cookie, origin: null },
    );
    expect(response.status).not.toBe(200);
  });
});

describe("ログイン画面と行き来できる", () => {
  it("登録画面からログインへ行ける", async () => {
    const { html } = await openSignupPage();
    expect(html).toContain('href="/login"');
  });

  it("ログイン画面から登録へ行ける", async () => {
    const html = await (await SELF.fetch(`${BASE}/login`)).text();
    expect(html).toContain('href="/signup"');
  });

  it("登録画面にはパスキーの経路を出さない", async () => {
    // まだ認証器が無いので押しても失敗するだけで、失敗の文言が
    // 「このアドレスにはパスキーが無い」と読まれれば列挙の材料になる。
    const { html } = await openSignupPage();
    expect(html).not.toContain("passkey-island");
    expect(html).not.toContain("/ui/login-island.js");
  });
});

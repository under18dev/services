import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { CARDS_UI_PATH, createApp } from "../src/presentation/http/app";
import {
  ORIGIN,
  cookieFor,
  executionContext,
  identityDown,
  identityWith,
  repository,
  resetDatabase,
  seedActiveCard,
  seedIssuedCard,
} from "./helpers";

/**
 * カード一覧の画面。
 *
 * API（`cards.api.test.ts`）が「誰のカードを触れるか」を持っているので、
 * ここは**画面として成立しているか**だけを見る。
 */

const TARO = "token-taro-0123456789abcdefghijklmn";
const HANAKO = "token-hanako-0123456789abcdefghijk";
const identity = identityWith({ [TARO]: "usr_taro", [HANAKO]: "usr_hanako" });

async function open(cookie?: string, gateway = identity): Promise<Response> {
  const headers = new Headers();
  if (cookie !== undefined) headers.set("Cookie", cookie);
  return await createApp({ identity: gateway }).fetch(
    new Request(`${ORIGIN}${CARDS_UI_PATH}`, { headers }),
    env,
    executionContext(),
  );
}

beforeEach(resetDatabase);

describe("カード一覧の画面", () => {
  it("自分のカードが出る", async () => {
    const cardId = await seedActiveCard("usr_taro", "https://example.com/taro");

    const response = await open(cookieFor(TARO));
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/html");

    const html = await response.text();
    expect(html).toContain(cardId);
    expect(html).toContain("https://example.com/taro");
    expect(html).toContain("有効");
  });

  it("他人のカードは出ない", async () => {
    const cardId = await seedActiveCard("usr_taro", "https://example.com/taro");

    const html = await (await open(cookieFor(HANAKO))).text();
    expect(html).not.toContain(cardId);
    expect(html).not.toContain("https://example.com/taro");
  });

  it("1 枚も無ければその旨が出る（空の一覧を黙って返さない）", async () => {
    const html = await (await open(cookieFor(TARO))).text();
    expect(html).toContain("紐づけコード");
  });

  it("未紐づけのカードは所有者が居ないので出ない", async () => {
    const { cardId } = await seedIssuedCard();

    const html = await (await open(cookieFor(TARO))).text();
    expect(html).not.toContain(cardId);
  });

  it("未ログインはログイン画面へ送る（JSON を見せない）", async () => {
    const response = await open();
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toMatch(/^\/login\?/);
  });

  it("ログイン後にこの画面へ戻れるよう戻り先を載せる", async () => {
    // 素の /login へ送ると、ログインしたあと利用者が自分でここまで
    // 辿り直すことになる。
    const response = await open();
    const location = response.headers.get("Location") ?? "";
    const returnTo = new URL(location, ORIGIN).searchParams.get("return_to");
    expect(returnTo).toBe(CARDS_UI_PATH);
  });

  it("auth-worker が落ちているときはログインへ送らない", async () => {
    // ログインも同じ Worker が受けているので、送ると利用者が
    // 延々とログインし直す羽目になる。
    const response = await open(cookieFor(TARO), identityDown);
    expect(response.status).toBe(503);
  });

  it("遷移先をリンクにしない（この画面を踏み台にさせない）", async () => {
    await seedActiveCard("usr_taro", "https://evil.example/landing");

    const html = await (await open(cookieFor(TARO))).text();
    expect(html).toContain("https://evil.example/landing");
    // `href` に入っていないこと。入ると一覧を開いた人が 1 クリックで飛べる。
    expect(html).not.toContain('href="https://evil.example/landing"');
  });

  it("共有キャッシュに載せない", async () => {
    await seedActiveCard("usr_taro", "https://example.com/taro");

    const response = await open(cookieFor(TARO));
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("CSP が掛かっている（インラインを許さない）", async () => {
    await seedActiveCard("usr_taro", "https://example.com/taro");

    const csp = (await open(cookieFor(TARO))).headers.get("Content-Security-Policy");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("default-src 'none'");
  });

  it("JS を 1 つも要求しない", async () => {
    await seedActiveCard("usr_taro", "https://example.com/taro");

    const html = await (await open(cookieFor(TARO))).text();
    expect(html).not.toContain("<script");
  });

  it("無効化済みのカードも所有者には見える", async () => {
    const cardId = await seedActiveCard("usr_taro", "https://example.com/taro");
    await repository().disable(cardId, "usr_taro", "紛失", new Date());

    const html = await (await open(cookieFor(TARO))).text();
    expect(html).toContain(cardId);
    expect(html).toContain("無効化済み");
    expect(html).toContain("紛失");
  });
});

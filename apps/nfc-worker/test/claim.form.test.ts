import { CSRF_FIELD_NAME } from "@u18/web-ui";
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/presentation/http/app";
import { CARDS_UI_PATH, CLAIM_UI_PATH } from "../src/presentation/http/base-path";
import {
  ORIGIN,
  cookieFor,
  executionContext,
  identityWith,
  repository,
  resetDatabase,
  seedActiveCard,
  seedIssuedCard,
} from "./helpers";

/**
 * カードをタップした人が通る紐づけの導線（#358）。
 *
 * ## ここが見ているもの
 *
 * `cards.api.test.ts` は JSON API 側の `POST /cards/claim` を持っている。
 * **こちらは利用者が実際に通る経路**で、`route-reachability.test.ts` が
 * 走査する島には現れない（form だから）。**入口があることを言える検査は
 * これしか無い。**
 *
 * ## JavaScript を要求しないこと
 *
 * 送るのは `FormData` である。`fetch` も `Content-Type: application/json` も
 * 使わない —— **素の form 送信と同じ形で通ることを見ている。**
 */

const TARO = "token-taro-0123456789abcdefghijklmn";
const HANAKO = "token-hanako-0123456789abcdefghijk";
const identity = identityWith({ [TARO]: "usr_taro", [HANAKO]: "usr_hanako" });

const DEV_CSRF_COOKIE = "u18_csrf";

function app() {
  return createApp({ identity });
}

async function openClaim(cardId: string, cookie?: string): Promise<Response> {
  const headers = new Headers();
  if (cookie !== undefined) headers.set("Cookie", cookie);
  return await app().fetch(
    new Request(`${ORIGIN}${CLAIM_UI_PATH}?card=${encodeURIComponent(cardId)}`, { headers }),
    env,
    executionContext(),
  );
}

/** 画面が返した CSRF トークンと Cookie を取り出す。 */
function csrfFrom(response: Response, html: string): { token: string; cookie: string } {
  const token = /name="csrf_token" value="([^"]*)"/.exec(html)?.[1] ?? "";
  const cookie = /u18_csrf=([^;]+)/.exec(response.headers.get("Set-Cookie") ?? "")?.[1] ?? "";
  return { token, cookie };
}

/**
 * **`| undefined` を明示している**のは `exactOptionalPropertyTypes` のため。
 * 下の `it.each` が「トークンが無い」を `csrfToken: undefined` で表すので、
 * `?:` だけだと渡せない。**省略と明示的な undefined を同じものとして扱う。**
 */
async function submitClaim(options: {
  readonly cardId: string;
  readonly sessionCookie?: string | undefined;
  readonly csrfCookie?: string | undefined;
  readonly csrfToken?: string | undefined;
  readonly origin?: string | null | undefined;
}): Promise<Response> {
  const body = new FormData();
  body.set("cardId", options.cardId);
  if (options.csrfToken !== undefined) body.set(CSRF_FIELD_NAME, options.csrfToken);

  const headers = new Headers();
  const cookies = [
    options.sessionCookie,
    options.csrfCookie ? `${DEV_CSRF_COOKIE}=${options.csrfCookie}` : undefined,
  ]
    .filter((value): value is string => value !== undefined)
    .join("; ");
  if (cookies !== "") headers.set("Cookie", cookies);
  const origin = options.origin === undefined ? ORIGIN : options.origin;
  if (origin !== null) headers.set("Origin", origin);

  return await app().fetch(
    new Request(`${ORIGIN}${CLAIM_UI_PATH}`, { method: "POST", headers, body }),
    env,
    executionContext(),
  );
}

/** ログイン済みで画面を開き、そこから押せる状態一式を得る。 */
async function openAndPrepare(cardId: string, sessionCookie: string) {
  const response = await openClaim(cardId, sessionCookie);
  const html = await response.text();
  const { token, cookie } = csrfFrom(response, html);
  return { response, html, csrfToken: token, csrfCookie: cookie };
}

beforeEach(resetDatabase);

describe("紐づけ画面を開く", () => {
  it("未紐づけのカードなら、押せる form が出る", async () => {
    const cardId = await seedIssuedCard();

    const { response, html } = await openAndPrepare(cardId, cookieFor(TARO));

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/html");
    // 押す前に「どのカードか」が分かること。手元のカードと違うものを
    // 紐づけても気づけない形にしない。
    expect(html).toContain(cardId);
    expect(html).toContain(`<form method="post" action="${CLAIM_UI_PATH}"`);
  });

  it("JavaScript を要求しない", async () => {
    // **この画面はアイランドを読み込まない。** タップした人が最初に通る
    // 経路で、アカウントがまだ無い人が通る（`http/csrf.ts` の冒頭）。
    const cardId = await seedIssuedCard();

    const { html } = await openAndPrepare(cardId, cookieFor(TARO));

    expect(html).not.toContain("<script");
    // 素の form 送信で完結する: method と action と submit が揃っている。
    expect(html).toContain('method="post"');
    expect(html).toContain('type="submit"');
  });

  it("未ログインなら、カードを引かずにログインへ送る", async () => {
    const cardId = await seedIssuedCard();

    const response = await openClaim(cardId);

    expect(response.status).toBe(302);
    const location = response.headers.get("Location") ?? "";
    expect(location).toContain("/login?return_to=");
    // 戻り先にカード ID が載っていること。載っていないと、ログイン後に
    // どのカードを登録しようとしていたのかが失われる。
    expect(decodeURIComponent(location)).toContain(`${CLAIM_UI_PATH}?card=${cardId}`);
  });

  it("戻り先が auth-worker の許可リストを素通りする形である", async () => {
    // `sanitizeReturnTo` は `/account` 接頭辞だけを通す。**新しい許可を
    // 足さずに済ませている**ことを、ここで固定する（#358）。
    const cardId = await seedIssuedCard();

    const location = (await openClaim(cardId)).headers.get("Location") ?? "";
    const returnTo = new URL(location, ORIGIN).searchParams.get("return_to") ?? "";

    expect(returnTo.startsWith("/account/")).toBe(true);
  });

  it.each([
    ["他人のカード", async () => await seedActiveCard("usr_hanako", "https://example.com/h")],
    [
      "無効化済みのカード",
      async () => {
        const cardId = await seedActiveCard("usr_hanako");
        await repository().disable(cardId, "usr_hanako", "lost", new Date());
        return cardId;
      },
    ],
    ["存在しないカード", async () => "nfc_doesnotexisthere12"],
    ["形が不正なカード ID", async () => "NOT-A-CARD-ID"],
  ])("%s は、どれも 1 バイト変わらない同じ画面になる", async (_label, make) => {
    // **区別すると、カード ID を総当たりする相手に「その ID は実在する」と
    // 教える。** `disabled` を `issued` と一緒に緩めないのもここで効く。
    const baseline = await openClaim("nfc_baselinedoesnotexist", cookieFor(TARO));
    const baselineHtml = await baseline.text();

    const response = await openClaim(await make(), cookieFor(TARO));

    expect(response.status).toBe(baseline.status);
    expect(await response.text()).toBe(baselineHtml);
  });

  it("畳んだ側では CSRF の Cookie を発行しない", async () => {
    // 存在しないカードを叩いた相手に Cookie が増えないこと。
    const concealed = await openClaim("nfc_doesnotexisthere12", cookieFor(TARO));
    expect(concealed.headers.get("Set-Cookie")).toBeNull();

    const claimable = await openClaim(await seedIssuedCard(), cookieFor(TARO));
    expect(claimable.headers.get("Set-Cookie")).toContain(DEV_CSRF_COOKIE);
  });

  it("キャッシュさせない", async () => {
    const response = await openClaim(await seedIssuedCard(), cookieFor(TARO));
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });
});

describe("紐づけを実行する", () => {
  it("押すと自分のものになり、一覧へ送られる", async () => {
    const cardId = await seedIssuedCard();
    const { csrfToken, csrfCookie } = await openAndPrepare(cardId, cookieFor(TARO));

    const response = await submitClaim({
      cardId,
      sessionCookie: cookieFor(TARO),
      csrfCookie,
      csrfToken,
    });

    // **303 で送る（PRG）。** 200 を返すと、再読み込みで同じ POST が飛び、
    // 2 回目は必ず失敗するので利用者には「失敗した」と見える。
    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe(CARDS_UI_PATH);
    expect((await repository().findById(cardId))?.ownerUserId).toBe("usr_taro");
  });

  it("2 人目は奪えない", async () => {
    const cardId = await seedIssuedCard();
    const taro = await openAndPrepare(cardId, cookieFor(TARO));
    const hanako = await openAndPrepare(cardId, cookieFor(HANAKO));

    expect(
      (
        await submitClaim({
          cardId,
          sessionCookie: cookieFor(TARO),
          csrfCookie: taro.csrfCookie,
          csrfToken: taro.csrfToken,
        })
      ).status,
    ).toBe(303);

    const second = await submitClaim({
      cardId,
      sessionCookie: cookieFor(HANAKO),
      csrfCookie: hanako.csrfCookie,
      csrfToken: hanako.csrfToken,
    });

    expect(second.status).toBe(400);
    expect((await repository().findById(cardId))?.ownerUserId).toBe("usr_taro");
  });

  it.each([
    ["トークンが無い", { csrfToken: undefined, csrfCookie: "aaaaaaaaaaaaaaaa" }],
    ["Cookie が無い", { csrfToken: "aaaaaaaaaaaaaaaa", csrfCookie: undefined }],
    ["値が食い違う", { csrfToken: "aaaaaaaaaaaaaaaa", csrfCookie: "bbbbbbbbbbbbbbbb" }],
  ])("CSRF: %s なら紐づけられない", async (_label, csrf) => {
    const cardId = await seedIssuedCard();

    const response = await submitClaim({ cardId, sessionCookie: cookieFor(TARO), ...csrf });

    expect(response.status).toBe(400);
    expect((await repository().findById(cardId))?.ownerUserId).toBeNull();
  });

  it("別オリジンからの送信は通らない", async () => {
    const cardId = await seedIssuedCard();
    const { csrfToken, csrfCookie } = await openAndPrepare(cardId, cookieFor(TARO));

    const response = await submitClaim({
      cardId,
      sessionCookie: cookieFor(TARO),
      csrfCookie,
      csrfToken,
      origin: "https://evil.example",
    });

    expect(response.status).toBe(400);
    expect((await repository().findById(cardId))?.ownerUserId).toBeNull();
  });

  it("未ログインなら、カード ID を保ったままログインへ送る", async () => {
    // **CSRF は通るが、セッションが無い場合。** 戻り先が POST の URL だと、
    // ログイン直後にカード ID を失った画面へ着地する。
    const cardId = await seedIssuedCard();
    const { csrfToken, csrfCookie } = await openAndPrepare(cardId, cookieFor(TARO));

    const response = await submitClaim({ cardId, csrfCookie, csrfToken });

    expect(response.status).toBe(302);
    expect(decodeURIComponent(response.headers.get("Location") ?? "")).toContain(
      `${CLAIM_UI_PATH}?card=${cardId}`,
    );
  });

  it("失敗しても理由を画面に書かない", async () => {
    // 「トークンが古い」「そのカードは他人のもの」を出し分けると、
    // 攻撃者に何を直せばよいか教えることになる。理由はログにだけ出る。
    const taken = await seedActiveCard("usr_hanako");
    const { csrfToken, csrfCookie } = await openAndPrepare(await seedIssuedCard(), cookieFor(TARO));

    const rejected = await submitClaim({
      cardId: taken,
      sessionCookie: cookieFor(TARO),
      csrfCookie,
      csrfToken,
    });
    const badCsrf = await submitClaim({ cardId: taken, sessionCookie: cookieFor(TARO) });

    expect(rejected.status).toBe(badCsrf.status);
    expect(await rejected.text()).toBe(await badCsrf.text());
  });
});

import { DEV_SESSION_COOKIE_NAME, SESSION_COOKIE_NAME } from "@u18/contracts";
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { IdentityGateway } from "../src/application/ports";
import { CARDS_BASE_PATH, createApp } from "../src/presentation/http/app";
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
 * カード管理 API（#31）。
 *
 * この Worker の責務は「セッション Cookie を読み、auth-worker に
 * 持ち主を聞き、自分のカードだけを触らせる」こと。
 * セッションの検証そのものは auth-worker のテストが持っている。
 */

const TARO = "token-taro-0123456789abcdefghijklmn";
const HANAKO = "token-hanako-0123456789abcdefghijk";

const identity = identityWith({ [TARO]: "usr_taro", [HANAKO]: "usr_hanako" });

type Options = {
  readonly method?: string;
  readonly cookie?: string;
  readonly origin?: string | null;
  readonly contentType?: string | null;
  readonly body?: unknown;
  readonly gateway?: IdentityGateway;
};

async function call(path: string, options: Options = {}): Promise<Response> {
  const headers = new Headers();
  if (options.cookie !== undefined) headers.set("Cookie", options.cookie);
  if (options.origin !== null) headers.set("Origin", options.origin ?? ORIGIN);
  if (options.contentType !== null) {
    headers.set("Content-Type", options.contentType ?? "application/json");
  }

  const init: RequestInit = { method: options.method ?? "GET", headers };
  if (options.body !== undefined) init.body = JSON.stringify(options.body);

  return await createApp({ identity: options.gateway ?? identity }).fetch(
    new Request(`${ORIGIN}${CARDS_BASE_PATH}${path}`, init),
    env,
    executionContext(),
  );
}

beforeEach(resetDatabase);

describe("他人のカード設定を変更できない（#31 の完了条件）", () => {
  it("他人のカードの遷移先を変更できない", async () => {
    const cardId = await seedActiveCard("usr_taro", "https://example.com/taro");

    const response = await call(`/${cardId}/target`, {
      method: "PUT",
      cookie: cookieFor(HANAKO),
      body: { targetUrl: "https://evil.example/" },
    });

    // 403 ではなく 404。403 は「存在するが権限が無い」と読めるので、
    // 他人のカード ID を当てたことが相手に伝わる。
    expect(response.status).toBe(404);

    // 実際に書き換わっていないことを DB で確かめる。
    const card = await repository().findById(cardId);
    expect(card?.targetUrl).toBe("https://example.com/taro");
  });

  it("他人のカードを無効化できない", async () => {
    const cardId = await seedActiveCard("usr_taro");

    const response = await call(`/${cardId}/disable`, {
      method: "POST",
      cookie: cookieFor(HANAKO),
      body: { reason: "lost" },
    });

    expect(response.status).toBe(404);
    expect((await repository().findById(cardId))?.isDisabled).toBe(false);
  });

  it("他人のカードを手放せない", async () => {
    const cardId = await seedActiveCard("usr_taro");

    const response = await call(`/${cardId}/release`, {
      method: "POST",
      cookie: cookieFor(HANAKO),
    });

    expect(response.status).toBe(404);
    expect((await repository().findById(cardId))?.ownerUserId).toBe("usr_taro");
  });

  it("一覧に他人のカードが混ざらない", async () => {
    await seedActiveCard("usr_taro", "https://example.com/taro");
    await seedActiveCard("usr_hanako", "https://example.com/hanako");

    const response = await call("/", { cookie: cookieFor(HANAKO) });
    const body = (await response.json()) as { cards: { targetUrl: string }[] };

    expect(body.cards).toHaveLength(1);
    expect(body.cards[0]?.targetUrl).toBe("https://example.com/hanako");
  });

  it("リクエストに userId を書いても無視される", async () => {
    // 操作者はセッションからしか決まらない（仕様書 4.2）。
    const cardId = await seedActiveCard("usr_taro", "https://example.com/taro");

    const response = await call(`/${cardId}/target`, {
      method: "PUT",
      cookie: cookieFor(HANAKO),
      body: { targetUrl: "https://evil.example/", userId: "usr_taro", ownerUserId: "usr_taro" },
    });

    expect(response.status).toBe(404);
    expect((await repository().findById(cardId))?.targetUrl).toBe("https://example.com/taro");
  });
});

describe("自分のカードは変更できる", () => {
  it("遷移先を変更できる", async () => {
    const cardId = await seedActiveCard("usr_taro", "https://example.com/before");

    const response = await call(`/${cardId}/target`, {
      method: "PUT",
      cookie: cookieFor(TARO),
      body: { targetUrl: "https://example.com/after" },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      cardId,
      status: "active",
      targetUrl: "https://example.com/after",
    });
  });

  it("無効化できる（二度押しても成功する）", async () => {
    const cardId = await seedActiveCard("usr_taro");

    const first = await call(`/${cardId}/disable`, {
      method: "POST",
      cookie: cookieFor(TARO),
      body: { reason: "lost" },
    });
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ status: "disabled", disabledReason: "lost" });

    // 紛失の報告は慌てて二度押されるもの。2 回目を失敗にすると
    // 「止まらなかった」と誤解される。
    const second = await call(`/${cardId}/disable`, {
      method: "POST",
      cookie: cookieFor(TARO),
      body: { reason: "lost" },
    });
    expect(second.status).toBe(200);
  });

  it("無効化したカードは所有者でも書き換えられない", async () => {
    const cardId = await seedActiveCard("usr_taro");
    await call(`/${cardId}/disable`, {
      method: "POST",
      cookie: cookieFor(TARO),
      body: { reason: "lost" },
    });

    const response = await call(`/${cardId}/target`, {
      method: "PUT",
      cookie: cookieFor(TARO),
      body: { targetUrl: "https://example.com/after" },
    });

    expect(response.status).toBe(404);
  });

  it("無効化しても一覧には残る", async () => {
    // 所有者本人には「自分が無効化した」ことが見えないと、
    // 紛失報告のあとで状態を確かめる手段が無くなる。
    const cardId = await seedActiveCard("usr_taro");
    await call(`/${cardId}/disable`, {
      method: "POST",
      cookie: cookieFor(TARO),
      body: { reason: "lost" },
    });

    const response = await call("/", { cookie: cookieFor(TARO) });
    const body = (await response.json()) as { cards: { status: string }[] };

    expect(body.cards).toHaveLength(1);
    expect(body.cards[0]?.status).toBe("disabled");
  });
});

describe("https: 以外のリダイレクト先を受け付けない", () => {
  it.each([
    "http://example.com/",
    "javascript:alert(1)",
    "data:text/html,x",
    "https://evil.example@phish.example/",
    "https://192.168.0.1/",
    "https://auth.under18.dev/oauth/authorize",
  ])("%s を 400 で拒否する", async (targetUrl) => {
    const cardId = await seedActiveCard("usr_taro", "https://example.com/before");

    const response = await call(`/${cardId}/target`, {
      method: "PUT",
      cookie: cookieFor(TARO),
      body: { targetUrl },
    });

    expect(response.status).toBe(400);
    expect((await repository().findById(cardId))?.targetUrl).toBe("https://example.com/before");
  });

  it("拒否の理由は所有者本人にだけ返す", async () => {
    const cardId = await seedActiveCard("usr_taro");

    const response = await call(`/${cardId}/target`, {
      method: "PUT",
      cookie: cookieFor(TARO),
      body: { targetUrl: "http://example.com/" },
    });

    expect(await response.json()).toEqual({ error: "invalid_target_url", reason: "not_https" });
  });

  it("他人のカードには URL の妥当性を教えない", async () => {
    // 認可を URL 検証より先に行う。順序が逆だと、「URL は妥当だが
    // カードが無い」と「URL が不正」の応答差がカードの実在を測る物差しになる。
    const cardId = await seedActiveCard("usr_taro");

    const invalid = await call(`/${cardId}/target`, {
      method: "PUT",
      cookie: cookieFor(HANAKO),
      body: { targetUrl: "javascript:alert(1)" },
    });
    const valid = await call(`/${cardId}/target`, {
      method: "PUT",
      cookie: cookieFor(HANAKO),
      body: { targetUrl: "https://example.com/" },
    });

    expect(invalid.status).toBe(valid.status);
    expect(await invalid.json()).toEqual(await valid.json());
  });
});

describe("認証とセッション", () => {
  it("Cookie が無ければ 401", async () => {
    const response = await call("/");
    expect(response.status).toBe(401);
  });

  it("未知のセッショントークンは 401", async () => {
    const response = await call("/", { cookie: cookieFor("unknown-token-value-0123456789") });
    expect(response.status).toBe(401);
  });

  it("development では接頭辞なしの Cookie を読む", async () => {
    const response = await call("/", { cookie: `${DEV_SESSION_COOKIE_NAME}=${TARO}` });
    expect(response.status).toBe(200);
  });

  it("development で __Host- 付きの Cookie は読まない", async () => {
    // Cookie 名は契約（packages/contracts/src/session-cookie.ts）。
    // ここをハードコードすると本番で永久に読めない事故になる。
    const response = await call("/", { cookie: `${SESSION_COOKIE_NAME}=${TARO}` });
    expect(response.status).toBe(401);
  });

  it("auth-worker が落ちていれば 503（401 にしない）", async () => {
    // 「Identity が落ちている」と「セッションが無効」はユーザーへの
    // 見せ方が違う。503 を 401 に畳むと、障害のたびに全員が
    // 再ログインへ誘導される。
    const response = await call("/", { cookie: cookieFor(TARO), gateway: identityDown });
    expect(response.status).toBe(503);
  });

  it("auth-worker 側のメッセージを応答に載せない", async () => {
    const response = await call("/", { cookie: cookieFor(TARO), gateway: identityDown });
    expect(await response.text()).not.toContain("boom");
  });
});

describe("状態を変える操作の CSRF 対策", () => {
  it("Origin が無ければ拒否する", async () => {
    const cardId = await seedActiveCard("usr_taro");

    const response = await call(`/${cardId}/target`, {
      method: "PUT",
      cookie: cookieFor(TARO),
      origin: null,
      body: { targetUrl: "https://example.com/x" },
    });

    expect(response.status).toBe(403);
  });

  it("別オリジンからは拒否する", async () => {
    const cardId = await seedActiveCard("usr_taro");

    const response = await call(`/${cardId}/target`, {
      method: "PUT",
      cookie: cookieFor(TARO),
      origin: "https://evil.example",
      body: { targetUrl: "https://example.com/x" },
    });

    expect(response.status).toBe(403);
  });

  it("form から送れる Content-Type を拒否する", async () => {
    // クロスオリジンの <form> が送れるのは urlencoded / multipart / text-plain。
    // application/json を要求すると、到達するには preflight が要る。
    const cardId = await seedActiveCard("usr_taro");

    const response = await call(`/${cardId}/disable`, {
      method: "POST",
      cookie: cookieFor(TARO),
      contentType: "application/x-www-form-urlencoded",
      body: { reason: "lost" },
    });

    expect(response.status).toBe(403);
  });

  it("GET には Origin 検証を課さない", async () => {
    const response = await call("/", { cookie: cookieFor(TARO), origin: null });
    expect(response.status).toBe(200);
  });
});

describe("紐づけ（#358: タップした人のものになる）", () => {
  it("カード ID を知っていれば、未紐づけのカードは自分のものになる", async () => {
    // **撤回した決定の裏返しである。** 以前はここに「カード ID を
    // 知っているだけでは紐づけられない」という検査があった。
    const cardId = await seedIssuedCard();

    const response = await call("/claim", {
      method: "POST",
      cookie: cookieFor(TARO),
      body: { cardId },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ cardId, status: "active" });
    expect((await repository().findById(cardId))?.ownerUserId).toBe("usr_taro");
  });

  it("ログインしていなければ紐づけられない", async () => {
    // **#358 が撤回していない側。** タグはログインの資格情報ではない。
    const cardId = await seedIssuedCard();

    const response = await call("/claim", { method: "POST", body: { cardId } });

    expect(response.status).toBe(401);
    expect((await repository().findById(cardId))?.ownerUserId).toBeNull();
  });

  it("2 人目は奪えない", async () => {
    const cardId = await seedIssuedCard();

    const first = await call("/claim", {
      method: "POST",
      cookie: cookieFor(TARO),
      body: { cardId },
    });
    expect(first.status).toBe(200);

    const second = await call("/claim", {
      method: "POST",
      cookie: cookieFor(HANAKO),
      body: { cardId },
    });
    expect(second.status).toBe(400);
    expect((await repository().findById(cardId))?.ownerUserId).toBe("usr_taro");
  });

  it("無効化されたカードは紐づけられない", async () => {
    // **紛失対策の本体。** 拾った人がタップして自分のものにできてはならない。
    const cardId = await seedActiveCard("usr_taro");
    await call(`/${cardId}/disable`, {
      method: "POST",
      cookie: cookieFor(TARO),
      body: { reason: "lost" },
    });

    const response = await call("/claim", {
      method: "POST",
      cookie: cookieFor(HANAKO),
      body: { cardId },
    });

    expect(response.status).toBe(400);
    expect((await repository().findById(cardId))?.ownerUserId).toBe("usr_taro");
  });

  it.each([
    ["存在しないカード", "nfc_doesnotexisthere0"],
    ["形が不正なカード ID", "NOT-A-CARD-ID"],
  ])("%s の応答が、他人のカードと 1 バイトも変わらない", async (_label, cardId) => {
    // 区別すると、総当たりしている相手に「その ID は実在する」と教える。
    const taken = await seedActiveCard("usr_taro");

    const takenResponse = await call("/claim", {
      method: "POST",
      cookie: cookieFor(HANAKO),
      body: { cardId: taken },
    });
    const otherResponse = await call("/claim", {
      method: "POST",
      cookie: cookieFor(HANAKO),
      body: { cardId },
    });

    expect(otherResponse.status).toBe(takenResponse.status);
    expect(await otherResponse.text()).toBe(await takenResponse.text());
  });
});

describe("所有権の移転", () => {
  it("手放すと未紐づけへ戻り、次にタップした人が紐づけられる", async () => {
    const cardId = await seedActiveCard("usr_taro", "https://example.com/taro");

    const released = await call(`/${cardId}/release`, {
      method: "POST",
      cookie: cookieFor(TARO),
    });
    expect(released.status).toBe(200);
    // **#358 で「1 回しか返らない文字列」が無くなった。**
    expect(await released.json()).toMatchObject({ cardId, status: "issued" });

    // 前の所有者の遷移先は消えている。次の所有者のカードが、
    // 本人の知らない URL を配信している状態から始まらないため。
    expect((await repository().findById(cardId))?.targetUrl).toBeNull();

    const claimed = await call("/claim", {
      method: "POST",
      cookie: cookieFor(HANAKO),
      body: { cardId },
    });
    expect(claimed.status).toBe(200);

    const card = await repository().findById(cardId);
    expect(card?.ownerUserId).toBe("usr_hanako");
    expect(card?.transferCount).toBe(1);
  });

  it("手放したあと、前の所有者は変更できない", async () => {
    const cardId = await seedActiveCard("usr_taro");
    await call(`/${cardId}/release`, { method: "POST", cookie: cookieFor(TARO) });

    const response = await call(`/${cardId}/target`, {
      method: "PUT",
      cookie: cookieFor(TARO),
      body: { targetUrl: "https://example.com/again" },
    });

    expect(response.status).toBe(404);
  });

  it("所有者固有の応答をキャッシュさせない", async () => {
    const cardId = await seedActiveCard("usr_taro");

    const response = await call(`/${cardId}/release`, {
      method: "POST",
      cookie: cookieFor(TARO),
    });

    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("無効化されたカードは手放せない", async () => {
    // 手放せると、紛失して止めたカードが再び紐づけ可能な状態へ戻る。
    const cardId = await seedActiveCard("usr_taro");
    await call(`/${cardId}/disable`, {
      method: "POST",
      cookie: cookieFor(TARO),
      body: { reason: "lost" },
    });

    const response = await call(`/${cardId}/release`, {
      method: "POST",
      cookie: cookieFor(TARO),
    });

    expect(response.status).toBe(404);
  });
});

describe("カード ID から所有者を推測できない", () => {
  it("カード ID に userId が含まれない", async () => {
    // 仕様書 10「カードIDはユーザーIDとは独立し、十分なエントロピーを持つ
    // ランダム識別子」。タグを読んだ人が所有者の sub を得られてはならない。
    const cardId = await seedActiveCard("usr_taro");
    expect(cardId).not.toContain("taro");
    expect(cardId).toMatch(/^nfc_[0-9a-hjkmnp-tv-z]{20}$/);
  });

  it("2 枚のカード ID が連続しない", async () => {
    const a = await seedActiveCard("usr_taro");
    const b = await seedActiveCard("usr_taro");
    expect(a).not.toBe(b);
    // 乱数由来なので共通接頭辞は "nfc_" だけのはず。
    expect(a.slice(4, 8)).not.toBe(b.slice(4, 8));
  });

  it("一覧の応答が、CardView の項目だけを返す", async () => {
    // **以前ここは `claimCodeHash` が出ていないことを見ていた。**
    // #358 であの列ごと消えたので、**その検査は何があっても緑になる** ——
    // 空振りに気づけない形なので、意図（Entity をそのまま返さない）を
    // 項目の集合として固定し直した。`toCardView` に 1 行書くまで
    // 新しい列は外へ出ない（`card-view.ts`）。
    await seedActiveCard("usr_taro");

    const response = await call("/", { cookie: cookieFor(TARO) });
    const body = (await response.json()) as { cards: Record<string, unknown>[] };

    expect(Object.keys(body.cards[0]!).sort()).toEqual([
      "cardId",
      "claimedAt",
      "disabledAt",
      "disabledReason",
      "status",
      "targetUrl",
      "transferCount",
    ]);
    // 所有者は一覧にも出さない。自分のカードしか返らないので要らない。
    expect(JSON.stringify(body)).not.toContain("ownerUserId");
  });
});

describe("/health", () => {
  it("Identity にも D1 にも触れずに応答する", async () => {
    const response = await createApp({ identity }).fetch(
      new Request(`${ORIGIN}/health`),
      env,
      executionContext(),
    );

    expect(response.status).toBe(200);
    // **`toMatchObject` ではなく `toEqual`。** 部分一致だと、構成情報を
    // 足しても緑のままになる —— 実際 `environment` が長らく入っていて、
    // この検査は何も言わなかった（RR-18）。
    expect(await response.json()).toEqual({ status: "ok", service: "u18-nfc" });
  });

  it("構成情報を含めない（RR-18）", async () => {
    const response = await createApp({ identity }).fetch(
      new Request(`${ORIGIN}/health`),
      env,
      executionContext(),
    );

    // **未認証で叩ける**（`go.under18.dev/health` が 200。#280）ので、
    // ここに置いたものは全部公開である。
    const body = (await response.json()) as Record<string, unknown>;
    for (const key of ["environment", "issuer", "version"]) {
      expect(Object.keys(body), `${key} が公開されている`).not.toContain(key);
    }
  });
});

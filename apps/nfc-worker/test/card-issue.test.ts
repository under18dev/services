import { nfcCardEvents, nfcCards } from "@u18/nfc-db";
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { MAX_ISSUE_COUNT } from "../src/application/use-cases/issue-cards.use-case";
import { CARDS_BASE_PATH, createApp } from "../src/presentation/http/app";
import { ORIGIN, cookieFor, db, executionContext, identityWith, resetDatabase } from "./helpers";

/**
 * 運営によるカード発行（#187、仕様書 §10 / §12）。
 *
 * **「実装を見れば管理者チェックがある」では足りない。** 経路として
 * 踏んで拒まれることを確かめる —— このリポジトリで繰り返している
 * 壊れ方が「実装は正しいが、その実装を呼ぶ経路が迂回される」なので、
 * 入口から入って落ちるところまでを固定する。
 */

const ADMIN = "token-admin-0123456789abcdefghijk";
const MEMBER = "token-member-0123456789abcdefghi";

/** `usr_admin` だけが管理者。既定で全員一般利用者になる fake。 */
const identity = identityWith({ [ADMIN]: "usr_admin", [MEMBER]: "usr_member" }, ["usr_admin"]);

async function issue(cookie: string | undefined, body: unknown = { count: 1 }): Promise<Response> {
  const headers = new Headers({ Origin: ORIGIN, "Content-Type": "application/json" });
  if (cookie !== undefined) headers.set("Cookie", cookie);

  return await createApp({ identity }).fetch(
    new Request(`${ORIGIN}${CARDS_BASE_PATH}/`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }),
    env,
    executionContext(),
  );
}

beforeEach(resetDatabase);

describe("管理者だけが発行できる（#187 の受け入れ条件）", () => {
  it("一般利用者が叩くと 403 で、1 枚も作られない", async () => {
    // **経路として踏む。** UseCase を直接呼ぶテストだと、ルートが
    // 認可を迂回していても通ってしまう。
    const response = await issue(cookieFor(MEMBER));

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "forbidden" });
    expect(await db().select().from(nfcCards).all()).toHaveLength(0);
  });

  it("ログインしていなければ 401", async () => {
    const response = await issue(undefined);

    expect(response.status).toBe(401);
    expect(await db().select().from(nfcCards).all()).toHaveLength(0);
  });

  it("管理者なら発行できる", async () => {
    const response = await issue(cookieFor(ADMIN), { count: 2, batch: "bunkasai-2026" });

    expect(response.status).toBe(201);
    const body = (await response.json()) as { cards: { cardId: string }[] };
    expect(body.cards).toHaveLength(2);

    const rows = await db().select().from(nfcCards).all();
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.status === "issued")).toBe(true);
    expect(rows.every((row) => row.batch === "bunkasai-2026")).toBe(true);
  });

  it("403 の理由を card_not_found に畳まない", async () => {
    // 畳むと、権限を外された運営者が「壊れている」と誤解する。
    // カード ID の列挙とは違い、発行経路の存在は秘密ではない。
    const response = await issue(cookieFor(MEMBER));

    expect(await response.text()).not.toContain("card_not_found");
  });
});

describe("発行されるカード ID", () => {
  it("文書が言う 100 ビットで作る", async () => {
    // **#358 で、ここが 80 ビットだったことが分かった。** 本番は
    // `newId("nfc")`（既定の 16 バイト）を呼んでおり、スキーマ・README・
    // 脅威モデルが揃って言う「100bit 相当」から静かにずれていた。
    //
    // 長さを `newCardId()` 1 箇所に寄せたので、ここが見ているのは
    // 「本番の経路がその 1 箇所を通っているか」である。
    const response = await issue(cookieFor(ADMIN), { count: 1 });
    const body = (await response.json()) as { cards: { cardId: string }[] };

    // `nfc_` + 20 文字。1 文字 5 ビット（32 文字集合、256 % 32 == 0 なので
    // 偏りなし）で 100 ビット。
    expect(body.cards[0]!.cardId).toMatch(/^nfc_[0-9abcdefghjkmnpqrstvwxyz]{20}$/);
  });

  it("応答のカード ID と DB の行が一致する", async () => {
    // #358 以降、発行の応答に秘密は無い。取りこぼしても引き直せることを
    // 言っているのがこの検査である。
    const response = await issue(cookieFor(ADMIN), { count: 3 });
    const body = (await response.json()) as { cards: { cardId: string }[] };

    const rows = await db().select().from(nfcCards).all();
    expect(new Set(rows.map((row) => row.id))).toEqual(
      new Set(body.cards.map((card) => card.cardId)),
    );
  });

  it("カードごとに違う ID になる", async () => {
    const response = await issue(cookieFor(ADMIN), { count: 5 });
    const body = (await response.json()) as { cards: { cardId: string }[] };

    expect(new Set(body.cards.map((card) => card.cardId)).size).toBe(5);
  });

  it("監査イベントは発行を記録するが、カード ID 以外の秘密を持たない", async () => {
    await issue(cookieFor(ADMIN), { count: 1, batch: "lot-a" });

    const events = await db().select().from(nfcCardEvents).all();
    expect(events).toHaveLength(1);
    expect(events[0]?.event).toBe("card.issued");
    expect(events[0]?.actorUserId).toBe("usr_admin");
    // batch は残す。配布の単位を後から辿るのに要る。
    expect(JSON.stringify(events)).toContain("lot-a");
  });
});

describe("入力の検証", () => {
  it.each([
    ["0 枚", { count: 0 }],
    ["負の数", { count: -1 }],
    ["小数", { count: 1.5 }],
    ["上限超過", { count: MAX_ISSUE_COUNT + 1 }],
    ["count が無い", { batch: "x" }],
  ])("%s は 400 で、1 枚も作られない", async (_label, body) => {
    const response = await issue(cookieFor(ADMIN), body);

    expect(response.status).toBe(400);
    expect(await db().select().from(nfcCards).all()).toHaveLength(0);
  });

  /**
   * **既定の 5 秒では足りない。** 200 枚を**直列に**入れる（`IssueCardsUseCase`
   * が並列にしないのは、途中で失敗したときに何枚入ったか分からなくなるため）。
   * 単独で走らせると 3 秒前後だが、**他の Worker のテストと並行すると
   * 12 秒かかった**（実測）。
   *
   * **枚数は減らせない。** 境界が `MAX_ISSUE_COUNT` ちょうどであることが
   * このテストの中身なので、減らすと見るものが無くなる。時間のほうを延ばす。
   *
   * **#358 より前から同じ形である。** むしろ以前はカード 1 枚ごとに
   * 紐づけコードの生成と SHA-256 が乗っていたので、**この変更で速くなった**
   * —— それでも落ちたので、負荷次第で落ちる状態が元からあった。
   */
  it("上限ちょうどは通る", async () => {
    // 境界の片側だけ見ると、off-by-one を見逃す。
    const response = await issue(cookieFor(ADMIN), { count: MAX_ISSUE_COUNT });

    expect(response.status).toBe(201);
    expect(await db().select().from(nfcCards).all()).toHaveLength(MAX_ISSUE_COUNT);
  }, 30_000);
});

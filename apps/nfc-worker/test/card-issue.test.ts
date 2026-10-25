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
    const body = (await response.json()) as { cards: { cardId: string; claimCode: string }[] };
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

describe("紐づけコードの扱い", () => {
  it("平文は応答にだけ出て、DB にはハッシュしか残らない", async () => {
    // **この応答を取りこぼすと、そのカードは配れない。**
    const response = await issue(cookieFor(ADMIN));
    const body = (await response.json()) as { cards: { cardId: string; claimCode: string }[] };
    const { claimCode } = body.cards[0]!;

    expect(claimCode).toHaveLength(16);

    const rows = await db().select().from(nfcCards).all();
    expect(rows[0]?.claimCodeHash).not.toBe(claimCode);
    // 行のどの列にも平文が現れないこと。
    expect(JSON.stringify(rows)).not.toContain(claimCode);
  });

  it("監査イベントにも平文を書かない", async () => {
    const response = await issue(cookieFor(ADMIN), { count: 1, batch: "lot-a" });
    const body = (await response.json()) as { cards: { claimCode: string }[] };

    const events = await db().select().from(nfcCardEvents).all();
    expect(events).toHaveLength(1);
    expect(events[0]?.event).toBe("card.issued");
    expect(events[0]?.actorUserId).toBe("usr_admin");
    expect(JSON.stringify(events)).not.toContain(body.cards[0]!.claimCode);
    // batch は残す。配布の単位を後から辿るのに要る。
    expect(JSON.stringify(events)).toContain("lot-a");
  });

  it("カードごとに違うコードになる", async () => {
    const response = await issue(cookieFor(ADMIN), { count: 5 });
    const body = (await response.json()) as { cards: { claimCode: string }[] };

    expect(new Set(body.cards.map((card) => card.claimCode)).size).toBe(5);
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

  it("上限ちょうどは通る", async () => {
    // 境界の片側だけ見ると、off-by-one を見逃す。
    const response = await issue(cookieFor(ADMIN), { count: MAX_ISSUE_COUNT });

    expect(response.status).toBe(201);
    expect(await db().select().from(nfcCards).all()).toHaveLength(MAX_ISSUE_COUNT);
  });
});

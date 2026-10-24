import { type NfcDatabase, nfcCards } from "@u18/nfc-db";
import { and, desc, eq, gte, isNull, sql } from "drizzle-orm";
import type { CardRepository, NewCard } from "../../application/ports";
import { Card, type CardProps } from "../../domain/entities/card";

type CardRow = typeof nfcCards.$inferSelect;

function toDomain(row: CardRow): Card {
  const props: CardProps = {
    id: row.id,
    ownerUserId: row.ownerUserId,
    targetUrl: row.targetUrl,
    status: row.status,
    claimCodeHash: row.claimCodeHash,
    claimCodeIssuedAt: row.claimCodeIssuedAt,
    claimedAt: row.claimedAt,
    transferCount: row.transferCount,
    disabledAt: row.disabledAt,
    disabledReason: row.disabledReason,
    batch: row.batch,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
  return Card.fromPersistence(props);
}

/**
 * NFC カードの Drizzle 実装。
 *
 * この Worker が触る D1 は `NFC_DB`（`u18-nfc`）だけ。Identity D1 の
 * binding は `wrangler.jsonc` に存在しない（仕様書 2.2 / 4.1）。
 *
 * ## 状態遷移はすべて条件付き UPDATE
 *
 * 「読んで確かめてから書く」を避け、遷移の前提を WHERE 句に入れて
 * `RETURNING` で成否を見る（仕様書 7.3）。D1 は SQLite なので、
 * 単文の UPDATE は原子的に実行され、同時に来た 2 つのうち片方だけが
 * 行を返す。トランザクションを張らずに済むのはこの性質に依っている。
 */
export class DrizzleCardRepository implements CardRepository {
  constructor(private readonly db: NfcDatabase) {}

  async findById(cardId: string): Promise<Card | null> {
    const row = await this.db.select().from(nfcCards).where(eq(nfcCards.id, cardId)).get();
    return row ? toDomain(row) : null;
  }

  async listByOwner(ownerUserId: string): Promise<readonly Card[]> {
    const rows = await this.db
      .select()
      .from(nfcCards)
      .where(eq(nfcCards.ownerUserId, ownerUserId))
      // 新しく紐づけたカードを上に出す。一覧の順序に意味は無いが、
      // 未指定だと D1 の都合で並びが揺れ、UI のテストが不安定になる。
      .orderBy(desc(nfcCards.claimedAt), desc(nfcCards.createdAt))
      .all();
    return rows.map(toDomain);
  }

  async issue(card: NewCard, now: Date): Promise<void> {
    await this.db
      .insert(nfcCards)
      .values({
        id: card.id,
        status: "issued",
        claimCodeHash: card.claimCodeHash,
        claimCodeIssuedAt: now,
        batch: card.batch,
        createdAt: now,
        updatedAt: now,
      })
      .run();
  }

  async updateTarget(
    cardId: string,
    ownerUserId: string,
    targetUrl: string,
    now: Date,
  ): Promise<boolean> {
    const rows = await this.db
      .update(nfcCards)
      .set({ targetUrl, updatedAt: now })
      .where(
        and(
          eq(nfcCards.id, cardId),
          // 所有者一致を DB 側でも要求する。UseCase 側の確認と重複するが、
          // 確認と書き込みの間に release が走った場合、重複していないと
          // 元の所有者の書き込みが次の所有者のカードへ着地する。
          eq(nfcCards.ownerUserId, ownerUserId),
          eq(nfcCards.status, "active"),
        ),
      )
      .returning({ id: nfcCards.id });
    return rows.length > 0;
  }

  async disable(cardId: string, ownerUserId: string, reason: string, now: Date): Promise<boolean> {
    const rows = await this.db
      .update(nfcCards)
      .set({ status: "disabled", disabledAt: now, disabledReason: reason, updatedAt: now })
      .where(
        and(
          eq(nfcCards.id, cardId),
          eq(nfcCards.ownerUserId, ownerUserId),
          // `disabled` からの再実行は 0 行になる。UseCase 側が冪等に扱う。
          eq(nfcCards.status, "active"),
        ),
      )
      .returning({ id: nfcCards.id });
    return rows.length > 0;
  }

  async claim(
    cardId: string,
    claimCodeHash: string,
    newOwnerUserId: string,
    claimableSince: Date,
    now: Date,
  ): Promise<boolean> {
    const rows = await this.db
      .update(nfcCards)
      .set({
        ownerUserId: newOwnerUserId,
        status: "active",
        claimedAt: now,
        updatedAt: now,
        // コードを消費する。残したままにすると、同じ紙片を持つ相手が
        // release 後に何度でも claim し直せる。
        claimCodeHash: null,
        claimCodeIssuedAt: null,
        // 初回紐づけ（claimedAt が null）は移転ではないので数えない。
        transferCount: sql`${nfcCards.transferCount} + (case when ${nfcCards.claimedAt} is null then 0 else 1 end)`,
      })
      .where(
        and(
          eq(nfcCards.id, cardId),
          // ハッシュ一致・状態・期限をすべてここで判定する。
          // アプリ側で確かめてから UPDATE すると、同じコードを同時に
          // 出した 2 人が両方成功しうる。
          eq(nfcCards.claimCodeHash, claimCodeHash),
          eq(nfcCards.status, "issued"),
          // 所有者がいるカードは claim できない（念のための二重化）。
          isNull(nfcCards.ownerUserId),
          gte(nfcCards.claimCodeIssuedAt, claimableSince),
        ),
      )
      .returning({ id: nfcCards.id });
    return rows.length > 0;
  }

  async release(
    cardId: string,
    ownerUserId: string,
    nextClaimCodeHash: string,
    now: Date,
  ): Promise<boolean> {
    const rows = await this.db
      .update(nfcCards)
      .set({
        ownerUserId: null,
        status: "issued",
        // 遷移先を消す。次の所有者のカードが、本人の知らない URL を
        // 配信している状態から始まらないようにする。
        targetUrl: null,
        claimCodeHash: nextClaimCodeHash,
        claimCodeIssuedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(nfcCards.id, cardId),
          eq(nfcCards.ownerUserId, ownerUserId),
          // 無効化済みのカードは手放せない。手放せると、紛失して止めた
          // カードが再び claim 可能な状態へ戻る。
          eq(nfcCards.status, "active"),
        ),
      )
      .returning({ id: nfcCards.id });
    return rows.length > 0;
  }
}

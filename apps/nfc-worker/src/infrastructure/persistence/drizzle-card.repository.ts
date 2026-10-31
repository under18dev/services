import { type NfcDatabase, nfcCards } from "@u18/nfc-db";
import { and, desc, eq, isNull, or, sql } from "drizzle-orm";
import type { CardRepository, NewCard } from "../../application/ports";
import { Card, type CardProps } from "../../domain/entities/card";
import { ADMIN_BATCH_DISABLED_REASON } from "../../domain/services/disabled-reason";

type CardRow = typeof nfcCards.$inferSelect;

function toDomain(row: CardRow): Card {
  const props: CardProps = {
    id: row.id,
    ownerUserId: row.ownerUserId,
    targetUrl: row.targetUrl,
    status: row.status,
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

  /**
   * 全カード（運営向け、#338 Step 3）。
   *
   * **`limit + 1` 件取る。** 呼び出し側が「上限で切れたか」を判定できる
   * ようにするため（`CardRepository` の宣言を参照）。
   *
   * 並びは**発行の新しい順**。所有者向けの `listByOwner` が
   * `claimedAt` を優先するのと違うのは、運営が探すのが
   * 「さっき発行したロット」だからである。
   */
  async listAll(limit: number): Promise<readonly Card[]> {
    const rows = await this.db
      .select()
      .from(nfcCards)
      .orderBy(desc(nfcCards.createdAt), desc(nfcCards.id))
      .limit(limit + 1)
      .all();
    return rows.map(toDomain);
  }

  async issue(card: NewCard, now: Date): Promise<void> {
    await this.db
      .insert(nfcCards)
      .values({
        id: card.id,
        status: "issued",
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

  /**
   * 運営による無効化（#382）。**所有者を WHERE 句に持たない。**
   *
   * `disable` と同じ条件付き UPDATE で、違いは所有者を問わないことだけ。
   * `active` であることだけを条件にするので、`disabled` からの再実行は
   * 同じく 0 行になり、UseCase 側が冪等に扱う。
   */
  async disableAsAdmin(cardId: string, reason: string, now: Date): Promise<boolean> {
    const rows = await this.db
      .update(nfcCards)
      .set({ status: "disabled", disabledAt: now, disabledReason: reason, updatedAt: now })
      .where(
        and(
          eq(nfcCards.id, cardId),
          or(eq(nfcCards.status, "active"), eq(nfcCards.status, "issued")),
        ),
      )
      .returning({ id: nfcCards.id });
    return rows.length > 0;
  }

  /**
   * batch 単位で `issued` のカードを一括無効化する（#427）。**`active` は
   * 対象外**——WHERE 句がそのまま表明である。
   */
  async disableBatchAsAdmin(
    batch: string,
    reason: string,
    now: Date,
  ): Promise<readonly { readonly id: string }[]> {
    return await this.db
      .update(nfcCards)
      .set({ status: "disabled", disabledAt: now, disabledReason: reason, updatedAt: now })
      .where(and(eq(nfcCards.batch, batch), eq(nfcCards.status, "issued")))
      .returning({ id: nfcCards.id });
  }

  async countIssuedInBatch(batch: string): Promise<number> {
    const rows = await this.db
      .select({ id: nfcCards.id })
      .from(nfcCards)
      .where(and(eq(nfcCards.batch, batch), eq(nfcCards.status, "issued")))
      .all();
    return rows.length;
  }

  /**
   * batch 単位で `issued` 由来の `disabled` を一括で `issued` へ戻す
   * （#436、`disableBatchAsAdmin` の逆）。**`owner_user_id is null` と
   * `disabled_reason` の両方を WHERE 句に持つ**——前者は「元々 issued
   * だったか」、後者は「この一括操作で無効化されたか」を見る。
   * `ownerUserId` / `targetUrl` には触らない（`disableBatchAsAdmin` が
   * それらを変えていないので、戻す必要も無い——`reinstateAsAdmin` と
   * 同じ判断）。
   */
  async reinstateBatchToIssuedAsAdmin(
    batch: string,
    now: Date,
  ): Promise<readonly { readonly id: string }[]> {
    return await this.db
      .update(nfcCards)
      .set({ status: "issued", disabledAt: null, disabledReason: null, updatedAt: now })
      .where(
        and(
          eq(nfcCards.batch, batch),
          eq(nfcCards.status, "disabled"),
          isNull(nfcCards.ownerUserId),
          eq(nfcCards.disabledReason, ADMIN_BATCH_DISABLED_REASON),
        ),
      )
      .returning({ id: nfcCards.id });
  }

  async countDisabledInBatch(batch: string): Promise<number> {
    const rows = await this.db
      .select({ id: nfcCards.id })
      .from(nfcCards)
      .where(
        and(
          eq(nfcCards.batch, batch),
          eq(nfcCards.status, "disabled"),
          isNull(nfcCards.ownerUserId),
          eq(nfcCards.disabledReason, ADMIN_BATCH_DISABLED_REASON),
        ),
      )
      .all();
    return rows.length;
  }

  /**
   * 運営による遷移先の変更（#382）。**所有者を WHERE 句に持たない。**
   *
   * `updateTarget` と同じ条件付き UPDATE で、違いは所有者を問わないこと
   * だけ。`active` であることは要求する（`updateTargetAsAdmin` の宣言）。
   */
  async updateTargetAsAdmin(cardId: string, targetUrl: string, now: Date): Promise<boolean> {
    const rows = await this.db
      .update(nfcCards)
      .set({ targetUrl, updatedAt: now })
      .where(and(eq(nfcCards.id, cardId), eq(nfcCards.status, "active")))
      .returning({ id: nfcCards.id });
    return rows.length > 0;
  }

  async claim(cardId: string, newOwnerUserId: string, now: Date): Promise<boolean> {
    const rows = await this.db
      .update(nfcCards)
      .set({
        ownerUserId: newOwnerUserId,
        status: "active",
        claimedAt: now,
        updatedAt: now,
        // 初回紐づけ（claimedAt が null）は移転ではないので数えない。
        transferCount: sql`${nfcCards.transferCount} + (case when ${nfcCards.claimedAt} is null then 0 else 1 end)`,
      })
      .where(
        and(
          eq(nfcCards.id, cardId),
          // **前提は全部ここに置く。** アプリ側で確かめてから UPDATE すると、
          // 同じカードを同時にタップした 2 人が両方成功する（#358 で
          // 紐づけコードが無くなり、誰でも投げられるようになった）。
          eq(nfcCards.status, "issued"),
          // `status` と所有者は直交した軸なので、両方見る。
          isNull(nfcCards.ownerUserId),
        ),
      )
      .returning({ id: nfcCards.id });
    return rows.length > 0;
  }

  async release(cardId: string, ownerUserId: string, now: Date): Promise<boolean> {
    const rows = await this.db
      .update(nfcCards)
      .set({
        ownerUserId: null,
        status: "issued",
        // 遷移先を消す。次の所有者のカードが、本人の知らない URL を
        // 配信している状態から始まらないようにする。
        targetUrl: null,
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

  /**
   * 運営による所有権の剥奪（#422）。**`release` と同じ条件付き UPDATE**
   * で、違いは所有者を問わないことだけ（`disableAsAdmin` と同じ判断）。
   */
  async releaseAsAdmin(cardId: string, now: Date): Promise<boolean> {
    const rows = await this.db
      .update(nfcCards)
      .set({
        ownerUserId: null,
        status: "issued",
        targetUrl: null,
        updatedAt: now,
      })
      .where(and(eq(nfcCards.id, cardId), eq(nfcCards.status, "active")))
      .returning({ id: nfcCards.id });
    return rows.length > 0;
  }

  /**
   * 無効化されたカードを `active` へ戻す（#427）。**`ownerUserId` /
   * `targetUrl` には触らない** —— `disableAsAdmin` がそれらを変えて
   * いないので、ここで戻す必要も無い。
   */
  async reinstateAsAdmin(cardId: string, now: Date): Promise<boolean> {
    const rows = await this.db
      .update(nfcCards)
      .set({
        status: "active",
        disabledAt: null,
        disabledReason: null,
        updatedAt: now,
      })
      .where(and(eq(nfcCards.id, cardId), eq(nfcCards.status, "disabled")))
      .returning({ id: nfcCards.id });
    return rows.length > 0;
  }

  /**
   * 無効化された、所有者の無い（`issued` 由来の）カード 1 枚を `issued`
   * へ戻す（#436、`reinstateBatchToIssuedAsAdmin` の単発版）。
   * `disabled_reason` では絞らない——単発で名指しする操作のため
   * （`CardRepository` の宣言を参照）。
   */
  async reinstateToIssuedAsAdmin(cardId: string, now: Date): Promise<boolean> {
    const rows = await this.db
      .update(nfcCards)
      .set({
        status: "issued",
        disabledAt: null,
        disabledReason: null,
        updatedAt: now,
      })
      .where(
        and(eq(nfcCards.id, cardId), eq(nfcCards.status, "disabled"), isNull(nfcCards.ownerUserId)),
      )
      .returning({ id: nfcCards.id });
    return rows.length > 0;
  }
}

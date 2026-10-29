import {
  auditLogs,
  emailChallenges,
  type IdentityDatabase,
  oauthAuthorizationCodes,
  oauthTokens,
  sessions,
  webauthnChallenges,
} from "@u18/db";
import { and, inArray, isNull, lt, notInArray, or, type SQL } from "drizzle-orm";
import type { AnySQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core";
import type { ArchiveSink } from "../../application/ports/archive.port";
import type {
  ExpiredRecordPurger,
  PurgeRequest,
  PurgeResult,
} from "../../application/ports/retention.port";

/**
 * 保持期限を過ぎた行を削除する（#43、仕様書 7.3）。
 *
 * 「どの行が用済みか」はテーブルごとに列が違うので、その知識はこの層に閉じる。
 * Application 側はテーブル名と境界時刻しか知らない。
 *
 * **`users` は対象外。** アカウントは物理削除せず凍結で表現する
 * （仕様書 14.1 決定 7）。凍結アカウントの保持期間は #27 / #51 の範囲。
 *
 * `ARCHIVED_TARGETS` のテーブルは、消す前に `ArchiveSink` へ退避する
 * （#43 の残件）。退避に失敗したらそのテーブルは消さない。
 */
export class DrizzleExpiredRecordPurger implements ExpiredRecordPurger {
  constructor(
    private readonly db: IdentityDatabase,
    private readonly archive: ArchiveSink,
  ) {}

  async purge(request: PurgeRequest): Promise<PurgeResult> {
    const { target, deadBefore: dead, limit, eventDeadlines } = request;

    const deleted = await (() => {
      switch (target) {
        case "sessions":
          // 期限切れだけを条件にすれば失効済みも最終的に入る。セッションの
          // 寿命は最大 12 時間なので、失効させた行も 12 時間以内に期限切れになる。
          // それでも `revoked_at` を見るのは、期限切れ後に失効させた行
          // （`RevokeSessionUseCase` は期限を見ない）を即座に消さないため。
          return this.deleteDead(
            sessions,
            sessions.id,
            and(
              lt(sessions.expiresAt, dead),
              or(isNull(sessions.revokedAt), lt(sessions.revokedAt, dead)),
            ),
            limit,
          );

        case "oauth_authorization_codes":
          // 消費済みでも期限切れでも、保持期間を過ぎたら消す。
          // コードの寿命は 60 秒なので `consumed_at` は必ず `expires_at` 以前だが、
          // 条件を揃えておくと有効期限を変えたときに壊れない。
          return this.deleteDead(
            oauthAuthorizationCodes,
            oauthAuthorizationCodes.id,
            and(
              lt(oauthAuthorizationCodes.expiresAt, dead),
              or(
                isNull(oauthAuthorizationCodes.consumedAt),
                lt(oauthAuthorizationCodes.consumedAt, dead),
              ),
            ),
            limit,
          );

        case "oauth_tokens":
          // **`sessions` と同じ形。** 期限切れだけを条件にすれば失効済みも
          // 最終的に入る（アクセストークンの寿命は 10 分なので、失効させた
          // 行も 10 分以内に期限切れになる）。それでも `revoked_at` を見るのは、
          // **期限切れの後に失効させた行を即座に消さない**ため ——
          // 同意の取り消し（`oauth_grants.revoked_at`）は紐づくトークンを
          // 失効させるので、とうに期限切れの行に失効印が付くことがある。
          //
          // **`grant_id` の cascade には頼らない。** `oauth_grants` は掃除
          // 対象ではない（期限を持たない継続中の状態なので）から、
          // cascade は同意そのものを消したときにしか効かない。
          return this.deleteDead(
            oauthTokens,
            oauthTokens.id,
            and(
              lt(oauthTokens.expiresAt, dead),
              or(isNull(oauthTokens.revokedAt), lt(oauthTokens.revokedAt, dead)),
            ),
            limit,
          );

        case "email_challenges":
          // **`last_sent_at` を必ず条件に入れること。**
          //
          // `last_sent_at` は再送のクールダウン判定（`OtpPolicy.resendCooldownMs`）
          // に使われている。期限と消費だけを見て消すと、「コードを受け取って
          // 消費 → 行が消える → 送信履歴が無い」という順序でクールダウンを
          // 回り込めてしまう。最終送信から保持期間が経つまで残す。
          //
          // 再送上限のほうは行数そのものを数えるので（#88）、この `case` が
          // 消す行は**すべて上限の勘定から外れる**。`RetentionPolicy.email_challenges`
          // を `OtpPolicy.resendWindowMs` より短くしてはならないのはそのため。
          return this.deleteDead(
            emailChallenges,
            emailChallenges.id,
            and(
              lt(emailChallenges.expiresAt, dead),
              or(isNull(emailChallenges.consumedAt), lt(emailChallenges.consumedAt, dead)),
              or(isNull(emailChallenges.lastSentAt), lt(emailChallenges.lastSentAt, dead)),
            ),
            limit,
          );

        case "webauthn_challenges":
          return this.deleteDead(
            webauthnChallenges,
            webauthnChallenges.id,
            and(
              lt(webauthnChallenges.expiresAt, dead),
              or(isNull(webauthnChallenges.consumedAt), lt(webauthnChallenges.consumedAt, dead)),
            ),
            limit,
          );

        case "audit_logs":
          // 監査ログに「使えなくなる時刻」は無いので、記録時刻で切る。
          // ここだけ退避してから消す（`ARCHIVED_TARGETS`）。
          // 保持期間はイベントによって変わる（#22）。
          return this.archiveThenDelete(auditLogCondition(dead, eventDeadlines), limit);

        default:
          // **網羅性をここで表明する。** これが無くても `case` の
          // 書き忘れは型で落ちるが、落ちている理由は「IIFE の戻り値に
          // `undefined` が混ざり、下の `deleted >= limit` が受け付けない」
          // という**下流の使われ方**でしかない。`default: return 0;` を
          // 足す人が 1 人いれば、あるいは `deleted` の使い道が変われば、
          // **網羅性は黙って消える**（`case` を足し忘れた target だけが
          // 0 件削除で成功を返す）。表明を置いて、落ちる理由を
          // ここに固定する（#301、指摘: 39）。
          return assertExhaustive(target);
      }
    })();

    // `deleted === limit` の判定を呼び出し側に書かせない。上限に当たったことは
    // 「次回へ持ち越しがある」という運用上の意味を持つので、ここで言葉にする。
    return { target, deleted, reachedLimit: deleted >= limit };
  }

  /**
   * 条件に当てはまる行を、`limit` 件までまとめて削除する。
   *
   * `delete ... limit` は SQLite の既定ビルドでは使えない（`SQLITE_ENABLE_UPDATE_DELETE_LIMIT`
   * が要る）ので、`where id in (select id ... limit ?)` の形にしてある。
   * **上限を外さないこと。** 溜まった行を 1 ステートメントで消そうとすると
   * D1 の実行時間上限に当たり、途中で落ちて 1 行も消えない。
   * 「溜まっているほど掃除が失敗する」という最悪の挙動になる（#43）。
   *
   * 削除件数は `returning()` ではなく D1 の `meta.changes` から取る。
   * 1,000 件分の id を workerd 側へ運ぶ必要がないため。
   */
  /**
   * 監査ログを R2 へ退避してから消す（#43 の残件）。
   *
   * ## 順序が肝
   *
   * **退避 → 確認 → 削除。** 逆にすると、退避が壊れている間ずっと静かに
   * ログが消え続け、気づくのは「半年前の行を見に行ったら無かった」時に
   * なる。`ArchiveSink.put()` は失敗を例外で返す契約なので、ここで
   * catch しない —— 例外は `PurgeExpiredRecordsUseCase` まで上がり、
   * このテーブルだけが `failed` に入って他のテーブルの掃除は続く。
   *
   * ## 消すのは「退避した id」だけ
   *
   * `deleteDead` のように条件で消し直さない。選び直す瞬間に境界を跨いだ
   * 行——**退避していない行**——まで巻き込むため。`limit` 件を読んで、
   * その id をそのまま `in (...)` に入れる。
   *
   * 1,000 行を workerd 側へ運ぶことになるが、これは退避に本文が要る以上
   * 避けられない。`RETENTION_SWEEP_LIMIT` の根拠（D1 の実行時間上限から
   * 遠いままでいること）はここでも変わらない。
   */
  private async archiveThenDelete(dead: SQL | undefined, limit: number): Promise<number> {
    const rows = await this.db.select().from(auditLogs).where(dead).limit(limit).all();
    // 0 件のときに空オブジェクトを置かない。棚卸しのとき、中身の無い
    // キーが日付ディレクトリを埋めると「その日は何も無かった」が読めなくなる。
    if (rows.length === 0) return 0;

    const receipt = await this.archive.put({ target: "audit_logs", rows });

    const result = await this.db
      .delete(auditLogs)
      .where(
        inArray(
          auditLogs.id,
          rows.map((row) => row.id),
        ),
      )
      .run();

    // 退避先を構造化ログに出す。これが無いと、消えた行がどのキーに
    // 入っているかを後から特定できない（ランブック 7.2）。
    console.info("retention archive", {
      target: "audit_logs",
      key: receipt.key,
      rowCount: receipt.rowCount,
      bytes: receipt.bytes,
      deleted: result.meta.changes,
    });

    return result.meta.changes;
  }

  private async deleteDead(
    table: SQLiteTable,
    id: AnySQLiteColumn,
    dead: SQL | undefined,
    limit: number,
  ): Promise<number> {
    const doomed = this.db.select({ id }).from(table).where(dead).limit(limit);
    const result = await this.db.delete(table).where(inArray(id, doomed)).run();
    return result.meta.changes;
  }
}

/**
 * `audit_logs` の削除条件（#22 / #43）。
 *
 * `eventDeadlines` に名前がある行は**そちらの境界**、無い行は
 * `deadBefore` で判定する。SQL はこうなる:
 *
 * ```sql
 * (event not in (長期の名前...) and created_at < 既定の境界)
 *   or (event in (2 年の名前...) and created_at < 2 年前)
 * ```
 *
 * ## `not in` を省かないこと
 *
 * 1 本目を単に `created_at < 既定の境界` にすると、**長期側のイベントが
 * そこで拾われて 180 日で消える。** 区分を足した意味が丸ごと消え、しかも
 * テーブルの中身を見るまで気づけない（SQL は成功し、件数も自然に見える）。
 *
 * ## 区分ごとにまとめる
 *
 * 同じ境界のイベントは 1 本の `in (...)` に畳む。イベントごとに OR を
 * 並べると、区分が増えたときに条件の本数が名前の数だけ増える。
 */
function auditLogCondition(
  deadBefore: Date,
  eventDeadlines: ReadonlyMap<string, Date> | undefined,
): SQL | undefined {
  const longerLived = [...(eventDeadlines ?? new Map<string, Date>())];
  if (longerLived.length === 0) return lt(auditLogs.createdAt, deadBefore);

  // 境界時刻ごとにイベント名をまとめる。
  const byDeadline = new Map<number, string[]>();
  for (const [event, deadline] of longerLived) {
    const key = deadline.getTime();
    byDeadline.set(key, [...(byDeadline.get(key) ?? []), event]);
  }

  const names = longerLived.map(([event]) => event);
  return or(
    // 既定の区分。長期側の名前を必ず除く。
    and(notInArray(auditLogs.event, names), lt(auditLogs.createdAt, deadBefore)),
    ...[...byDeadline].map(([deadline, events]) =>
      and(inArray(auditLogs.event, events), lt(auditLogs.createdAt, new Date(deadline))),
    ),
  );
}

/** 届かないはずの分岐。`RetentionTarget` が増えたらここが型で落ちる（#301）。 */
function assertExhaustive(target: never): never {
  throw new Error(`掃除の対象に case がありません: ${String(target)}`);
}

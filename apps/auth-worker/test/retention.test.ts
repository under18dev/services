import {
  auditLogs,
  createIdentityDatabase,
  emailChallenges,
  oauthAuthorizationCodes,
  oauthClients,
  oauthGrants,
  oauthTokens,
  schema,
  sessions,
  users,
  webauthnChallenges,
} from "@u18/db";
import { getTableColumns, getTableName, is } from "drizzle-orm";
import { SQLiteTable } from "drizzle-orm/sqlite-core";
import { FixedClock, aUser } from "@u18/testing";
import { createExecutionContext, createScheduledController, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { PurgeExpiredRecordsUseCase } from "../src/application/use-cases/purge-expired-records.use-case";
import type {
  ArchiveReceipt,
  ArchiveRequest,
  ArchiveSink,
} from "../src/application/ports/archive.port";
import type {
  ExpiredRecordPurger,
  PurgeRequest,
  PurgeResult,
} from "../src/application/ports/retention.port";
import {
  NEVER_SWEPT,
  RetentionPolicy,
  type RetentionTarget,
  retentionClassificationGaps,
} from "../src/domain/services/retention-policy";
import { auditEventDeadlines, type AuditEventName } from "../src/application/ports/audit-log.port";
import { OtpPolicy, TokenLifetime } from "../src/domain/services/token-lifetime";
import { UnconfiguredArchiveSink } from "../src/infrastructure/archive/r2-archive-sink";
import { DrizzleExpiredRecordPurger } from "../src/infrastructure/persistence/drizzle-expired-record-purger";
import worker from "../src/index";
import { resetDatabase } from "./helpers";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const now = new Date("2026-10-24T12:00:00.000Z");
const ago = (ms: number): Date => new Date(now.getTime() - ms);

/** 退避先のフェイク。何を渡されたかを覚えるだけ。 */
class RecordingArchiveSink implements ArchiveSink {
  readonly requests: ArchiveRequest[] = [];
  /** 立てると `put()` が投げる。退避が失敗したときの挙動を見るため。 */
  failWith: Error | null = null;

  async put(request: ArchiveRequest): Promise<ArchiveReceipt> {
    if (this.failWith !== null) throw this.failWith;
    this.requests.push(request);
    return {
      key: `fake/${request.target}/${this.requests.length}.ndjson`,
      rowCount: request.rows.length,
      bytes: 1,
    };
  }
}

/** 保持期限ちょうどの境界時刻。これより前の行だけが消える。 */
const cutoff = (target: RetentionTarget): Date => new Date(now.getTime() - RetentionPolicy[target]);

describe("DrizzleExpiredRecordPurger", () => {
  let db: ReturnType<typeof createIdentityDatabase>;
  let purger: DrizzleExpiredRecordPurger;
  let archive: RecordingArchiveSink;
  const user = aUser();
  const clientRowId = "cli_retention";

  beforeEach(async () => {
    await resetDatabase();
    db = createIdentityDatabase(env.IDENTITY_DB);
    archive = new RecordingArchiveSink();
    purger = new DrizzleExpiredRecordPurger(db, archive);

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

    await db
      .insert(oauthClients)
      .values({
        id: clientRowId,
        clientId: "retention-test",
        name: "Retention Test",
        clientType: "public",
      })
      .run();
  });

  const idsIn = async (table: typeof sessions | typeof emailChallenges): Promise<string[]> => {
    const rows = await db.select({ id: table.id }).from(table).all();
    return rows.map((r) => r.id).sort();
  };

  const putSession = (id: string, expiresAt: Date, revokedAt: Date | null = null) =>
    db
      .insert(sessions)
      .values({
        id,
        userId: user.id,
        tokenHash: `hash_${id}`,
        expiresAt,
        revokedAt,
        authMethod: "passkey",
        lastSeenAt: expiresAt,
        userAgent: null,
        ipHash: null,
      })
      .run();

  describe("sessions", () => {
    it("保持期限を過ぎた期限切れセッションだけを消す", async () => {
      // 有効なセッション。これが消えるとログイン中の利用者が蹴り出される。
      await putSession("ses_live", new Date(now.getTime() + TokenLifetime.sessionMs));
      // 期限切れだが保持期間（30 日）の内側。一覧 UI の履歴として残す。
      await putSession("ses_recent", ago(3 * DAY));
      // 保持期間を過ぎた期限切れ。
      await putSession("ses_stale", ago(31 * DAY));

      const result = await purger.purge({
        target: "sessions",
        deadBefore: cutoff("sessions"),
        limit: 100,
      });

      expect(result.deleted).toBe(1);
      expect(result.reachedLimit).toBe(false);
      expect(await idsIn(sessions)).toEqual(["ses_live", "ses_recent"]);
    });

    it("失効済みでも、失効してから保持期間が経つまでは残す", async () => {
      // 期限切れから 31 日経っているが、失効させたのは直前。
      // 「いつ誰が失効させたか」を調べられるよう、失効時刻からも 30 日待つ。
      await putSession("ses_just_revoked", ago(31 * DAY), ago(1 * MINUTE));
      await putSession("ses_long_revoked", ago(31 * DAY), ago(31 * DAY));

      const result = await purger.purge({
        target: "sessions",
        deadBefore: cutoff("sessions"),
        limit: 100,
      });

      expect(result.deleted).toBe(1);
      expect(await idsIn(sessions)).toEqual(["ses_just_revoked"]);
    });
  });

  describe("email_challenges", () => {
    const putChallenge = (
      id: string,
      props: { expiresAt: Date; consumedAt?: Date | null; lastSentAt?: Date | null },
    ) =>
      db
        .insert(emailChallenges)
        .values({
          id,
          userId: user.id,
          email: "taro@example.com",
          codeHash: `hash_${id}`,
          purpose: "login",
          expiresAt: props.expiresAt,
          maxAttempts: OtpPolicy.maxAttempts,
          consumedAt: props.consumedAt ?? null,
          resendCount: 0,
          lastSentAt: props.lastSentAt ?? props.expiresAt,
        })
        .run();

    it("クールダウン窓の内側にある消費済みの行は消さない", async () => {
      // #43 の回帰テスト。
      //
      // `last_sent_at` は再送のクールダウン判定に使われている
      // （OtpPolicy.resendCooldownMs）。期限と消費だけを見て消すと、
      // 「コードを消費する → 行が消える → 送信履歴が無い」の順で
      // クールダウンを回り込めてしまう。再送上限のほうは行数を数えるので
      // （#88）、消された行はそのまま勘定から外れる。
      //
      // 下の行は、期限切れからは 2 時間（保持期間 1 時間を超過）経っているが、
      // 最後の送信は 30 秒前でクールダウン窓（60 秒）の内側にある。
      await putChallenge("emc_in_cooldown", {
        expiresAt: ago(2 * HOUR),
        consumedAt: ago(2 * HOUR),
        lastSentAt: ago(30 * 1000),
      });
      // 同じく期限切れだが、消費したのが直前。こちらも残す。
      await putChallenge("emc_just_consumed", {
        expiresAt: ago(2 * HOUR),
        consumedAt: ago(1 * MINUTE),
        lastSentAt: ago(2 * HOUR),
      });
      // 期限切れ・消費・最終送信のすべてが保持期間の外。これだけ消える。
      await putChallenge("emc_stale", {
        expiresAt: ago(2 * HOUR),
        consumedAt: ago(2 * HOUR),
        lastSentAt: ago(2 * HOUR),
      });

      const result = await purger.purge({
        target: "email_challenges",
        deadBefore: cutoff("email_challenges"),
        limit: 100,
      });

      expect(result.deleted).toBe(1);
      expect(await idsIn(emailChallenges)).toEqual(["emc_in_cooldown", "emc_just_consumed"]);
    });

    it("保持期間はクールダウン窓より確実に長い", () => {
      // 保持期間を縮めるときの歯止め。クールダウン（60 秒）や
      // OTP の有効期限（5 分）を下回ると、上のテストが意味を失う。
      expect(RetentionPolicy.email_challenges).toBeGreaterThan(OtpPolicy.resendCooldownMs);
      expect(RetentionPolicy.email_challenges).toBeGreaterThan(TokenLifetime.emailOtpMs);
    });

    it("まだ有効な（期限内の）チャレンジは消さない", async () => {
      await putChallenge("emc_live", { expiresAt: new Date(now.getTime() + 5 * MINUTE) });

      const result = await purger.purge({
        target: "email_challenges",
        deadBefore: cutoff("email_challenges"),
        limit: 100,
      });

      expect(result.deleted).toBe(0);
      expect(await idsIn(emailChallenges)).toEqual(["emc_live"]);
    });
  });

  describe("oauth_tokens", () => {
    const grantId = "grt_retention";

    const putToken = (id: string, expiresAt: Date, revokedAt: Date | null = null) =>
      db
        .insert(oauthTokens)
        .values({
          id,
          tokenHash: `hash_${id}`,
          tokenType: "access",
          grantId,
          clientId: clientRowId,
          userId: user.id,
          scope: "openid",
          expiresAt,
          revokedAt,
        })
        .run();

    beforeEach(async () => {
      // `grant_id` は notNull の外部キー。同意が無いトークンは作れない。
      await db
        .insert(oauthGrants)
        .values({
          id: grantId,
          userId: user.id,
          clientId: clientRowId,
          grantedScopes: "openid",
          grantedAt: ago(1 * DAY),
        })
        .run();
    });

    it("保持期間を過ぎた期限切れトークンだけを消す", async () => {
      // 有効なトークン。これが消えると、使用中の RP が突然 401 になる。
      await putToken("tok_live", new Date(now.getTime() + TokenLifetime.accessTokenMs));
      // 期限切れだが保持期間（30 日）の内側。失効後の再提示を調べる窓。
      await putToken("tok_recent", ago(3 * DAY));
      // 保持期間を過ぎた期限切れ。
      await putToken("tok_stale", ago(31 * DAY));

      const result = await purger.purge({
        target: "oauth_tokens",
        deadBefore: cutoff("oauth_tokens"),
        limit: 100,
      });

      expect(result.deleted).toBe(1);
      expect(result.reachedLimit).toBe(false);
      const rows = await db.select({ id: oauthTokens.id }).from(oauthTokens).all();
      expect(rows.map((r) => r.id).sort()).toEqual(["tok_live", "tok_recent"]);
    });

    it("とうに期限切れでも、失効が最近なら残す", async () => {
      // **同意の取り消しは、期限切れのトークンにも失効印を付ける。**
      // 期限だけを見て消すと、「取り消した直後に、取り消した記録ごと
      // 行が消える」が起きる。`sessions` が `revoked_at` を見ているのと
      // 同じ理由で、ここでも見る。
      await putToken("tok_revoked_recently", ago(31 * DAY), ago(1 * DAY));

      const result = await purger.purge({
        target: "oauth_tokens",
        deadBefore: cutoff("oauth_tokens"),
        limit: 100,
      });

      expect(result.deleted).toBe(0);
      const rows = await db.select({ id: oauthTokens.id }).from(oauthTokens).all();
      expect(rows.map((r) => r.id)).toEqual(["tok_revoked_recently"]);
    });

    it("同意は消さない", async () => {
      // `oauth_grants` は掃除対象ではない（期限を持たない継続中の状態）。
      // トークンを消したついでに同意まで外れると、利用者が次に使うとき
      // 身に覚えのない同意画面が出る。
      await putToken("tok_stale", ago(31 * DAY));

      await purger.purge({
        target: "oauth_tokens",
        deadBefore: cutoff("oauth_tokens"),
        limit: 100,
      });

      const grants = await db.select({ id: oauthGrants.id }).from(oauthGrants).all();
      expect(grants.map((r) => r.id)).toEqual([grantId]);
    });
  });

  describe("oauth_authorization_codes / webauthn_challenges / audit_logs", () => {
    it("保持期間を過ぎた認可コードだけを消す", async () => {
      const putCode = (id: string, expiresAt: Date, consumedAt: Date | null) =>
        db
          .insert(oauthAuthorizationCodes)
          .values({
            id,
            codeHash: `hash_${id}`,
            clientId: clientRowId,
            userId: user.id,
            redirectUri: "https://example.com/cb",
            scope: "openid",
            codeChallenge: "challenge",
            codeChallengeMethod: "S256",
            authTime: expiresAt,
            expiresAt,
            consumedAt,
          })
          .run();

      await putCode("cod_live", new Date(now.getTime() + 60 * 1000), null);
      await putCode("cod_recent", ago(1 * HOUR), ago(1 * HOUR));
      await putCode("cod_stale", ago(25 * HOUR), ago(25 * HOUR));

      const result = await purger.purge({
        target: "oauth_authorization_codes",
        deadBefore: cutoff("oauth_authorization_codes"),
        limit: 100,
      });

      expect(result.deleted).toBe(1);
      const rows = await db
        .select({ id: oauthAuthorizationCodes.id })
        .from(oauthAuthorizationCodes)
        .all();
      expect(rows.map((r) => r.id).sort()).toEqual(["cod_live", "cod_recent"]);
    });

    it("保持期間を過ぎた WebAuthn チャレンジだけを消す", async () => {
      const putChallenge = (id: string, expiresAt: Date, consumedAt: Date | null) =>
        db
          .insert(webauthnChallenges)
          .values({
            id,
            userId: user.id,
            challenge: `challenge_${id}`,
            purpose: "authentication",
            expiresAt,
            consumedAt,
          })
          .run();

      await putChallenge("wac_live", new Date(now.getTime() + 5 * MINUTE), null);
      await putChallenge("wac_recent", ago(1 * HOUR), ago(1 * HOUR));
      await putChallenge("wac_stale", ago(25 * HOUR), ago(25 * HOUR));

      const result = await purger.purge({
        target: "webauthn_challenges",
        deadBefore: cutoff("webauthn_challenges"),
        limit: 100,
      });

      expect(result.deleted).toBe(1);
      const rows = await db.select({ id: webauthnChallenges.id }).from(webauthnChallenges).all();
      expect(rows.map((r) => r.id).sort()).toEqual(["wac_live", "wac_recent"]);
    });

    it("保持期間を過ぎた監査ログだけを消す", async () => {
      const putLog = (id: string, createdAt: Date) =>
        db
          .insert(auditLogs)
          .values({ id, event: "session.created", outcome: "success", createdAt })
          .run();

      await putLog("aud_recent", ago(179 * DAY));
      await putLog("aud_stale", ago(181 * DAY));

      const result = await purger.purge({
        target: "audit_logs",
        deadBefore: cutoff("audit_logs"),
        limit: 100,
      });

      expect(result.deleted).toBe(1);
      const rows = await db.select({ id: auditLogs.id }).from(auditLogs).all();
      expect(rows.map((r) => r.id)).toEqual(["aud_recent"]);
    });
  });

  /**
   * イベントごとの保持区分（#22）。
   *
   * 一律 180 日だと、**アカウントの支配権が変わった操作の記録が、
   * 侵害が発覚するより先に消える。** 「攻撃者がいつ自分の認証器を
   * 足したのか」は半年以上経ってから訊かれる。
   */
  describe("audit_logs の保持区分", () => {
    const putLog = (id: string, event: AuditEventName, createdAt: Date) =>
      db.insert(auditLogs).values({ id, event, outcome: "success", createdAt }).run();

    /** 本物と同じ経路で境界を作る。テスト側で日数を書き写さない。 */
    const purgeAuditLogs = () =>
      purger.purge({
        target: "audit_logs",
        deadBefore: cutoff("audit_logs"),
        limit: 100,
        eventDeadlines: auditEventDeadlines(now),
      });

    const remaining = async (): Promise<string[]> =>
      (await db.select({ id: auditLogs.id }).from(auditLogs).all()).map((r) => r.id).sort();

    it("支配権が変わる操作は 180 日では消えない", async () => {
      // 1 年前。既定（180 日）なら消えるが、security 区分（2 年）なら残る。
      await putLog("aud_passkey", "passkey.register", ago(365 * DAY));
      await putLog("aud_profile", "profile.updated", ago(365 * DAY));
      await putLog("aud_replay", "oauth.code.replayed", ago(365 * DAY));

      expect((await purgeAuditLogs()).deleted).toBe(0);
      expect(await remaining()).toEqual(["aud_passkey", "aud_profile", "aud_replay"]);
    });

    it("区分の無いイベントは 180 日で消える", async () => {
      await putLog("aud_issue", "session.issue", ago(181 * DAY));
      await putLog("aud_userinfo", "oauth.userinfo", ago(181 * DAY));

      expect((await purgeAuditLogs()).deleted).toBe(2);
      expect(await remaining()).toEqual([]);
    });

    it("同じ日付でも区分で生死が分かれる", async () => {
      // **これが区分化の本体。** 1 本のクエリで両方を正しく扱えていないと、
      // どちらかが巻き込まれる。
      const oneYearAgo = ago(365 * DAY);
      await putLog("aud_keep", "passkey.deleted", oneYearAgo);
      await putLog("aud_drop", "session.issue", oneYearAgo);

      expect((await purgeAuditLogs()).deleted).toBe(1);
      expect(await remaining()).toEqual(["aud_keep"]);
    });

    it("2 年を過ぎれば支配権が変わる操作も消える", async () => {
      await putLog("aud_old", "session.revoke", ago(731 * DAY));
      await putLog("aud_young", "session.revoke", ago(729 * DAY));

      expect((await purgeAuditLogs()).deleted).toBe(1);
      expect(await remaining()).toEqual(["aud_young"]);
    });

    it("区分を渡さなければ全件が既定の境界で判定される", async () => {
      // `eventDeadlines` を省いた呼び出し（audit_logs 以外の経路と同じ形）。
      // ここが壊れると、区分を渡し忘れた瞬間に長期側が 180 日で消える。
      await putLog("aud_passkey", "passkey.register", ago(181 * DAY));

      const result = await purger.purge({
        target: "audit_logs",
        deadBefore: cutoff("audit_logs"),
        limit: 100,
      });

      expect(result.deleted).toBe(1);
    });
  });

  /**
   * 退避してから消す（#43 の残件）。
   *
   * 180 日を過ぎた監査ログは「消してよいから」ではなく「D1 に置き続ける
   * コストが見合わないから」消している。侵害の発覚は 1 年遅れることが
   * あるので、戻せる場所に置いてから消す。
   */
  describe("audit_logs の退避", () => {
    const putLog = (id: string, createdAt: Date) =>
      db
        .insert(auditLogs)
        .values({
          id,
          event: "session.issue",
          outcome: "success",
          userId: user.id,
          ipHash: `hash_${id}`,
          userAgent: "u18-test/1.0",
          metadata: { authMethod: "passkey" },
          createdAt,
        })
        .run();

    const purgeAuditLogs = (limit = 100) =>
      purger.purge({ target: "audit_logs", deadBefore: cutoff("audit_logs"), limit });

    it("消す行を退避してから消す", async () => {
      await putLog("aud_stale", ago(181 * DAY));
      await putLog("aud_recent", ago(179 * DAY));

      await purgeAuditLogs();

      expect(archive.requests).toHaveLength(1);
      const request = archive.requests[0]!;
      expect(request.target).toBe("audit_logs");
      // **保持期間の内側の行を退避しないこと。** 退避した行はこの後消える。
      expect(request.rows.map((row) => row["id"])).toEqual(["aud_stale"]);
      // 中身がそのまま入っていること。id だけ写しても復元に使えない。
      expect(request.rows[0]).toMatchObject({
        event: "session.issue",
        ipHash: "hash_aud_stale",
        userAgent: "u18-test/1.0",
      });
    });

    it("退避に失敗したら 1 行も消さない", async () => {
      // **#43 の残件で一番大事なところ。** 退避が静かに失敗したまま削除を
      // 続けると、壊れていると分かるのは「半年前の行を見に行ったら
      // 無かった」時、つまり侵害調査の最中になる。
      await putLog("aud_stale", ago(181 * DAY));
      archive.failWith = new Error("R2 is unreachable");

      await expect(purgeAuditLogs()).rejects.toThrow(/R2 is unreachable/);

      const rows = await db.select({ id: auditLogs.id }).from(auditLogs).all();
      expect(
        rows.map((r) => r.id),
        "退避できていないのに消えている",
      ).toEqual(["aud_stale"]);
    });

    it("消す行が無ければ空のオブジェクトを作らない", async () => {
      // 15 分おきに空ファイルが積まれると、棚卸しで「その日は何も無かった」
      // が読めなくなる。
      await putLog("aud_recent", ago(179 * DAY));

      expect((await purgeAuditLogs()).deleted).toBe(0);
      expect(archive.requests).toEqual([]);
    });

    it("上限を超えた分は退避もしない", async () => {
      // 退避と削除の対象が食い違うと、退避していない行が消える。
      for (let i = 0; i < 3; i++) await putLog(`aud_stale_${i}`, ago(181 * DAY));

      const first = await purgeAuditLogs(2);

      expect(first).toEqual({ target: "audit_logs", deleted: 2, reachedLimit: true });
      expect(archive.requests[0]?.rows).toHaveLength(2);
      // 退避した id と消えた id が一致すること。
      const archived = archive.requests[0]!.rows.map((row) => row["id"]);
      const left = (await db.select({ id: auditLogs.id }).from(auditLogs).all()).map((r) => r.id);
      expect(archived.filter((id) => left.includes(id as string))).toEqual([]);
    });

    it("audit_logs 以外は退避しない", async () => {
      // 消してよいから消しているテーブルを退避すると、消したはずの
      // 個人情報が別の場所に残る（retention-policy.ts の ARCHIVED_TARGETS）。
      await putSession("ses_stale", ago(31 * DAY));

      await purger.purge({ target: "sessions", deadBefore: cutoff("sessions"), limit: 100 });

      expect(archive.requests).toEqual([]);
    });
  });

  describe("1 回の上限", () => {
    it("上限に達したら次回へ持ち越す", async () => {
      // D1 の実行時間上限に当てないため、1 回で消す行数には必ず上限がある。
      // 上限を超えた分が消えずに残り、次の実行で続きが消えることを確かめる。
      for (let i = 0; i < 5; i++) {
        await putSession(`ses_stale_${i}`, ago(31 * DAY));
      }
      await putSession("ses_live", new Date(now.getTime() + TokenLifetime.sessionMs));

      const request = { target: "sessions", deadBefore: cutoff("sessions"), limit: 2 } as const;

      const first = await purger.purge(request);
      expect(first).toEqual({ target: "sessions", deleted: 2, reachedLimit: true });

      const second = await purger.purge(request);
      expect(second).toEqual({ target: "sessions", deleted: 2, reachedLimit: true });

      // 残り 1 件。上限に届かないので持ち越しは無い。
      const third = await purger.purge(request);
      expect(third).toEqual({ target: "sessions", deleted: 1, reachedLimit: false });

      const fourth = await purger.purge(request);
      expect(fourth).toEqual({ target: "sessions", deleted: 0, reachedLimit: false });

      // 有効なセッションは 4 回の実行を通して一度も触られない。
      expect(await idsIn(sessions)).toEqual(["ses_live"]);
    });
  });
});

/**
 * UseCase 単体。Port を差し替えて「掃除経路が 1 本であること」の中身を見る。
 */
describe("PurgeExpiredRecordsUseCase", () => {
  class RecordingPurger implements ExpiredRecordPurger {
    readonly requests: PurgeRequest[] = [];
    constructor(
      private readonly behaviour: Partial<Record<RetentionTarget, number | Error>> = {},
    ) {}

    async purge(request: PurgeRequest): Promise<PurgeResult> {
      this.requests.push(request);
      const outcome = this.behaviour[request.target] ?? 0;
      if (outcome instanceof Error) throw outcome;
      return {
        target: request.target,
        deleted: outcome,
        reachedLimit: outcome >= request.limit,
      };
    }
  }

  const silentAudit = { record: async (): Promise<void> => {} };

  it("1 回の実行で 6 テーブルすべてを、テーブルごとの保持期間で見る", async () => {
    const purger = new RecordingPurger();
    const useCase = new PurgeExpiredRecordsUseCase({
      purger,
      clock: new FixedClock(now),
      audit: silentAudit,
    });

    const result = await useCase.execute({ limit: 10 });

    expect(result.ok).toBe(true);
    expect(purger.requests.map((r) => r.target)).toEqual([
      "sessions",
      "oauth_authorization_codes",
      "oauth_tokens",
      "email_challenges",
      "webauthn_challenges",
      "audit_logs",
    ]);
    for (const request of purger.requests) {
      expect(request.deadBefore).toEqual(cutoff(request.target));
    }
  });

  it("audit_logs にだけイベントごとの境界を渡す", async () => {
    // **区分を実装しても、UseCase が渡さなければ効かない。**
    // 条件側のテストは「渡されたら正しく効く」しか見ていないので、
    // ここで経路が繋がっていることを別に固定する（#143 で入れた
    // 「入口が ctx.waitUntil を呼んでいる」と同じ理由）。
    const purger = new RecordingPurger();
    const useCase = new PurgeExpiredRecordsUseCase({
      purger,
      clock: new FixedClock(now),
      audit: silentAudit,
    });

    await useCase.execute({ limit: 10 });

    const byTarget = new Map(purger.requests.map((r) => [r.target, r]));
    const auditRequest = byTarget.get("audit_logs");
    expect(auditRequest?.eventDeadlines, "audit_logs に境界が渡っていない").toBeDefined();
    // 中身も本物と一致すること。空の Map を渡しても上の toBeDefined は通る。
    expect([...(auditRequest?.eventDeadlines ?? [])].sort()).toEqual(
      [...auditEventDeadlines(now)].sort(),
    );

    // 他のテーブルには渡さない。渡すと「ここにも区分がある」と読める。
    for (const request of purger.requests) {
      if (request.target === "audit_logs") continue;
      expect(request.eventDeadlines, `${request.target} に境界が渡っている`).toBeUndefined();
    }
  });

  it("1 テーブルが落ちても残りのテーブルは掃除する", async () => {
    // D1 が 1 テーブルで失敗したせいで他が溜まり続けるのは割に合わない。
    const purger = new RecordingPurger({ sessions: new Error("D1_ERROR") });
    const useCase = new PurgeExpiredRecordsUseCase({
      purger,
      clock: new FixedClock(now),
      audit: silentAudit,
    });

    const result = await useCase.execute({ limit: 10 });

    expect(result.ok && result.value.failed).toEqual(["sessions"]);
    // 対象が増えても古びないよう、件数は `RetentionPolicy` から引く。
    // ここで見たいのは「全テーブルを試したか」であって個数そのものではない。
    expect(purger.requests).toHaveLength(Object.keys(RetentionPolicy).length);
  });

  it("退避先が無いと audit_logs だけが止まり、他のテーブルは掃除される", async () => {
    // **素通しして消し始めないこと。** 退避できないまま消すより、溜めて
    // failed に出し続けるほうがよい（ARCHIVED_TARGETS のコメント）。
    // 他のテーブルを巻き添えにしないのは「1 テーブルが落ちても残りを続ける」
    // という既存の約束そのまま。
    await resetDatabase();
    const db = createIdentityDatabase(env.IDENTITY_DB);
    // 消す対象が 1 行も無いと退避自体が起きないので、まず古い行を置く。
    await db
      .insert(auditLogs)
      .values({
        id: "aud_stale",
        event: "session.issue",
        outcome: "success",
        createdAt: ago(181 * DAY),
      })
      .run();

    const useCase = new PurgeExpiredRecordsUseCase({
      purger: new DrizzleExpiredRecordPurger(
        db,
        new UnconfiguredArchiveSink("ARCHIVE bucket binding is missing"),
      ),
      clock: new FixedClock(now),
      audit: silentAudit,
    });

    const result = await useCase.execute({ limit: 10 });

    expect(result.ok && result.value.failed).toEqual(["audit_logs"]);
    // 退避できていないので 1 行も消えていない。
    expect((await db.select({ id: auditLogs.id }).from(auditLogs).all()).map((r) => r.id)).toEqual([
      "aud_stale",
    ]);
  });

  it("上限に達したテーブルを carriedOver で返す", async () => {
    const purger = new RecordingPurger({ audit_logs: 10 });
    const useCase = new PurgeExpiredRecordsUseCase({
      purger,
      clock: new FixedClock(now),
      audit: silentAudit,
    });

    const result = await useCase.execute({ limit: 10 });

    expect(result.ok && result.value.carriedOver).toEqual(["audit_logs"]);
    expect(result.ok && result.value.deleted).toBe(10);
  });
});

/**
 * Cron Trigger の入口。
 *
 * `createScheduledController()` で本物の `scheduled` ハンドラを叩き、
 * 「Cron から呼ばれたら実際に行が消えるか」まで通しで確かめる。
 */
describe("scheduled ハンドラ", () => {
  let db: ReturnType<typeof createIdentityDatabase>;
  const user = aUser();

  beforeEach(async () => {
    await resetDatabase();
    db = createIdentityDatabase(env.IDENTITY_DB);
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
  });

  it("Cron 実行で保持期限を過ぎた行が消え、有効な行は残る", async () => {
    // scheduled は実時計で動くので、現在時刻から見て十分古い値を入れる。
    const realNow = Date.now();
    const old = (ms: number): Date => new Date(realNow - ms);

    await db
      .insert(sessions)
      .values([
        {
          id: "ses_stale",
          userId: user.id,
          tokenHash: "hash_stale",
          expiresAt: old(90 * DAY),
          authMethod: "passkey",
          lastSeenAt: old(90 * DAY),
        },
        {
          id: "ses_live",
          userId: user.id,
          tokenHash: "hash_live",
          expiresAt: new Date(realNow + TokenLifetime.sessionMs),
          authMethod: "passkey",
          lastSeenAt: new Date(realNow),
        },
      ])
      .run();
    await db
      .insert(webauthnChallenges)
      .values({
        id: "wac_stale",
        userId: user.id,
        challenge: "challenge_stale",
        purpose: "authentication",
        expiresAt: old(90 * DAY),
        consumedAt: old(90 * DAY),
      })
      .run();
    await db
      .insert(auditLogs)
      .values({
        id: "aud_stale",
        event: "session.created",
        outcome: "success",
        createdAt: old(365 * DAY),
      })
      .run();

    const controller = createScheduledController({ cron: "*/15 * * * *" });
    const ctx = createExecutionContext();
    await worker.scheduled(controller, env, ctx);

    const sessionIds = await db.select({ id: sessions.id }).from(sessions).all();
    expect(sessionIds.map((r) => r.id)).toEqual(["ses_live"]);
    expect(await db.select({ id: webauthnChallenges.id }).from(webauthnChallenges).all()).toEqual(
      [],
    );

    // 掃除自身の記録が残る。黙って動く掃除は、止まっていても気づけない。
    const logs = await db
      .select({ id: auditLogs.id, event: auditLogs.event, metadata: auditLogs.metadata })
      .from(auditLogs)
      .all();
    expect(logs.map((r) => r.id)).not.toContain("aud_stale");
    const sweep = logs.find((r) => r.event === "retention.sweep");
    expect(sweep?.metadata).toMatchObject({
      deleted: 3,
      byTarget: { sessions: 1, webauthn_challenges: 1, audit_logs: 1 },
    });
  });
});

/**
 * 保持期限の**網羅**（#273）。
 *
 * ## なぜ 1 件直すだけでは済まないのか
 *
 * `oauth_tokens` は `RetentionTarget` に無く、掃除されないまま残っていた。
 * `oauth_tokens_expires_idx` という索引まであったので、**期限で引く想定は
 * あったのに掃除だけが無い**形だった。
 *
 * 見落とせた理由は、このファイルの他のテストが**列挙されたものを 1 つずつ
 * 確かめる**作りだからである。実在しないテーブルを `RetentionTarget` に
 * 足せば落ちるが、**テーブルがあるのに足していないことは検出されない。**
 * #270（`ops.admin.*` が登録簿に無く保持区分が付かなかった）と同じ向きで、
 * **検査が「列挙されたもの」の中だけで整合を取ると、列挙されていないものは
 * 最初から対象外になる。**
 *
 * そこで向きを逆にする —— **スキーマのほうから数える。**
 * `expires_at` を持つテーブルは「いつか用済みになる行」を持つということなので、
 * 保持期間が決まっていなければならない。決まっていない = 無期限（#174）。
 *
 * ## 件数を表に出す
 *
 * 0 件を検査して通る検査は、合格と沈黙が同じ形で出てくる。実際このリポジトリで
 * 何度か踏んでいるので、**何件見たか**を明示して、空振りを空振りとして読める
 * ようにしておく。
 */
/**
 * スキーマに含まれる全テーブル。`@u18/db` は名前空間ごと公開している。
 *
 * **`unknown[]` を経由する。** 名前空間はテーブル以外（`timestampMs` などの
 * 列ヘルパー関数）も公開しているので、戻り値の合併型に関数が混ざる。
 * そのまま型述語で絞ると「述語の型が引数の型に代入できない」と言われる。
 */
function allSchemaTables(): SQLiteTable[] {
  const tables: SQLiteTable[] = [];
  for (const value of Object.values(schema) as unknown[]) {
    if (is(value, SQLiteTable)) tables.push(value);
  }
  return tables;
}

describe("保持期限の網羅", () => {
  const allTables = allSchemaTables();

  /** `expires_at` 列を持つテーブル＝「いつか用済みになる行」を持つテーブル。 */
  const withExpiry = allTables
    .filter((table) => Object.values(getTableColumns(table)).some((c) => c.name === "expires_at"))
    .map((table) => getTableName(table))
    .sort();

  it("スキーマを実際に走査できている", () => {
    // **この検査が空振りしていないこと自体を先に固定する。** 走査が 0 件を
    // 返すと、下のテストは「すべて網羅されている」と報告して通ってしまう。
    expect(allTables.length).toBeGreaterThan(5);
    expect(withExpiry.length).toBeGreaterThan(0);
  });

  it("expires_at を持つテーブルはすべて保持期間が決まっている", () => {
    const covered = Object.keys(RetentionPolicy);
    const missing = withExpiry.filter((name) => !covered.includes(name));

    expect(
      missing,
      `${withExpiry.length} 件の期限付きテーブルを見た。保持期間が無いもの: ${missing.join(", ") || "なし"}`,
    ).toEqual([]);
  });

  it("保持期間が決まっているテーブルはスキーマに実在する", () => {
    // 逆向き。消したテーブルの名前が `RetentionPolicy` に残ると、掃除は
    // 毎回そのテーブルで失敗し、`failed` に入り続ける。
    const names = allTables.map((table) => getTableName(table));
    const ghosts = Object.keys(RetentionPolicy).filter((target) => !names.includes(target));

    expect(ghosts).toEqual([]);
  });
});

/**
 * **「掃除しない」が宣言されていること**（#301）。
 *
 * 上の「保持期限の網羅」は `expires_at` を持つテーブルしか見ない。
 * つまり**期限列を持たないテーブルを足した人は、保持期間について
 * 一言も問われない。** `oauth_grants`（期限を持たない継続中の同意）が
 * まさにそれで、「掃除しない」はコメントの散文にしか無かった ——
 * 読めば正しいが、**機械からは「判断済み」と「まだ誰も考えていない」が
 * 同じ形に見える。**
 *
 * `signing_key_metadata` も同じ理由で抜けていた。あちらは `retires_at` を
 * 持つが、**列名が `expires_at` ではない**ので検査の視野に入らない。
 *
 * そこで `RetentionPolicy` と `NEVER_SWEPT` で**全テーブルをちょうど 1 回
 * ずつ覆う**ことにし、分類されていないテーブルで落とす。
 *
 * ## 防げないこと
 *
 * **分類を間違えることは防げない。** 防げるのは分類を忘れることだけで、
 * 掃除対象へ移すときに理由の 1 行が差分から消える、までである。
 */
describe("掃除の対象外であることの宣言", () => {
  /** 実スキーマのテーブルを、規則が受け取る形に直したもの。 */
  const actual = allSchemaTables().map((table) => ({
    name: getTableName(table),
    hasExpiry: Object.values(getTableColumns(table)).some((c) => c.name === "expires_at"),
  }));

  it("全テーブルがどちらかに分類されている", () => {
    const gaps = retentionClassificationGaps(actual);

    expect(
      gaps.unclassified,
      `${actual.length} 本のテーブルを見た。掃除するともしないとも書かれていないもの: ${
        gaps.unclassified.join(", ") || "なし"
      }`,
    ).toEqual([]);
    expect(gaps.classifiedTwice).toEqual([]);
    expect(gaps.expiringButNotSwept).toEqual([]);
    expect(gaps.unknownTables).toEqual([]);
  });

  it("分類の両側に中身がある", () => {
    // 片方が空のまま「穴はありません」と言う形を塞ぐ。
    expect(Object.keys(RetentionPolicy).length).toBeGreaterThan(0);
    expect(Object.keys(NEVER_SWEPT).length).toBeGreaterThan(0);
    expect(actual.length).toBe(
      Object.keys(RetentionPolicy).length + Object.keys(NEVER_SWEPT).length,
    );
  });

  it("掃除しない側には理由が書いてある", () => {
    // 中身までは機械が読めない。空文字だけを弾く。
    const blank = Object.entries(NEVER_SWEPT)
      .filter(([, reason]) => reason.trim() === "")
      .map(([name]) => name);

    expect(blank).toEqual([]);
  });

  /**
   * ここから下は**規則そのもの**を作り物で確かめる。
   *
   * 実スキーマだけを相手にすると、規則が何も見ていなくても
   * 「穴はありません」と出る。4 つの穴を 1 つずつ実際に開けて、
   * **その穴が報告されること**を固定する。
   */
  describe("規則が穴を見つけられる", () => {
    const tables = [
      { name: "swept_one", hasExpiry: true },
      { name: "kept_one", hasExpiry: false },
    ];
    const classification = { swept: ["swept_one"], kept: ["kept_one"] };

    it("穴が無ければ何も報告しない", () => {
      expect(retentionClassificationGaps(tables, classification)).toEqual({
        unclassified: [],
        classifiedTwice: [],
        expiringButNotSwept: [],
        unknownTables: [],
      });
    });

    it("どちらにも書かれていないテーブルを報告する", () => {
      // **新しいテーブルを足した人が、期限列を持たないせいで
      // 何も問われない**という #301 の本体。
      const gaps = retentionClassificationGaps(
        [...tables, { name: "brand_new", hasExpiry: false }],
        classification,
      );

      expect(gaps.unclassified).toEqual(["brand_new"]);
    });

    it("両方に書かれているテーブルを報告する", () => {
      const gaps = retentionClassificationGaps(tables, {
        swept: ["swept_one", "kept_one"],
        kept: ["kept_one"],
      });

      expect(gaps.classifiedTwice).toEqual(["kept_one"]);
    });

    it("期限列を持つテーブルを「掃除しない」側に置けない", () => {
      // **これが無いと `NEVER_SWEPT` が #279 の抜け道になる。**
      // 期限付きのテーブルを「掃除しない」側に書くだけで、
      // 上の「保持期限の網羅」は分類済みとして黙る。
      const gaps = retentionClassificationGaps(
        [{ name: "kept_one", hasExpiry: true }],
        classification,
      );

      expect(gaps.expiringButNotSwept).toEqual(["kept_one"]);
    });

    it("実在しないテーブルの名前を報告する", () => {
      const gaps = retentionClassificationGaps(tables, {
        swept: ["swept_one", "ghost_table"],
        kept: ["kept_one"],
      });

      expect(gaps.unknownTables).toEqual(["ghost_table"]);
    });
  });
});

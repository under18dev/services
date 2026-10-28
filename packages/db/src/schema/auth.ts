import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { createdAt, secretHash, timestampMs, updatedAt } from "./_shared";
import { users } from "./users";

/**
 * WebAuthn Credential。
 *
 * 公開鍵とサインカウンターだけを保存する。秘密鍵は認証器から出てこない。
 */
export const passkeys = sqliteTable(
  "passkeys",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** 認証器が発行した Credential ID（base64url）。RP 全体で一意。 */
    credentialId: text("credential_id").notNull(),
    /** COSE 形式の公開鍵（base64url）。 */
    publicKey: text("public_key").notNull(),
    /**
     * サインカウンター。認証のたびに単調増加するはずで、巻き戻りは
     * Credential の複製を示唆するため検証で弾く（仕様書 9 WebAuthn）。
     */
    counter: integer("counter").notNull().default(0),
    /** 認証器の AAGUID。機種の識別と、必要なら許可リスト判定に使う。 */
    aaguid: text("aaguid"),
    /** "platform" | "cross-platform"。UI の表示に使う。 */
    deviceType: text("device_type"),
    /** 複数デバイスに同期される Credential か（パスキーのバックアップ状態）。 */
    backedUp: integer("backed_up", { mode: "boolean" }).notNull().default(false),
    /** 認証器が申告したトランスポート（JSON 配列文字列）。 */
    transports: text("transports"),
    /** ユーザーが識別するための名前。 */
    label: text("label"),
    lastUsedAt: timestampMs("last_used_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("passkeys_credential_id_unique").on(table.credentialId),
    index("passkeys_user_idx").on(table.userId),
  ],
);

/**
 * WebAuthn の Challenge。
 *
 * 登録・認証の options 発行時に保存し、verify で単回消費する。
 * Challenge を保存せずにクライアント申告を信じると、リプレイを防げない。
 */
export const webauthnChallenges = sqliteTable(
  "webauthn_challenges",
  {
    id: text("id").primaryKey(),
    /** 登録フローでは確定済み、認証フロー（discoverable）では null。 */
    userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
    challenge: text("challenge").notNull(),
    purpose: text("purpose", { enum: ["registration", "authentication"] }).notNull(),
    expiresAt: timestampMs("expires_at").notNull(),
    consumedAt: timestampMs("consumed_at"),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("webauthn_challenges_challenge_unique").on(table.challenge),
    index("webauthn_challenges_expires_idx").on(table.expiresAt),
  ],
);

/**
 * メール OTP。
 *
 * コードはハッシュのみ保存し、試行回数の上限と単回使用を DB 側で保証する
 * （仕様書 5.3 / 7.3）。
 */
export const emailChallenges = sqliteTable(
  "email_challenges",
  {
    id: text("id").primaryKey(),
    /** 新規登録時はまだ user が存在しないので null を許す。 */
    userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    /** OTP そのものではなくハッシュ。 */
    codeHash: secretHash("code_hash"),
    purpose: text("purpose", { enum: ["login", "signup", "verify_email", "recovery"] }).notNull(),
    expiresAt: timestampMs("expires_at").notNull(),
    attemptCount: integer("attempt_count").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(5),
    consumedAt: timestampMs("consumed_at"),
    /**
     * **使われていない。** 再送上限は「窓の中に作られた行数」で判定する
     * （`OtpPolicy.resendWindowMs`、`StartEmailOtpUseCase`）。
     *
     * この列で数える設計だったが、送信のたびに `invalidateActive()` →`create()`
     * で**新しい行を作る**ため、カウンタは常に新しい行の 0 に戻っていた。
     * 2 つの設計が噛み合わず、上限が一度も発動しなかった（#88）。
     *
     * 列を残してあるのは、D1 での `DROP COLUMN` を #88 の修正と同じ変更に
     * 入れたくなかったからに過ぎない。**読まない。書かない。**
     * ここから再送回数を読もうとしているコードを見かけたら、それは bug。
     */
    resendCount: integer("resend_count").notNull().default(0),
    lastSentAt: timestampMs("last_sent_at"),
    createdAt: createdAt(),
  },
  (table) => [
    /**
     * **`(email, purpose)` はここに無い（#245 で落とした）。**
     *
     * このテーブルを email で引く経路（`countSentSince` /
     * `invalidateActive` / `consume`）は**すべて `lower(email)` を
     * 掛けている**ので、生の `email` 列の索引は選ばれない。本番の
     * `EXPLAIN QUERY PLAN` でも 3 クエリとも別の索引を使っていた。
     *
     * **`lower()` を外して索引に合わせる、はできない。** `EmailAddress`
     * （`packages/domain`）はドメイン部だけ小文字化し local 部は残す ——
     * 「別人のアドレスを同一視しない」という明示的な判断である。一方
     * ここの `lower()` は、大文字小文字を変えて再送上限を回避されるのを
     * 防いでいる。**同じリポジトリの 2 箇所が、意図して違う同一視をして
     * いる。** 片方に寄せると、もう片方の判断が壊れる。
     *
     * **式インデックス（`lower(email), purpose`）も足していない。**
     * プランナは既に `(purpose, created_at)` を選んでおり、乗り換える
     * 保証が無い。足してから計画を見ないと**使われない索引が 2 本**に
     * なる。保持期限は 1 時間で行数も少なく、**性能上の問題は観測されて
     * いない** —— 直したかったのは宣言と実態のずれだけである。
     *
     * 足したくなったら、まず `email-challenge.repository.test.ts` の
     * 「どの索引が効いているか」を読むこと。
     */
    index("email_challenges_expires_idx").on(table.expiresAt),
    /**
     * 用途ごとの総量を数えるため（#236）。
     *
     * `WHERE purpose = ? AND created_at > ?` の count がこれだけで閉じる。
     * 上の `(email, purpose)` は**先頭列が email なので purpose 単独の
     * 絞り込みには効かない。**
     *
     * **これでも消えない性質がある。** 数えるのは「直近 1 時間に作られた
     * 行」なので、**大量送信が起きている最中ほどスキャンするエントリが
     * 増える。** いちばん重くなってほしくないときにいちばん重い。
     * インデックスが改善するのは定数倍だけで、そこは引き受けている。
     */
    index("email_challenges_purpose_created_idx").on(table.purpose, table.createdAt),
  ],
);

/**
 * ブラウザセッション。
 *
 * Cookie に入る値はハッシュして保存する。DB が漏れてもセッションを
 * そのまま使われないようにするため（仕様書 7.1）。
 */
export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: secretHash("token_hash"),
    expiresAt: timestampMs("expires_at").notNull(),
    /** サーバー側失効の時刻。null なら有効。 */
    revokedAt: timestampMs("revoked_at"),
    /** どの方式でこのセッションを得たか。再認証要否の判断に使う。 */
    authMethod: text("auth_method", { enum: ["passkey", "email_otp"] }).notNull(),
    /** 直近のアクセス時刻。セッション一覧 UI に出す。 */
    lastSeenAt: timestampMs("last_seen_at").notNull(),
    userAgent: text("user_agent"),
    /** 生 IP ではなくハッシュを保存する（仕様書 9 Privacy）。 */
    ipHash: text("ip_hash"),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("sessions_token_hash_unique").on(table.tokenHash),
    index("sessions_user_idx").on(table.userId),
    index("sessions_expires_idx").on(table.expiresAt),
  ],
);

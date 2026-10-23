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
    /** 再送制限の判定に使う。 */
    resendCount: integer("resend_count").notNull().default(0),
    lastSentAt: timestampMs("last_sent_at"),
    createdAt: createdAt(),
  },
  (table) => [
    index("email_challenges_email_purpose_idx").on(table.email, table.purpose),
    index("email_challenges_expires_idx").on(table.expiresAt),
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

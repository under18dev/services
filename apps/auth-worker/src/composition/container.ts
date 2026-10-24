import { createIdentityDatabase, type IdentityDatabase } from "@u18/db";
import { systemClock } from "@u18/domain";
import type { AuditLogger } from "../application/ports/audit-log.port";
import type { AuthorizationCodeRepository } from "../application/ports/authorization-code.repository";
import type { Clock } from "../application/ports/clock.port";
import type {
  ConstantTimeComparator,
  IpHasher,
  PkceVerifier,
  RandomTokenGenerator,
  TokenHasher,
} from "../application/ports/crypto.port";
import type { EmailChallengeRepository } from "../application/ports/email-challenge.repository";
import type { EmailSender } from "../application/ports/email-sender.port";
import type { DatabaseProbe } from "../application/ports/health.port";
import type { IdTokenIssuer } from "../application/ports/id-token.port";
import type { OAuthClientRepository } from "../application/ports/oauth-client.repository";
import type { OAuthGrantRepository } from "../application/ports/oauth-grant.repository";
import type { OAuthTokenRepository } from "../application/ports/oauth-token.repository";
import type { PasskeyRepository } from "../application/ports/passkey.repository";
import type { ExpiredRecordPurger } from "../application/ports/retention.port";
import type { SessionRepository } from "../application/ports/session.repository";
import type { SigningKeyProvider } from "../application/ports/signing-key.port";
import type { UserRepository } from "../application/ports/user.repository";
import type { WebAuthnChallengeRepository } from "../application/ports/webauthn-challenge.repository";
import type { WebAuthnService } from "../application/ports/webauthn.port";
import { AuthenticateOAuthClientUseCase } from "../application/use-cases/authenticate-oauth-client.use-case";
import { AuthorizeRequestUseCase } from "../application/use-cases/authorize-request.use-case";
import { ExchangeAuthorizationCodeUseCase } from "../application/use-cases/exchange-authorization-code.use-case";
import { IssueAuthorizationCodeUseCase } from "../application/use-cases/issue-authorization-code.use-case";
import { DeletePasskeyUseCase } from "../application/use-cases/delete-passkey.use-case";
import { GetSessionUseCase } from "../application/use-cases/get-session.use-case";
import { IssueSessionUseCase } from "../application/use-cases/issue-session.use-case";
import { LogoutUseCase } from "../application/use-cases/logout.use-case";
import { StartEmailOtpUseCase } from "../application/use-cases/start-email-otp.use-case";
import { VerifyEmailOtpUseCase } from "../application/use-cases/verify-email-otp.use-case";
import { ListPasskeysUseCase } from "../application/use-cases/list-passkeys.use-case";
import { ListSessionsUseCase } from "../application/use-cases/list-sessions.use-case";
import { PasskeyLoginOptionsUseCase } from "../application/use-cases/passkey-login-options.use-case";
import { PasskeyLoginVerifyUseCase } from "../application/use-cases/passkey-login-verify.use-case";
import { PasskeyRegisterOptionsUseCase } from "../application/use-cases/passkey-register-options.use-case";
import { PasskeyRegisterVerifyUseCase } from "../application/use-cases/passkey-register-verify.use-case";
import { PurgeExpiredRecordsUseCase } from "../application/use-cases/purge-expired-records.use-case";
import { ResolveOAuthClientUseCase } from "../application/use-cases/resolve-oauth-client.use-case";
import { RevokeSessionUseCase } from "../application/use-cases/revoke-session.use-case";
import { UpdateProfileUseCase } from "../application/use-cases/update-profile.use-case";
import { JoseIdTokenIssuer } from "../infrastructure/crypto/jose-id-token-signer";
import { JoseSigningKeyProvider } from "../infrastructure/crypto/jose-signing-key";
import {
  PepperedIpHasher,
  UnconfiguredIpHasher,
  Sha256TokenHasher,
  TimingSafeComparator,
  WebCryptoPkceVerifier,
  WebCryptoTokenGenerator,
} from "../infrastructure/crypto/web-crypto";
import { CloudflareEmailSender } from "../infrastructure/email/cloudflare-email-sender";
import { ConsoleEmailSender } from "../infrastructure/email/console-email-sender";
import { UnconfiguredEmailSender } from "../infrastructure/email/unconfigured-email-sender";
import { DrizzleAuditLogger } from "../infrastructure/persistence/drizzle-audit-logger";
import { DrizzleAuthorizationCodeRepository } from "../infrastructure/persistence/drizzle-authorization-code.repository";
import { DrizzleEmailChallengeRepository } from "../infrastructure/persistence/drizzle-email-challenge.repository";
import { DrizzleExpiredRecordPurger } from "../infrastructure/persistence/drizzle-expired-record-purger";
import { DrizzleDatabaseProbe } from "../infrastructure/persistence/drizzle-database-probe";
import { DrizzleOAuthClientRepository } from "../infrastructure/persistence/drizzle-oauth-client.repository";
import { DrizzleOAuthGrantRepository } from "../infrastructure/persistence/drizzle-oauth-grant.repository";
import { DrizzleOAuthTokenRepository } from "../infrastructure/persistence/drizzle-oauth-token.repository";
import { DrizzlePasskeyRepository } from "../infrastructure/persistence/drizzle-passkey.repository";
import { DrizzleSessionRepository } from "../infrastructure/persistence/drizzle-session.repository";
import { DrizzleSigningKeyMetadataRepository } from "../infrastructure/persistence/drizzle-signing-key-metadata.repository";
import { DrizzleUserRepository } from "../infrastructure/persistence/drizzle-user.repository";
import { DrizzleWebAuthnChallengeRepository } from "../infrastructure/persistence/drizzle-webauthn-challenge.repository";
import { SimpleWebAuthnService } from "../infrastructure/webauthn/simplewebauthn.service";

/**
 * 依存性の組み立て（仕様書 2.3）。
 *
 * Cloudflare の `Env` を知ってよいのはこの層だけ。Application / Domain からは
 * Port の型しか見えない。
 */
export type Container = {
  readonly db: IdentityDatabase;
  readonly clock: Clock;
  readonly repositories: {
    readonly users: UserRepository;
    readonly sessions: SessionRepository;
    readonly emailChallenges: EmailChallengeRepository;
    readonly passkeys: PasskeyRepository;
    readonly webauthnChallenges: WebAuthnChallengeRepository;
    readonly oauthClients: OAuthClientRepository;
    readonly oauthGrants: OAuthGrantRepository;
    readonly oauthTokens: OAuthTokenRepository;
    readonly authorizationCodes: AuthorizationCodeRepository;
  };
  readonly services: {
    readonly hasher: TokenHasher;
    readonly ipHasher: IpHasher;
    readonly tokens: RandomTokenGenerator;
    readonly comparator: ConstantTimeComparator;
    readonly pkce: PkceVerifier;
    readonly email: EmailSender;
    readonly audit: AuditLogger;
    readonly databaseProbe: DatabaseProbe;
    readonly webauthn: WebAuthnService;
    readonly signingKeys: SigningKeyProvider;
    readonly purger: ExpiredRecordPurger;
    readonly idTokens: IdTokenIssuer;
  };
  readonly useCases: {
    readonly getSession: GetSessionUseCase;
    readonly issueSession: IssueSessionUseCase;
    readonly startEmailOtp: StartEmailOtpUseCase;
    readonly verifyEmailOtp: VerifyEmailOtpUseCase;
    readonly logout: LogoutUseCase;
    readonly listSessions: ListSessionsUseCase;
    readonly revokeSession: RevokeSessionUseCase;
    readonly updateProfile: UpdateProfileUseCase;
    readonly listPasskeys: ListPasskeysUseCase;
    readonly deletePasskey: DeletePasskeyUseCase;
    readonly passkeyRegisterOptions: PasskeyRegisterOptionsUseCase;
    readonly passkeyRegisterVerify: PasskeyRegisterVerifyUseCase;
    readonly passkeyLoginOptions: PasskeyLoginOptionsUseCase;
    readonly passkeyLoginVerify: PasskeyLoginVerifyUseCase;
    readonly resolveOAuthClient: ResolveOAuthClientUseCase;
    readonly authenticateOAuthClient: AuthenticateOAuthClientUseCase;
    readonly purgeExpiredRecords: PurgeExpiredRecordsUseCase;
    readonly authorizeRequest: AuthorizeRequestUseCase;
    readonly issueAuthorizationCode: IssueAuthorizationCodeUseCase;
    readonly exchangeAuthorizationCode: ExchangeAuthorizationCodeUseCase;
  };
};

export type ContainerOverrides = Partial<{
  clock: Clock;
  users: UserRepository;
  sessions: SessionRepository;
  emailChallenges: EmailChallengeRepository;
  audit: AuditLogger;
  email: EmailSender;
  databaseProbe: DatabaseProbe;
  oauthClients: OAuthClientRepository;
  signingKeys: SigningKeyProvider;
  purger: ExpiredRecordPurger;
  idTokens: IdTokenIssuer;
}>;

/**
 * リクエストごとにコンテナを作る。
 *
 * Workers では `Env` がリクエスト単位で渡るため、モジュールスコープに
 * キャッシュしない。生成コストはオブジェクト確保のみで、D1 への接続は張らない。
 */
export function createContainer(env: Env, overrides: ContainerOverrides = {}): Container {
  const db = createIdentityDatabase(env.IDENTITY_DB);
  const clock = overrides.clock ?? systemClock;

  const users = overrides.users ?? new DrizzleUserRepository(db);
  const sessions = overrides.sessions ?? new DrizzleSessionRepository(db);
  const passkeys = new DrizzlePasskeyRepository(db);
  const webauthnChallenges = new DrizzleWebAuthnChallengeRepository(db);
  const audit = overrides.audit ?? new DrizzleAuditLogger(db);
  const emailChallenges = overrides.emailChallenges ?? new DrizzleEmailChallengeRepository(db);
  const databaseProbe = overrides.databaseProbe ?? new DrizzleDatabaseProbe(db);
  // 保持期限を過ぎた行の掃除（#43）。scheduled ハンドラからしか使わないが、
  // Port の配線先はここ 1 箇所に揃える。
  const purger = overrides.purger ?? new DrizzleExpiredRecordPurger(db);

  const hasher = new Sha256TokenHasher();
  // pepper が無いまま本番が動くと IPv4 空間は総当たり可能で、ハッシュが
  // 匿名化として機能しない。静かに既定値へ落ちるのは防ぐ（仕様書 9 Privacy）。
  //
  // ただし失敗はハッシュ化の時点まで遅らせる。組み立てで throw すると
  // メールと同様、無関係な /health まで 500 になる（#53）。
  const ipHasher =
    env.IP_HASH_PEPPER !== undefined
      ? new PepperedIpHasher(env.IP_HASH_PEPPER)
      : env.ENVIRONMENT === "development"
        ? new PepperedIpHasher("dev-pepper")
        : new UnconfiguredIpHasher("IP_HASH_PEPPER is not set outside development");
  const tokens = new WebCryptoTokenGenerator();
  const comparator = new TimingSafeComparator();
  // PKCE の比較も定時間で行う（#16）。`TokenHasher` と分けているのは、
  // 保存用ハッシュが 16 進で code_challenge が base64url と符号化が違うため。
  const pkce = new WebCryptoPkceVerifier(comparator);

  // メール送信は Cloudflare Email Sending を使う（#35）。
  //
  // development でバインディングが無い場合だけ ConsoleEmailSender に落とす。
  // それ以外の環境でバインディングが無いまま起動すると、OTP がログに出るか
  // 送信自体が静かに失敗するので、起動を止める。
  const email = overrides.email ?? createEmailSender(env);

  // Origin / RP ID は設定から決まるので、ここで 1 度だけ束ねて Port に閉じ込める。
  // 検証パラメータをルートや UseCase へ配らない（仕様書 9 WebAuthn）。
  const webauthn = new SimpleWebAuthnService({
    rpId: env.RP_ID,
    rpName: env.RP_NAME,
    origin: env.WEBAUTHN_ORIGIN,
  });

  // OAuth クライアント（#13）。client_secret の照合をこの Repository の中に
  // 閉じ込めるため、ハッシュ化と定時間比較を注入する。
  const oauthClients =
    overrides.oauthClients ?? new DrizzleOAuthClientRepository(db, hasher, comparator);
  const oauthGrants = new DrizzleOAuthGrantRepository(db);
  const oauthTokens = new DrizzleOAuthTokenRepository(db);
  const authorizationCodes = new DrizzleAuthorizationCodeRepository(db);

  // ID Token の署名鍵（#14）。秘密鍵は D1 ではなく Workers Secret から読む（仕様書 7.1）。
  const signingKeys = overrides.signingKeys ?? createSigningKeyProvider(env, db, clock);
  // 署名そのものは Port の向こう側に置き、`alg` を選ぶコードを Application へ
  // 出さない（application/ports/id-token.port.ts のコメント）。
  const idTokens = overrides.idTokens ?? new JoseIdTokenIssuer(signingKeys);

  const getSession = new GetSessionUseCase({ sessions, users, hasher, clock, audit });
  const resolveOAuthClient = new ResolveOAuthClientUseCase({ clients: oauthClients, audit });
  const issueSession = new IssueSessionUseCase({
    users,
    sessions,
    hasher,
    ipHasher,
    tokens,
    clock,
    audit,
  });

  return {
    db,
    clock,
    repositories: {
      users,
      sessions,
      emailChallenges,
      passkeys,
      webauthnChallenges,
      oauthClients,
      oauthGrants,
      oauthTokens,
      authorizationCodes,
    },
    services: {
      hasher,
      ipHasher,
      tokens,
      comparator,
      pkce,
      email,
      audit,
      databaseProbe,
      webauthn,
      signingKeys,
      purger,
      idTokens,
    },
    useCases: {
      getSession,
      issueSession,
      startEmailOtp: new StartEmailOtpUseCase({
        users,
        challenges: emailChallenges,
        email,
        hasher,
        tokens,
        clock,
        audit,
      }),
      verifyEmailOtp: new VerifyEmailOtpUseCase({
        users,
        challenges: emailChallenges,
        issueSession,
        hasher,
        clock,
        audit,
      }),
      logout: new LogoutUseCase({ sessions, codes: authorizationCodes, hasher, clock, audit }),
      listSessions: new ListSessionsUseCase({ getSession, sessions, clock }),
      revokeSession: new RevokeSessionUseCase({
        getSession,
        sessions,
        codes: authorizationCodes,
        clock,
        audit,
      }),
      updateProfile: new UpdateProfileUseCase({ getSession, users, clock, audit }),
      listPasskeys: new ListPasskeysUseCase({ getSession, passkeys }),
      deletePasskey: new DeletePasskeyUseCase({ getSession, passkeys, clock, audit }),
      passkeyRegisterOptions: new PasskeyRegisterOptionsUseCase({
        getSession,
        users,
        passkeys,
        challenges: webauthnChallenges,
        webauthn,
        clock,
      }),
      passkeyRegisterVerify: new PasskeyRegisterVerifyUseCase({
        getSession,
        passkeys,
        challenges: webauthnChallenges,
        webauthn,
        clock,
        audit,
      }),
      passkeyLoginOptions: new PasskeyLoginOptionsUseCase({
        challenges: webauthnChallenges,
        webauthn,
        clock,
      }),
      passkeyLoginVerify: new PasskeyLoginVerifyUseCase({
        issueSession,
        users,
        passkeys,
        challenges: webauthnChallenges,
        webauthn,
        clock,
        audit,
      }),
      resolveOAuthClient,
      authenticateOAuthClient: new AuthenticateOAuthClientUseCase({ clients: oauthClients, audit }),
      purgeExpiredRecords: new PurgeExpiredRecordsUseCase({ purger, clock, audit }),
      authorizeRequest: new AuthorizeRequestUseCase({
        resolveClient: resolveOAuthClient,
        getSession,
        users,
        grants: oauthGrants,
        clock,
        audit,
      }),
      issueAuthorizationCode: new IssueAuthorizationCodeUseCase({
        codes: authorizationCodes,
        grants: oauthGrants,
        tokens,
        hasher,
        clock,
        audit,
      }),
      exchangeAuthorizationCode: new ExchangeAuthorizationCodeUseCase({
        codes: authorizationCodes,
        grants: oauthGrants,
        tokens: oauthTokens,
        users,
        idTokens,
        hasher,
        random: tokens,
        pkce,
        clock,
        audit,
      }),
    },
  };
}

function createEmailSender(env: Env): EmailSender {
  if (env.EMAIL !== undefined) {
    return new CloudflareEmailSender(env.EMAIL, env.EMAIL_FROM);
  }
  if (env.ENVIRONMENT === "development") {
    return new ConsoleEmailSender();
  }
  // ここで throw しない。コンテナはリクエストごとに組み立てられるので、
  // 投げると /health や Discovery まで 500 になる（#53）。
  // OTP を送ろうとした時点で失敗させる。
  return new UnconfiguredEmailSender("EMAIL binding is missing outside development");
}

/**
 * 署名鍵の提供元を組み立てる（#14）。
 *
 * Secret が欠けていても **ここでは throw しない。** メール送信や IP ハッシュと
 * 同じ理由（#53）に加えて、JWKS には固有の事情がある。JWKS は
 * `signing_key_metadata` だけで応答できるので、秘密鍵の設定漏れで
 * 公開鍵の配布まで止める理由がない。むしろ鍵を入れ替える最中に JWKS が
 * 落ちると、旧鍵で署名済みのトークンを検証している RP を巻き込む。
 * 失敗させるのは署名しようとした時点（`getActiveSigningKey`）に限る。
 *
 * `SIGNING_KEY_JWK` と `SIGNING_KEY_KID` は必ず対で揃っていること。片方だけでは
 * 「どの kid の鍵か」が決まらず、JWKS と照合できない ID Token を発行することになる
 * （docs/runbook.md 4.2 ステップ 4 が両者を数秒以内に更新せよと書いているのはこのため）。
 */
function createSigningKeyProvider(
  env: Env,
  db: IdentityDatabase,
  clock: Clock,
): SigningKeyProvider {
  const metadata = new DrizzleSigningKeyMetadataRepository(db);
  const configured =
    env.SIGNING_KEY_JWK !== undefined && env.SIGNING_KEY_KID !== undefined
      ? { jwk: env.SIGNING_KEY_JWK, kid: env.SIGNING_KEY_KID }
      : null;

  return new JoseSigningKeyProvider(
    metadata,
    clock,
    configured,
    "SIGNING_KEY_JWK and SIGNING_KEY_KID must both be set",
  );
}

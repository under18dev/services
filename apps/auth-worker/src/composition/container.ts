import { createIdentityDatabase, type IdentityDatabase } from "@u18/db";
import { systemClock } from "@u18/domain";
import type { AuditLogger } from "../application/ports/audit-log.port";
import type { Clock } from "../application/ports/clock.port";
import type {
  ConstantTimeComparator,
  IpHasher,
  RandomTokenGenerator,
  TokenHasher,
} from "../application/ports/crypto.port";
import type { EmailChallengeRepository } from "../application/ports/email-challenge.repository";
import type { EmailSender } from "../application/ports/email-sender.port";
import type { DatabaseProbe } from "../application/ports/health.port";
import type { PasskeyRepository } from "../application/ports/passkey.repository";
import type { SessionRepository } from "../application/ports/session.repository";
import type { UserRepository } from "../application/ports/user.repository";
import type { WebAuthnChallengeRepository } from "../application/ports/webauthn-challenge.repository";
import type { WebAuthnService } from "../application/ports/webauthn.port";
import { GetSessionUseCase } from "../application/use-cases/get-session.use-case";
import { IssueSessionUseCase } from "../application/use-cases/issue-session.use-case";
import { LogoutUseCase } from "../application/use-cases/logout.use-case";
import { StartEmailOtpUseCase } from "../application/use-cases/start-email-otp.use-case";
import { VerifyEmailOtpUseCase } from "../application/use-cases/verify-email-otp.use-case";
import { ListSessionsUseCase } from "../application/use-cases/list-sessions.use-case";
import { PasskeyLoginOptionsUseCase } from "../application/use-cases/passkey-login-options.use-case";
import { PasskeyLoginVerifyUseCase } from "../application/use-cases/passkey-login-verify.use-case";
import { PasskeyRegisterOptionsUseCase } from "../application/use-cases/passkey-register-options.use-case";
import { PasskeyRegisterVerifyUseCase } from "../application/use-cases/passkey-register-verify.use-case";
import { RevokeSessionUseCase } from "../application/use-cases/revoke-session.use-case";
import {
  PepperedIpHasher,
  UnconfiguredIpHasher,
  Sha256TokenHasher,
  TimingSafeComparator,
  WebCryptoTokenGenerator,
} from "../infrastructure/crypto/web-crypto";
import { CloudflareEmailSender } from "../infrastructure/email/cloudflare-email-sender";
import { ConsoleEmailSender } from "../infrastructure/email/console-email-sender";
import { UnconfiguredEmailSender } from "../infrastructure/email/unconfigured-email-sender";
import { DrizzleAuditLogger } from "../infrastructure/persistence/drizzle-audit-logger";
import { DrizzleEmailChallengeRepository } from "../infrastructure/persistence/drizzle-email-challenge.repository";
import { DrizzleDatabaseProbe } from "../infrastructure/persistence/drizzle-database-probe";
import { DrizzlePasskeyRepository } from "../infrastructure/persistence/drizzle-passkey.repository";
import { DrizzleSessionRepository } from "../infrastructure/persistence/drizzle-session.repository";
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
  };
  readonly services: {
    readonly hasher: TokenHasher;
    readonly ipHasher: IpHasher;
    readonly tokens: RandomTokenGenerator;
    readonly comparator: ConstantTimeComparator;
    readonly email: EmailSender;
    readonly audit: AuditLogger;
    readonly databaseProbe: DatabaseProbe;
    readonly webauthn: WebAuthnService;
  };
  readonly useCases: {
    readonly getSession: GetSessionUseCase;
    readonly issueSession: IssueSessionUseCase;
    readonly startEmailOtp: StartEmailOtpUseCase;
    readonly verifyEmailOtp: VerifyEmailOtpUseCase;
    readonly logout: LogoutUseCase;
    readonly listSessions: ListSessionsUseCase;
    readonly revokeSession: RevokeSessionUseCase;
    readonly passkeyRegisterOptions: PasskeyRegisterOptionsUseCase;
    readonly passkeyRegisterVerify: PasskeyRegisterVerifyUseCase;
    readonly passkeyLoginOptions: PasskeyLoginOptionsUseCase;
    readonly passkeyLoginVerify: PasskeyLoginVerifyUseCase;
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

  const getSession = new GetSessionUseCase({ sessions, users, hasher, clock, audit });
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
    repositories: { users, sessions, emailChallenges, passkeys, webauthnChallenges },
    services: {
      hasher,
      ipHasher,
      tokens,
      comparator,
      email,
      audit,
      databaseProbe,
      webauthn,
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
      logout: new LogoutUseCase({ sessions, hasher, clock, audit }),
      listSessions: new ListSessionsUseCase({ getSession, sessions, clock }),
      revokeSession: new RevokeSessionUseCase({ getSession, sessions, clock, audit }),
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

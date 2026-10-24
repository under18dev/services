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
import type { EmailSender } from "../application/ports/email-sender.port";
import type { DatabaseProbe } from "../application/ports/health.port";
import type { SessionRepository } from "../application/ports/session.repository";
import type { UserRepository } from "../application/ports/user.repository";
import { GetSessionUseCase } from "../application/use-cases/get-session.use-case";
import { IssueSessionUseCase } from "../application/use-cases/issue-session.use-case";
import { LogoutUseCase } from "../application/use-cases/logout.use-case";
import { ListSessionsUseCase } from "../application/use-cases/list-sessions.use-case";
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
import { DrizzleDatabaseProbe } from "../infrastructure/persistence/drizzle-database-probe";
import { DrizzleSessionRepository } from "../infrastructure/persistence/drizzle-session.repository";
import { DrizzleUserRepository } from "../infrastructure/persistence/drizzle-user.repository";

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
  };
  readonly services: {
    readonly hasher: TokenHasher;
    readonly ipHasher: IpHasher;
    readonly tokens: RandomTokenGenerator;
    readonly comparator: ConstantTimeComparator;
    readonly email: EmailSender;
    readonly audit: AuditLogger;
    readonly databaseProbe: DatabaseProbe;
  };
  readonly useCases: {
    readonly getSession: GetSessionUseCase;
    readonly issueSession: IssueSessionUseCase;
    readonly logout: LogoutUseCase;
    readonly listSessions: ListSessionsUseCase;
    readonly revokeSession: RevokeSessionUseCase;
  };
};

export type ContainerOverrides = Partial<{
  clock: Clock;
  users: UserRepository;
  sessions: SessionRepository;
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
  const audit = overrides.audit ?? new DrizzleAuditLogger(db);
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

  const getSession = new GetSessionUseCase({ sessions, users, hasher, clock, audit });

  return {
    db,
    clock,
    repositories: { users, sessions },
    services: { hasher, ipHasher, tokens, comparator, email, audit, databaseProbe },
    useCases: {
      getSession,
      issueSession: new IssueSessionUseCase({
        users,
        sessions,
        hasher,
        ipHasher,
        tokens,
        clock,
        audit,
      }),
      logout: new LogoutUseCase({ sessions, hasher, clock, audit }),
      listSessions: new ListSessionsUseCase({ getSession, sessions, clock }),
      revokeSession: new RevokeSessionUseCase({ getSession, sessions, clock, audit }),
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

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
import type { SessionRepository } from "../application/ports/session.repository";
import type { UserRepository } from "../application/ports/user.repository";
import { GetSessionUseCase } from "../application/use-cases/get-session.use-case";
import { ListSessionsUseCase } from "../application/use-cases/list-sessions.use-case";
import { RevokeSessionUseCase } from "../application/use-cases/revoke-session.use-case";
import {
  PepperedIpHasher,
  Sha256TokenHasher,
  TimingSafeComparator,
  WebCryptoTokenGenerator,
} from "../infrastructure/crypto/web-crypto";
import { ConsoleEmailSender } from "../infrastructure/email/console-email-sender";
import { DrizzleAuditLogger } from "../infrastructure/persistence/drizzle-audit-logger";
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
  };
  readonly useCases: {
    readonly getSession: GetSessionUseCase;
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

  const hasher = new Sha256TokenHasher();
  const ipHasher = new PepperedIpHasher(env.IP_HASH_PEPPER ?? "dev-pepper");
  const tokens = new WebCryptoTokenGenerator();
  const comparator = new TimingSafeComparator();

  // 本番でメールプロバイダ未設定のまま ConsoleEmailSender が動くと OTP がログに出る。
  // 選定（仕様書 14-3）が済むまでは、development 以外では明示的に落とす。
  const email =
    overrides.email ??
    (env.ENVIRONMENT === "development"
      ? new ConsoleEmailSender()
      : throwUnconfigured("EMAIL_PROVIDER is not configured for non-development environments"));

  const getSession = new GetSessionUseCase({ sessions, users, hasher, clock, audit });

  return {
    db,
    clock,
    repositories: { users, sessions },
    services: { hasher, ipHasher, tokens, comparator, email, audit },
    useCases: {
      getSession,
      listSessions: new ListSessionsUseCase({ getSession, sessions, clock }),
      revokeSession: new RevokeSessionUseCase({ getSession, sessions, clock, audit }),
    },
  };
}

function throwUnconfigured(message: string): never {
  throw new Error(message);
}

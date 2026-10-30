import { createIdentityDatabase, type IdentityDatabase } from "@u18/db";
import { systemClock } from "@u18/domain";
import { RateLimitPolicy, type RateLimitScope } from "../domain/services/rate-limit-policy";
import type { ArchiveSink } from "../application/ports/archive.port";
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
import type { RateLimiter } from "../application/ports/rate-limiter.port";
import type { ExpiredRecordPurger } from "../application/ports/retention.port";
import type { SessionRepository } from "../application/ports/session.repository";
import type { SideEffectScheduler } from "../application/ports/side-effect-scheduler.port";
import type { SigningKeyProvider } from "../application/ports/signing-key.port";
import type { UserRepository } from "../application/ports/user.repository";
import type { WebAuthnChallengeRepository } from "../application/ports/webauthn-challenge.repository";
import type { WebAuthnService } from "../application/ports/webauthn.port";
import { AuthenticateOAuthClientUseCase } from "../application/use-cases/authenticate-oauth-client.use-case";
import { AuthorizeRequestUseCase } from "../application/use-cases/authorize-request.use-case";
import { ExchangeAuthorizationCodeUseCase } from "../application/use-cases/exchange-authorization-code.use-case";
import { IssueAuthorizationCodeUseCase } from "../application/use-cases/issue-authorization-code.use-case";
import { CloseAccountUseCase } from "../application/use-cases/close-account.use-case";
import { DeletePasskeyUseCase } from "../application/use-cases/delete-passkey.use-case";
import { GetSessionUseCase } from "../application/use-cases/get-session.use-case";
import { GetUserInfoUseCase } from "../application/use-cases/get-user-info.use-case";
import { IssueSessionUseCase } from "../application/use-cases/issue-session.use-case";
import { LogoutUseCase } from "../application/use-cases/logout.use-case";
import { StartEmailOtpUseCase } from "../application/use-cases/start-email-otp.use-case";
import { VerifyEmailOtpUseCase } from "../application/use-cases/verify-email-otp.use-case";
import { CreateOAuthClientUseCase } from "../application/use-cases/create-oauth-client.use-case";
import { DisableOAuthClientUseCase } from "../application/use-cases/disable-oauth-client.use-case";
import { ListGrantsUseCase } from "../application/use-cases/list-grants.use-case";
import { ListOAuthClientsUseCase } from "../application/use-cases/list-oauth-clients.use-case";
import { ListUsersUseCase } from "../application/use-cases/list-users.use-case";
import { ManageUserUseCase } from "../application/use-cases/manage-user.use-case";
import { ListAuditLogsUseCase } from "../application/use-cases/list-audit-logs.use-case";
import { DelegatedListUsersUseCase } from "../application/use-cases/delegated-list-users.use-case";
import { DelegatedManageUserUseCase } from "../application/use-cases/delegated-manage-user.use-case";
import { DelegatedListOAuthClientsUseCase } from "../application/use-cases/delegated-list-oauth-clients.use-case";
import { DelegatedCreateOAuthClientUseCase } from "../application/use-cases/delegated-create-oauth-client.use-case";
import { DelegatedDisableOAuthClientUseCase } from "../application/use-cases/delegated-disable-oauth-client.use-case";
import { DelegatedListAuditLogsUseCase } from "../application/use-cases/delegated-list-audit-logs.use-case";
import { ListPasskeysUseCase } from "../application/use-cases/list-passkeys.use-case";
import { ListSessionsUseCase } from "../application/use-cases/list-sessions.use-case";
import { PasskeyLoginOptionsUseCase } from "../application/use-cases/passkey-login-options.use-case";
import { PasskeyLoginVerifyUseCase } from "../application/use-cases/passkey-login-verify.use-case";
import { PasskeyRegisterOptionsUseCase } from "../application/use-cases/passkey-register-options.use-case";
import { PasskeyRegisterVerifyUseCase } from "../application/use-cases/passkey-register-verify.use-case";
import { PurgeExpiredRecordsUseCase } from "../application/use-cases/purge-expired-records.use-case";
import { ResolveOAuthClientUseCase } from "../application/use-cases/resolve-oauth-client.use-case";
import { RevokeAccessTokenUseCase } from "../application/use-cases/revoke-access-token.use-case";
import { RevokeGrantUseCase } from "../application/use-cases/revoke-grant.use-case";
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
import {
  CloudflareRateLimiter,
  UnconfiguredRateLimiter,
} from "../infrastructure/rate-limit/cloudflare-rate-limiter";
import { ConsoleEmailSender } from "../infrastructure/email/console-email-sender";
import { UnconfiguredEmailSender } from "../infrastructure/email/unconfigured-email-sender";
import { R2ArchiveSink, UnconfiguredArchiveSink } from "../infrastructure/archive/r2-archive-sink";
import {
  RequestScopedAuditLogger,
  type RequestContext,
} from "../infrastructure/audit/request-scoped-audit-logger";
import {
  InlineSideEffectScheduler,
  WaitUntilSideEffectScheduler,
} from "../infrastructure/scheduling/side-effect-schedulers";
import {
  DrizzleAuditLogger,
  DrizzleAuditLogReader,
} from "../infrastructure/persistence/drizzle-audit-logger";
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
    readonly sideEffects: SideEffectScheduler;
    readonly webauthn: WebAuthnService;
    readonly signingKeys: SigningKeyProvider;
    readonly purger: ExpiredRecordPurger;
    readonly archive: ArchiveSink;
    readonly idTokens: IdTokenIssuer;
    readonly rateLimiter: RateLimiter;
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
    readonly closeAccount: CloseAccountUseCase;
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
    readonly getUserInfo: GetUserInfoUseCase;
    readonly revokeAccessToken: RevokeAccessTokenUseCase;
    readonly listGrants: ListGrantsUseCase;
    readonly revokeGrant: RevokeGrantUseCase;
    readonly listOAuthClients: ListOAuthClientsUseCase;
    readonly listUsers: ListUsersUseCase;
    readonly manageUser: ManageUserUseCase;
    readonly listAuditLogs: ListAuditLogsUseCase;
    readonly createOAuthClient: CreateOAuthClientUseCase;
    readonly disableOAuthClient: DisableOAuthClientUseCase;
    // admin-worker 専用（#390 決定 16 ③）。`IdentityAdminDelegatedRPC` だけが呼ぶ。
    readonly delegatedListUsers: DelegatedListUsersUseCase;
    readonly delegatedManageUser: DelegatedManageUserUseCase;
    readonly delegatedListOAuthClients: DelegatedListOAuthClientsUseCase;
    readonly delegatedCreateOAuthClient: DelegatedCreateOAuthClientUseCase;
    readonly delegatedDisableOAuthClient: DelegatedDisableOAuthClientUseCase;
    readonly delegatedListAuditLogs: DelegatedListAuditLogsUseCase;
  };
};

export type { RequestContext };

export type ContainerOverrides = Partial<{
  clock: Clock;
  users: UserRepository;
  sessions: SessionRepository;
  emailChallenges: EmailChallengeRepository;
  audit: AuditLogger;
  email: EmailSender;
  databaseProbe: DatabaseProbe;
  sideEffects: SideEffectScheduler;
  oauthClients: OAuthClientRepository;
  signingKeys: SigningKeyProvider;
  purger: ExpiredRecordPurger;
  archive: ArchiveSink;
  idTokens: IdTokenIssuer;
  rateLimiter: RateLimiter;
}>;

/**
 * リクエストごとにコンテナを作る。
 *
 * Workers では `Env` がリクエスト単位で渡るため、モジュールスコープに
 * キャッシュしない。生成コストはオブジェクト確保のみで、D1 への接続は張らない。
 *
 * @param request HTTP 経由のときだけ渡す。発信元を監査ログに乗せるために使う
 *   （#122）。`scheduled` と Service Binding 越しの RPC には発信元が無いので
 *   `null` のまま呼ぶ —— RPC の入力に IP を足せば埋まるが、それは契約の変更で
 *   あり、`CONTRACT_VERSION` の運用（docs/runbook.md 3.2.3）に乗る話になる。
 */
export function createContainer(
  env: Env,
  overrides: ContainerOverrides = {},
  request: RequestContext | null = null,
): Container {
  const db = createIdentityDatabase(env.IDENTITY_DB);
  const clock = overrides.clock ?? systemClock;

  const users = overrides.users ?? new DrizzleUserRepository(db);
  const sessions = overrides.sessions ?? new DrizzleSessionRepository(db);
  const passkeys = new DrizzlePasskeyRepository(db);
  const webauthnChallenges = new DrizzleWebAuthnChallengeRepository(db);
  const emailChallenges = overrides.emailChallenges ?? new DrizzleEmailChallengeRepository(db);
  const databaseProbe = overrides.databaseProbe ?? new DrizzleDatabaseProbe(db);
  // 保持期限を過ぎた行の掃除（#43）。scheduled ハンドラからしか使わないが、
  // Port の配線先はここ 1 箇所に揃える。
  //
  // `audit_logs` は消す前に R2 へ退避する（#43 の残件）。バケットが無ければ
  // 退避の時点で失敗し、**そのテーブルの掃除だけが止まる** ——
  // 退避できないまま消すより、溜めて `failed` に出し続けるほうがよい。
  const archive = overrides.archive ?? createArchiveSink(env, clock);
  const purger = overrides.purger ?? new DrizzleExpiredRecordPurger(db, archive);

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

  // 監査ログ（#12）。HTTP 経由なら発信元で包む（#122）。
  //
  // **包むのはここ 1 箇所だけ。** 下流は `audit` しか見ないので、
  // 「この UseCase には ip_hash が付く / 付かない」という分岐が生まれない。
  // 副作用をいつ走らせるか（#126 / 脅威モデル RR-15）。
  //
  // `waitUntil` があれば応答後へ逃がす。無い経路（Cron、テストの一部）は
  // その場で待つ —— **投げっぱなしにはしない。** 応答を返した時点で
  // isolate が止まりうるので、待たない書き込みは黙って消える。
  const sideEffects =
    overrides.sideEffects ??
    (request?.waitUntil !== undefined
      ? new WaitUntilSideEffectScheduler(request.waitUntil)
      : new InlineSideEffectScheduler());

  const sink = overrides.audit ?? new DrizzleAuditLogger(db);
  const audit = request === null ? sink : new RequestScopedAuditLogger(sink, ipHasher, request);

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

  // レート制限（#21）。binding が 1 つでも欠けていれば、欠けている scope を
  // 使った時点で失敗する。黙って通すと「制限が入っているつもりで無防備」
  // という #88 と同じ形になる。
  const rateLimiter = overrides.rateLimiter ?? createRateLimiter(env);

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

  const getSession = new GetSessionUseCase({
    sessions,
    users,
    hasher,
    clock,
    audit,
    sideEffects,
  });
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
      sideEffects,
      webauthn,
      signingKeys,
      purger,
      archive,
      idTokens,
      rateLimiter,
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
      deletePasskey: new DeletePasskeyUseCase({ getSession, passkeys, users, clock, audit }),
      closeAccount: new CloseAccountUseCase({ getSession, users, sessions, clock, audit }),
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
        sessions,
      }),
      // #17: `/oauth/userinfo` と `/oauth/revoke`。どちらも Bearer / クライアント
      // 認証を経た後の判断だけを持ち、HTTP の作法は Presentation 側にある。
      getUserInfo: new GetUserInfoUseCase({
        tokens: oauthTokens,
        grants: oauthGrants,
        users,
        hasher,
        clock,
        audit,
      }),
      revokeAccessToken: new RevokeAccessTokenUseCase({
        tokens: oauthTokens,
        hasher,
        clock,
        audit,
      }),
      // #18: 同意管理。dashboard-worker から RPC 越しに呼ばれる。
      listGrants: new ListGrantsUseCase({ getSession, grants: oauthGrants }),
      revokeGrant: new RevokeGrantUseCase({
        getSession,
        clients: oauthClients,
        grants: oauthGrants,
        tokens: oauthTokens,
        codes: authorizationCodes,
        clock,
        audit,
      }),
      // #308: OAuth クライアント管理。**管理者のセッションでしか通らない**
      // （判定は UseCase の中。`application/use-cases/admin-access.ts`）。
      listOAuthClients: new ListOAuthClientsUseCase({ getSession, clients: oauthClients }),
      listUsers: new ListUsersUseCase({ getSession, users }),
      manageUser: new ManageUserUseCase({ getSession, users, sessions, clock, audit }),
      listAuditLogs: new ListAuditLogsUseCase({
        getSession,
        auditLogs: new DrizzleAuditLogReader(db),
      }),
      createOAuthClient: new CreateOAuthClientUseCase({
        getSession,
        audit,
        clients: oauthClients,
        // 秘密の生成とハッシュ化はここで配線する。平文は UseCase の
        // 戻り値にしか現れず、DB へはハッシュだけが入る（仕様書 7.1）。
        tokens,
        hasher,
        // 再認証の窓（5 分）を測るのに要る。登録・失効のどちらも
        // `deletePasskey` と同じ扱いにしてある。
        clock,
      }),
      disableOAuthClient: new DisableOAuthClientUseCase({
        getSession,
        audit,
        clients: oauthClients,
        clock,
      }),
      // admin-worker 専用（#390 決定 16 ③）。**`getSession` を渡さない** ——
      // 認可は Service Binding と admin-worker の承認リストに委ねており、
      // ここに `requireAdminSession` 相当の判定は無い。
      delegatedListUsers: new DelegatedListUsersUseCase({ users }),
      delegatedManageUser: new DelegatedManageUserUseCase({ users, sessions, clock, audit }),
      delegatedListOAuthClients: new DelegatedListOAuthClientsUseCase({ clients: oauthClients }),
      delegatedCreateOAuthClient: new DelegatedCreateOAuthClientUseCase({
        users,
        clients: oauthClients,
        tokens,
        hasher,
        audit,
      }),
      delegatedDisableOAuthClient: new DelegatedDisableOAuthClientUseCase({
        users,
        clients: oauthClients,
        clock,
        audit,
      }),
      delegatedListAuditLogs: new DelegatedListAuditLogsUseCase({
        auditLogs: new DrizzleAuditLogReader(db),
      }),
    },
  };
}

/**
 * レート制限の実装を組み立てる（#21）。
 *
 * binding 名は `RateLimitPolicy` が持っている。`Env` の型は cf-typegen が
 * `wrangler.jsonc` から生成するので、binding を消すと**ここが型エラーになる**
 * （#68 の drift guard と同じ効き方）。
 *
 * ここでも throw しない（#53）。制限をかけようとした時点で失敗させる。
 */
function createRateLimiter(env: Env): RateLimiter {
  const bindings: Partial<Record<RateLimitScope, RateLimit>> = {};
  for (const [scope, rule] of Object.entries(RateLimitPolicy) as [
    RateLimitScope,
    (typeof RateLimitPolicy)[RateLimitScope],
  ][]) {
    const binding = (env as unknown as Record<string, RateLimit | undefined>)[rule.binding];
    if (binding !== undefined) bindings[scope] = binding;
  }

  if (Object.keys(bindings).length === 0) {
    return new UnconfiguredRateLimiter("no ratelimits binding is present");
  }
  // 一部だけ存在する場合も CloudflareRateLimiter を返す。欠けている scope を
  // 使ったときだけ失敗し、ある scope は正しく効く。まとめて無効化するより、
  // 壊れている範囲が狭いほうが良い。
  return new CloudflareRateLimiter(bindings);
}

/**
 * 退避先を組み立てる（#43 の残件）。
 *
 * ここでも throw しない（#53）。バケットが無いまま起動しても `/health` や
 * 認証は動き続け、失敗するのは掃除が退避しようとした時点だけにする。
 */
function createArchiveSink(env: Env, clock: Clock): ArchiveSink {
  if (env.ARCHIVE !== undefined) {
    return new R2ArchiveSink(env.ARCHIVE, clock);
  }
  // development でも素通しにはしない。バインディングは wrangler.jsonc に
  // 書いてあり、ローカルでも miniflare が用意する。無いということは
  // 設定が壊れているということで、黙って消し始めてよい理由にならない。
  return new UnconfiguredArchiveSink("ARCHIVE bucket binding is missing");
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
 * `SIGNING_KEY_JWK` だけで「設定済み」と見なす（#23）。JWK Set 形式では各鍵が
 * 自分の `kid` を持つので `SIGNING_KEY_KID` は要らない。単一 JWK 形式の既存環境は
 * `SIGNING_KEY_KID` がそのまま効くので、設定を変えずに動き続ける。
 *
 * **揃っているかの判定をここでしない。** `SIGNING_KEY_KID` が要る形式かどうかは
 * Secret の中身を読まないと決まらず、それを知っているのは
 * `parseSigningKeySecret` だけである。ここで「2 つとも必要」と決め打ちすると、
 * JWK Set へ移行した環境が「設定漏れ」に見えて JWKS ごと静かに止まる。
 */
function createSigningKeyProvider(
  env: Env,
  db: IdentityDatabase,
  clock: Clock,
): SigningKeyProvider {
  const metadata = new DrizzleSigningKeyMetadataRepository(db);
  const configured =
    env.SIGNING_KEY_JWK !== undefined
      ? { jwk: env.SIGNING_KEY_JWK, kid: env.SIGNING_KEY_KID ?? null }
      : null;

  return new JoseSigningKeyProvider(metadata, clock, configured, "SIGNING_KEY_JWK must be set");
}

import { z } from "zod";
import type { RpcResult } from "./errors";

/**
 * auth-worker の IdentityRPC が公開する DTO。
 *
 * 設計方針 (仕様書 4.1 / 4.2):
 *  - メソッドは小さく保つ。「任意の userId を受け取って無条件に情報を返す」入口を作らない。
 *  - 本人性の根拠はセッショントークンに置き、呼び出し元 Worker の申告した userId に置かない。
 *  - DTO は JSON 直列化可能な形だけを使う（日付は ISO 8601 文字列）。
 */

export const sessionTokenSchema = z
  .string()
  .min(32, "session token is too short")
  .max(512, "session token is too long");

export const userIdSchema = z.string().min(1).max(64);

/**
 * RPC の呼び出し元 Worker（#22）。
 *
 * ## 申告であって認証ではない
 *
 * **Service Binding は呼び出し元の身元を運ばない。** 呼ばれた側から
 * 「どの Worker が呼んだか」を確かめる API は無く、`ctx.props` や
 * 名前付き entrypoint を使っても、設定するのは呼び出し元の
 * `wrangler.jsonc` なので信頼の度合いは同じである。
 *
 * したがってこの値は **監査ログの帰属（attribution）にだけ使う**。
 * 認可の判断に使ってはならない —— 侵害された Worker は別の Worker を
 * 名乗れる。本人性の根拠は従来どおりセッショントークンに置く。
 *
 * それでも入れる価値がある理由は、**平常時にどちらの経路から来た操作かが
 * 分かる**こと。消費者が 2 つある以上、監査ログだけ見て
 * 「dashboard から来たのか nfc から来たのか」が分からないのは、
 * 侵害調査で「どの Worker が侵害されたか」を切り分けられないということ。
 *
 * ## 閉じた集合にする理由
 *
 * 任意の文字列を受けると、呼び出し元が監査ログへ好きな値を書き込める
 * （ログ注入）。`actor` は調査でそのまま読む列なので、ここは閉じる。
 */
export const RPC_CALLERS = ["dashboard-worker", "nfc-worker"] as const;
export type RpcCaller = (typeof RPC_CALLERS)[number];

/**
 * **optional にしてある。** 必須にすると、auth-worker を先にデプロイした
 * 瞬間に古い呼び出し元が全滅する（`CONTRACT_VERSION` の運用、
 * docs/architecture.md §5.3）。渡されなければ `actor` は "unknown" になる。
 *
 * 渡し忘れが静かに "unknown" へ落ちるのを防ぐため、**両方の消費者が
 * 実際に送っていることをそれぞれのテストが固定している。**
 */
export const rpcCallerSchema = z.enum(RPC_CALLERS).optional();

// ---------------------------------------------------------------- getSession

export const getSessionInputSchema = z.object({
  sessionToken: sessionTokenSchema,
  /** 呼び出し元 Worker。監査ログの帰属にだけ使う（認証ではない）。 */
  caller: rpcCallerSchema,
});

export type GetSessionInput = z.infer<typeof getSessionInputSchema>;

export type SessionSummary = {
  readonly userId: string;
  readonly sessionId: string;
  /** ISO 8601 (UTC) */
  readonly expiresAt: string;
  /**
   * **このセッションで管理者として振る舞ってよいか**（仕様書 §14.1 決定 8）。
   *
   * ## `users.is_admin` そのものではない
   *
   * 決定 8 は「管理者は Passkey 必須」なので、**`auth_method` が `passkey`
   * でないセッションでは false になる**（auth-worker の
   * `User.actsAsAdminWith`）。アカウントに旗が立っていることと、いま来ている
   * この 1 回の呼び出しを管理者として通してよいことは別である。
   *
   * 消費者から見ると「管理者が減る」方向にしか動かないので、受け取る側の
   * 実装は変えなくてよい（脅威モデル RR-5）。
   *
   * ## なぜ `UserProfile` ではなくここか
   *
   * 必要としているのは **nfc-worker** で、用途は「運営によるカード発行を
   * 許すか」の 1 点（#187）。`getUserProfile` を呼ばせると、**nfc-worker が
   * 利用者のメールアドレスと username まで受け取る**ことになる。
   *
   * nfc-worker は Identity D1 を持たず、知れることを最小にしてある
   * （`packages/nfc-db/src/schema/cards.ts`）。**侵害されたときに届く範囲**が
   * 判断の軸なので、真偽値 1 つで済むならそうする。
   *
   * `getSession` は既に呼んでいるので、往復も増えない。
   *
   * ## 認可の判断に使ってよい
   *
   * `caller`（§14.1 決定 12）と違い、**これは auth-worker が D1 を見て
   * 決めた値**で、呼び出し元の申告ではない。
   */
  readonly isAdmin: boolean;
};

/** セッションが無効・期限切れ・失効済みの場合は null。存在しないこと自体はエラーではない。 */
export type GetSessionResult = RpcResult<SessionSummary | null>;

// ------------------------------------------------------------ getUserProfile

export const getUserProfileInputSchema = z.object({
  /**
   * 呼び出し元が持つセッショントークン。
   * userId は受け取らない —— 受け取ると「他人の userId を指定して読む」入口になるため。
   */
  sessionToken: sessionTokenSchema,
  /** 呼び出し元 Worker。監査ログの帰属にだけ使う（認証ではない）。 */
  caller: rpcCallerSchema,
});

export type GetUserProfileInput = z.infer<typeof getUserProfileInputSchema>;

export type UserProfile = {
  readonly id: string;
  readonly username: string;
  readonly displayName: string;
  readonly email: string;
  readonly emailVerified: boolean;
  readonly status: "active" | "suspended" | "deleted";
  readonly createdAt: string;
  /**
   * **このセッションで管理者として振る舞ってよいか**（仕様書 §14.1 決定 8）。
   *
   * `SessionSummary.isAdmin` と同じ判定で、`users.is_admin` そのものではない
   * —— 根拠はあちらに書いた。`getUserProfile` はプロフィールを返す経路だが、
   * **ここだけ `users` の行をそのまま出すと、同じ名前の項目が 2 つの意味を
   * 持つ。** 片方だけ絞った状態は「画面には管理者の導線が出るが、押すと
   * 存在しないと言われる」形になる。
   *
   * **`SessionSummary` にも同じ値がある。** 重複しているのは意図的で、
   * 消費者と最小化の要求が違う:
   *
   * - `SessionSummary.isAdmin` —— **nfc-worker** が発行の可否に使う。
   *   あちらに `getUserProfile` を呼ばせると、メールアドレスと username まで
   *   渡ることになる（#187）
   * - ここ —— **dashboard の UI** が管理者向けの導線を出すかに使う。
   *   どのみちプロフィール全体をブラウザへ返している経路である
   *
   * 片方だけにすると、どちらかの消費者が必要以上の情報を受け取る。
   */
  readonly isAdmin: boolean;
};

export type GetUserProfileResult = RpcResult<UserProfile | null>;

// --------------------------------------------------------------- listSessions

export const listSessionsInputSchema = z.object({
  sessionToken: sessionTokenSchema,
  /** 呼び出し元 Worker。監査ログの帰属にだけ使う（認証ではない）。 */
  caller: rpcCallerSchema,
});

export type ListSessionsInput = z.infer<typeof listSessionsInputSchema>;

export type SessionListItem = {
  readonly sessionId: string;
  readonly createdAt: string;
  readonly lastSeenAt: string;
  readonly expiresAt: string;
  /** 現在この RPC を呼ぶのに使われたセッションかどうか。UI で「このデバイス」を示す。 */
  readonly current: boolean;
  readonly userAgent: string | null;
  // ipHash は載せない。dashboard-worker はこの DTO をそのままブラウザへ返すため、
  // ここに入れると IP のハッシュが利用者側へ漏れる。auth-worker 自身の
  // /api/me/sessions も返していない。必要になったら専用の管理用 RPC を分ける。
};

export type ListSessionsResult = RpcResult<readonly SessionListItem[]>;

// -------------------------------------------------------------- revokeSession

export const revokeSessionInputSchema = z.object({
  /** 操作者の本人確認に使うセッション。 */
  sessionToken: sessionTokenSchema,
  /** 失効させたいセッションの ID。操作者自身のセッションでなければ拒否される。 */
  targetSessionId: z.string().min(1).max(64),
  /** 呼び出し元 Worker。監査ログの帰属にだけ使う（認証ではない）。 */
  caller: rpcCallerSchema,
});

export type RevokeSessionInput = z.infer<typeof revokeSessionInputSchema>;

export type RevokeSessionResult = RpcResult<{
  readonly revoked: boolean;
  /**
   * 操作者自身のセッションを失効させたか。
   *
   * 呼び出し元はこれを見て Cookie を落とすか決める。`revoked` だけで
   * 判断すると、別端末を失効させたときに自分までログアウトされる。
   */
  readonly self: boolean;
}>;

// ----------------------------------------------------------------- listGrants

export const listGrantsInputSchema = z.object({
  /**
   * セッショントークンだけを受け取る。`userId` は受け取らない —— 同意一覧は
   * 「どのアプリに何を許可したか」という、セッション一覧と同じ機微度の情報で、
   * userId を引数にした瞬間に他人の分を読む入口になる（仕様書 4.2 の注意書き）。
   */
  sessionToken: sessionTokenSchema,
  /** 呼び出し元 Worker。監査ログの帰属にだけ使う（認証ではない）。 */
  caller: rpcCallerSchema,
});

export type ListGrantsInput = z.infer<typeof listGrantsInputSchema>;

export type GrantListItem = {
  /**
   * OIDC の公開 `client_id`。`oauth_clients.id`（内部 ID）ではない。
   *
   * 取り消し（`revokeGrant`）の引数にもこれを使う。内部 ID を外へ出すと、
   * ダッシュボードの HTML に内部識別子が載り、以後それを受け付ける API を
   * 消せなくなる。
   */
  readonly clientId: string;
  readonly clientName: string;
  readonly logoUrl: string | null;
  /** 許可済み scope。表示のために配列で渡す（スペース区切りの再分解を各所でやらせない）。 */
  readonly scopes: readonly string[];
  /** ISO 8601 (UTC) */
  readonly grantedAt: string;
};

export type ListGrantsResult = RpcResult<readonly GrantListItem[]>;

// ---------------------------------------------------------------- revokeGrant

export const revokeGrantInputSchema = z.object({
  /** 操作者の本人確認に使うセッション。 */
  sessionToken: sessionTokenSchema,
  /** 取り消す同意の相手。公開 `client_id`。操作者自身の同意でなければ拒否される。 */
  clientId: z.string().min(1).max(255),
  /** 呼び出し元 Worker。監査ログの帰属にだけ使う（認証ではない）。 */
  caller: rpcCallerSchema,
});

export type RevokeGrantInput = z.infer<typeof revokeGrantInputSchema>;

export type RevokeGrantResult = RpcResult<{
  /** 同意の行が「取り消し済み」へ遷移したか。既に取り消し済みなら false（冪等）。 */
  readonly revoked: boolean;
  /**
   * 巻き添えで失効した Access Token の件数。
   *
   * 「取り消しました」とだけ言われても、利用者は発行済みトークンが残って
   * いないかを確かめられない。件数を返して UI が「n 個のアクセスを停止した」と
   * 言えるようにしておく。
   */
  readonly revokedTokenCount: number;
}>;

// ----------------------------------------------------------------------- ping

/**
 * 死活確認の結果（#44）。
 *
 * **引数を取らず、個人情報も識別子も返さない。** dashboard-worker の
 * `/health` は認証されていない要求から呼ばれるので、ここに `userId` や
 * `email` が 1 つでも混じると、認証なしで読める経路になる。
 * 既存の `getSession` を health に流用しないのも同じ理由である
 * （セッションの実在が外から測れてしまう）。
 */
export type IdentityPing = {
  /** auth-worker が自分の依存先（D1）まで到達できているか。 */
  readonly status: "ok" | "degraded";
  readonly service: "u18-auth";
};

export type PingResult = RpcResult<IdentityPing>;

// ----------------------------------------------------------------- Entrypoint

/**
 * dashboard-worker が Service Binding 越しに見る auth-worker の形。
 * auth-worker 側の `IdentityRPC` はこの型を満たす必要がある。
 */
// ----------------------------------------------------------- updateProfile

export const updateProfileInputSchema = z.object({
  sessionToken: sessionTokenSchema,
  caller: rpcCallerSchema,
  /**
   * 表示名。省略すると変更しない。
   *
   * 上限 64 は auth-worker の `UpdateProfileUseCase` と同じ値。**ここで
   * 弾くのは早期に返すためで、正本はあちら**（RPC は入口の 1 つでしかなく、
   * HTTP から来た場合も同じ検証を通る必要がある）。
   */
  displayName: z.string().min(1).max(64).optional(),
  /** username。省略すると変更しない。**変更には再認証が要る。** */
  username: z.string().min(1).max(64).optional(),
});

export type UpdateProfileInput = z.infer<typeof updateProfileInputSchema>;

export type UpdateProfileResult = RpcResult<{
  readonly profile: UserProfile;
  /** 実際に変わった項目名。呼び出し元が「変更なし」を表示し分けるのに使う。 */
  readonly changedFields: readonly string[];
}>;

// ------------------------------------------------------------ listPasskeys

export const listPasskeysInputSchema = z.object({
  sessionToken: sessionTokenSchema,
  caller: rpcCallerSchema,
});

export type ListPasskeysInput = z.infer<typeof listPasskeysInputSchema>;

/**
 * 一覧に出す Passkey。
 *
 * **`credentialId` と公開鍵を載せない**（仕様書 8.1）。`SessionListItem`
 * から `ipHash` を外したのと同じで（RR-13）、**フィルタではなく型で
 * 落とす。** フィルタは将来のハンドラが忘れうるが、型に無い項目は
 * 漏れようがない。
 *
 * `credentialId` は WebAuthn の `allowCredentials` に入る値で、
 * これが漏れると「この利用者はこの認証器を持っている」が外から分かる。
 */
export type PasskeySummary = {
  readonly id: string;
  readonly label: string | null;
  readonly deviceType: string | null;
  /** ISO 8601 (UTC) */
  readonly createdAt: string;
  /** ISO 8601 (UTC)。一度も使われていなければ null。 */
  readonly lastUsedAt: string | null;
};

export type ListPasskeysResult = RpcResult<readonly PasskeySummary[]>;

// ----------------------------------------------------------- deletePasskey

export const deletePasskeyInputSchema = z.object({
  sessionToken: sessionTokenSchema,
  /** 削除する Passkey の ID。`credentialId` ではない。 */
  passkeyId: z.string().min(1).max(64),
  caller: rpcCallerSchema,
});

export type DeletePasskeyInput = z.infer<typeof deletePasskeyInputSchema>;

export type DeletePasskeyResult = RpcResult<{
  readonly deleted: boolean;
  /** 削除後に残っている本数。呼び出し元が「最後の 1 本」を案内するのに使う。 */
  readonly remaining: number;
}>;

// ----------------------------------------------------------- closeAccount

export const closeAccountInputSchema = z.object({
  sessionToken: sessionTokenSchema,
  caller: rpcCallerSchema,
});

export type CloseAccountInput = z.infer<typeof closeAccountInputSchema>;

/**
 * 本人の退会（#318 / ランブック §11.7）。
 *
 * **個人情報は落ちない。** `status` が `suspended` になりログインが
 * 塞がるだけで、氏名相当とメールアドレスは残る（落とすのは管理者の
 * §11.6）。**「削除した」と呼ばないのはそのため。**
 */
export type CloseAccountResult = RpcResult<{
  /** 今回の操作で閉じたか。既に閉じていれば `false`。 */
  readonly closed: boolean;
  /** 失効させたセッションの本数。 */
  readonly revokedSessions: number;
}>;

export interface IdentityRpcContract {
  getSession(input: GetSessionInput): Promise<GetSessionResult>;
  getUserProfile(input: GetUserProfileInput): Promise<GetUserProfileResult>;
  listSessions(input: ListSessionsInput): Promise<ListSessionsResult>;
  revokeSession(input: RevokeSessionInput): Promise<RevokeSessionResult>;
  listGrants(input: ListGrantsInput): Promise<ListGrantsResult>;
  revokeGrant(input: RevokeGrantInput): Promise<RevokeGrantResult>;
  updateProfile(input: UpdateProfileInput): Promise<UpdateProfileResult>;
  listPasskeys(input: ListPasskeysInput): Promise<ListPasskeysResult>;
  deletePasskey(input: DeletePasskeyInput): Promise<DeletePasskeyResult>;
  closeAccount(input: CloseAccountInput): Promise<CloseAccountResult>;
  /** 副作用の無い死活確認（#44）。認証を要求しない。 */
  ping(): Promise<PingResult>;
  // **OAuth クライアント管理（#308）はここに無い。** `IdentityAdminRpcContract`
  // （`identity-admin.ts`）という別の Entrypoint に分けてある。
  //
  // **Service Binding はメソッド単位で絞れない。** この契約に足すと、
  // `IdentityRPC` を束縛している Worker は**全部**管理用メソッドを呼べる
  // ことになる —— nfc-worker を含む。nfc-worker は設計上**管理者の
  // セッショントークンを扱う**（#187 でこの契約に `isAdmin` を足した理由が
  // それ）ので、侵害されれば通りかかった管理者の新しいセッションで
  // クライアントを登録できてしまう。`entrypoint` の指定は Cloudflare 側で
  // 強制されるので、`caller`（自己申告）と違って**実際に効く境界**になる。
}

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

// ------------------------------------------------------ OAuth クライアント管理
//
// **管理者だけが使える領域**（#308 / 仕様書 §14.1 決定 11 の段階 (2)）。
//
// ## これは緩和策の置き換えである
//
// `apps/auth-worker/scripts/oauth-client.mjs` の冒頭は、登録を HTTP へ
// 出さない理由をこう書いていた —— 「任意の `redirect_uri` を持つクライアントを
// 誰でも作れる」状態になると、認可コードの宛先を攻撃者が自分で登録できるので、
// Redirect URI の完全一致検証が無意味になる。**運用者の手元からしか
// 叩けないこと自体が緩和策**だった。
//
// 運用者の判断で、その緩和策を**「手元からしか叩けない」から
// 「管理者だけが叩ける」へ置き換える**。弱くなる方向の変更なので、
// 何が弱くなったかは `docs/threat-model.md` RR-21 に書いてある。
//
// 置き換えに伴って、この契約には 3 つの形がある。
//
// 1. **`client_secret_hash` を型に持たない。** `PasskeySummary` が公開鍵を
//    載せないのと同じで、フィルタではなく型で落とす（RR-13）。
// 2. **内部 ID（`oauth_clients.id`）も載せない。** 外へ出すと、以後それを
//    受け付ける API を消せなくなる（`GrantListItem.clientId` と同じ理由）。
// 3. **管理者でないセッションには `not_found` を返す。** 「権限がありません」と
//    「そんな機能はありません」を区別すると、管理機能の存在そのものが
//    一般利用者に漏れる。

export const listOAuthClientsInputSchema = z.object({
  sessionToken: sessionTokenSchema,
  caller: rpcCallerSchema,
});

export type ListOAuthClientsInput = z.infer<typeof listOAuthClientsInputSchema>;

/**
 * 一覧・登録の応答に載せるクライアント。
 *
 * **`client_secret_hash` がこの型に無い。** 詰め忘れではなく「詰めようが
 * ない」形にしてある —— ハッシュは `client_secret` の総当たりにそのまま
 * 使える値で、confidential クライアントのなりすましは認可コードを
 * トークンへ換える力と等しい（脅威モデル E-5）。
 *
 * 平文の `client_secret` は `CreateOAuthClientResult` にだけ現れる。
 * 一覧から読み直す経路は作らない（作ると「後から誰でも読み出せる平文」に
 * 戻る）。
 */
export type OAuthClientSummary = {
  /** OIDC の公開 `client_id`。失効（`disableOAuthClient`）の引数にもこれを使う。 */
  readonly clientId: string;
  readonly name: string;
  readonly clientType: "confidential" | "public";
  /** 同意画面を省略してよい u18 公式サービスか（仕様書 5.1）。 */
  readonly isFirstParty: boolean;
  readonly logoUrl: string | null;
  /** 登録済み Redirect URI。完全一致で照合される実物（仕様書 9）。 */
  readonly redirectUris: readonly string[];
  /** 許可 scope。表示のために配列で渡す（`GrantListItem.scopes` と同じ形）。 */
  readonly scopes: readonly string[];
  /** ISO 8601 (UTC) */
  readonly createdAt: string;
  /** ISO 8601 (UTC)。失効していなければ null。 */
  readonly disabledAt: string | null;
};

/**
 * **失効済みのクライアントも含めて返す。**
 *
 * 除くと、画面から失効させた直後に行が消えることになり、運用者は
 * 「失効したのか、消えたのか、そもそも登録されていなかったのか」を
 * 区別できない。`disabledAt` を載せて表示側に判断させる。
 */
export type ListOAuthClientsResult = RpcResult<readonly OAuthClientSummary[]>;

// ------------------------------------------------------- createOAuthClient

export const createOAuthClientInputSchema = z.object({
  sessionToken: sessionTokenSchema,
  caller: rpcCallerSchema,
  /** OIDC の `client_id`。重複は DB の unique index が止める。 */
  clientId: z.string().min(1).max(255),
  name: z.string().min(1).max(255),
  clientType: z.enum(["confidential", "public"]),
  /**
   * 登録する Redirect URI。**1 つ以上必須。**
   *
   * 「後で足す」を許すと、未検証の URI が直接 SQL で入る経路ができる
   * （`oauth-client.mjs` と同じ判断）。検証そのものは auth-worker の
   * `domain/services/redirect-uri.ts` が行う —— **CLI も同じ関数を読んでいる**
   * ので、ここで別の判定を書くと CLI で通した URI が認可時に弾かれる
   * （あるいはその逆）という形でずれる。
   *
   * `http://localhost` は**この入口からは登録できない**。CLI の
   * `--allow-loopback-http` に当たるものを置いていないのは、本番 IdP に
   * ループバック宛の行が残ると、その `client_id` を知る攻撃者が被害者の
   * ブラウザで認可を走らせ、自分の手元で待つアプリへコードを届けられるため
   * （`redirect-uri.ts` のコメント）。開発用クライアントは引き続き
   * `scripts/oauth-client.mjs seed-dev` で入れる。
   */
  redirectUris: z.array(z.string().min(1).max(2048)).min(1).max(16),
  /**
   * 許可 scope。省略すると `openid profile email`。
   *
   * 既定も上限も auth-worker の `CreateOAuthClientUseCase` にある。
   * **ここで弾くのは早期に返すためで、正本はあちら**（`updateProfile` の
   * `displayName` と同じ扱い）。
   */
  scopes: z.array(z.string().min(1).max(64)).min(1).max(16).optional(),
  /**
   * u18 公式サービスとして登録するか（同意画面を省略してよい）。
   *
   * **既定は false。** 同意画面の省略は「利用者が気づかないまま認可が
   * 完了する」ということで、脅威モデル T-1 が攻撃の前提に挙げているのは
   * まさにそれである。省略形で付くべき印ではない。
   */
  isFirstParty: z.boolean().optional(),
  logoUrl: z.string().max(2048).nullable().optional(),
});

export type CreateOAuthClientInput = z.infer<typeof createOAuthClientInputSchema>;

export type CreateOAuthClientResult = RpcResult<{
  readonly client: OAuthClientSummary;
  /**
   * 生成した `client_secret` の**平文**。public クライアントでは null。
   *
   * **この応答にしか存在しない。** DB に入るのはハッシュだけで（仕様書 7.1）、
   * 取り損ねたら再発行するしかない。これは不便ではなく、「後から誰でも
   * 読み出せる平文」を作らないための形である（`oauth-client.mjs` の
   * `generateSecret` と同じ判断）。
   */
  readonly clientSecret: string | null;
}>;

// ------------------------------------------------------ disableOAuthClient

export const disableOAuthClientInputSchema = z.object({
  sessionToken: sessionTokenSchema,
  /** 失効させるクライアントの公開 `client_id`。 */
  clientId: z.string().min(1).max(255),
  caller: rpcCallerSchema,
});

export type DisableOAuthClientInput = z.infer<typeof disableOAuthClientInputSchema>;

export type DisableOAuthClientResult = RpcResult<{
  /**
   * 行が「失効済み」へ遷移したか。**既に失効済みでも、未登録の `client_id`
   * でも false（冪等）。**
   *
   * 区別しないのは `revokeGrant` と同じ理由で、区別すると「どの `client_id`
   * が登録済みか」を総当たりで調べる窓口になる。失効は何度呼んでも同じ
   * 状態へ収束し、`disabled_at` は最初の 1 回から動かない
   * （`DrizzleOAuthClientRepository.disable`）。
   */
  readonly disabled: boolean;
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
  /**
   * OAuth クライアントの一覧（#308）。**管理者のセッションでしか通らない。**
   *
   * 判定は auth-worker の UseCase の中にある。呼び出し元の画面が
   * 管理者向けの導線を隠しているかどうかとは独立に効く。
   */
  listOAuthClients(input: ListOAuthClientsInput): Promise<ListOAuthClientsResult>;
  /** OAuth クライアントの新規登録（#308）。**管理者のみ。** */
  createOAuthClient(input: CreateOAuthClientInput): Promise<CreateOAuthClientResult>;
  /** OAuth クライアントの失効（#308）。**管理者のみ。**冪等。 */
  disableOAuthClient(input: DisableOAuthClientInput): Promise<DisableOAuthClientResult>;
  /** 副作用の無い死活確認（#44）。認証を要求しない。 */
  ping(): Promise<PingResult>;
}

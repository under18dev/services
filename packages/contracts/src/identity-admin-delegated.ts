import { z } from "zod";
import type { AuditLogEntryAdmin, OAuthClientSummary, UserAdminSummary } from "./identity-admin";
import { suspendReasonSchema } from "./identity-admin";
import type { RpcResult } from "./errors";

/**
 * auth-worker の **`IdentityAdminDelegatedRPC`** が公開する DTO
 * （#390 決定 16 ③）。
 *
 * ## なぜ `IdentityAdminRpcContract` と別にしてあるか
 *
 * admin-worker は OIDC で admin-worker 自身にログインし、admin-worker
 * 独自の承認リストで管理者性を確認している。**auth-worker のセッション
 * Cookie を持たない**ので、既存の管理 API（`sessionToken` 必須）を
 * そのまま呼べない。nfc-worker の `NfcAdminDelegatedRpcContract`
 * （#382 / #390 決定 16 ③）と同じ形をここにも用意する。
 *
 * ## trust boundary は Service Binding そのものである
 *
 * **ここに届く `actorUserId` を認可には使わない。** この Entrypoint へ
 * 辿り着けること自体が Service Binding で保証されており
 * （`scripts/check-service-bindings.mjs`）、束縛できるのは admin-worker
 * だけである。admin-worker は呼ぶ前に自分の承認リストで管理者性を
 * 確かめている —— 二重に確かめる理由が無い（運用者の判断：権限判定は
 * admin-worker 側へ全面移行、2026-10-30）。
 *
 * **`actorUserId` は admin-worker が申告する ID Token の `sub`。**
 * auth-worker は実在だけを確かめ（`requireExistingActor`）、本人性の
 * 検証はしていない —— **admin-worker 自身の承認リストの正しさに依存する。**
 * `docs/threat-model.md` の該当節に同じ注記がある。
 *
 * ## `caller` を持たない
 *
 * **`IdentityAdminRpcContract` と違う点。** `caller` が監査に効くのは
 * 「同じ Entrypoint を複数の Worker が束縛しうるとき」で、`actor` を見れば
 * どちらから来たログか分かる場合である。**delegated 系は束縛表そのものが
 * 「admin-worker 専用」を強制する**ので、`caller` の値は常に 1 種類にしか
 * ならない。1 種類しか取らない値を持たせても、冗長な列が増えるだけである
 * （`NfcAdminDelegatedRpcContract` と同じ判断。94 の指摘）。
 *
 * ## 既存の結果型をそのまま使う
 *
 * `UserAdminSummary` / `OAuthClientSummary` / `AuditLogEntryAdmin` は
 * `identity-admin.ts` のものを再利用する。**出力の形は入口が変わっても
 * 変わらない** —— 変わるのは「誰が呼んでよいか」の確かめ方だけである。
 */

// ----------------------------------------------------------------- listUsers

export const listUsersDelegatedInputSchema = z.object({
  /** admin-worker が確認済みの、操作者（運営）の userId。実在だけ確かめる。 */
  actorUserId: z.string().min(1),
  query: z.string().min(1).max(320).optional(),
  cursor: z.string().min(1).max(64).optional(),
  limit: z.number().int().min(1).max(200).optional(),
});
export type ListUsersDelegatedInput = z.infer<typeof listUsersDelegatedInputSchema>;
export type ListUsersDelegatedResult = RpcResult<{
  readonly users: readonly UserAdminSummary[];
  readonly nextCursor: string | null;
}>;

// ------------------------------------------------------------- suspendUser

export const suspendUserDelegatedInputSchema = z.object({
  actorUserId: z.string().min(1),
  userId: z.string().min(1).max(64),
  reason: suspendReasonSchema,
});
export type SuspendUserDelegatedInput = z.infer<typeof suspendUserDelegatedInputSchema>;
export type SuspendUserDelegatedResult = RpcResult<{ readonly revokedSessions: number }>;

// ------------------------------------------------------------ reinstateUser

export const reinstateUserDelegatedInputSchema = z.object({
  actorUserId: z.string().min(1),
  userId: z.string().min(1).max(64),
});
export type ReinstateUserDelegatedInput = z.infer<typeof reinstateUserDelegatedInputSchema>;
export type ReinstateUserDelegatedResult = RpcResult<Record<string, never>>;

// ------------------------------------------------------ revokeUserSessions

export const revokeUserSessionsDelegatedInputSchema = z.object({
  actorUserId: z.string().min(1),
  userId: z.string().min(1).max(64),
});
export type RevokeUserSessionsDelegatedInput = z.infer<
  typeof revokeUserSessionsDelegatedInputSchema
>;
export type RevokeUserSessionsDelegatedResult = RpcResult<{ readonly revokedSessions: number }>;

// ------------------------------------------------------------------ getUser

/**
 * 1 人だけを引く（admin-worker のユーザー詳細ページ用、#455）。
 *
 * **`listUsers` を引いて呼ぶ側で 1 件に絞らないこと。** あちらは既定
 * 50 件・最大 200 件のページングで、目当ての 1 人がどのページに居るかは
 * 分からない —— 全ページを舐める形になり、**利用者が増えるほど重くなる
 * 一方で、画面に出すのは常に 1 行である。** 集計を `listOAuthClients` で
 * 数えずに `countOAuthClients` を足した #449 と同じ判断で、
 * **主キー 1 本で引ける読み取りには専用の口を置く。**
 *
 * **検索（`listUsers` の `query`）では代えられない。** あれが照合するのは
 * メールアドレスか username で、**どちらも本人が変えられる**（`username`
 * は変更できる。`UserAdminSummary.id` の JSDoc を参照）。詳細ページの
 * 宛先は操作の宛先と同じ `userId` でなければ、**一覧で見た人と操作した人が
 * 違う**ことが起こりうる。
 */
export const getUserDelegatedInputSchema = z.object({
  actorUserId: z.string().min(1),
  userId: z.string().min(1).max(64),
});
export type GetUserDelegatedInput = z.infer<typeof getUserDelegatedInputSchema>;

/**
 * **存在しない `userId` は `not_found`。**
 *
 * ここでの `not_found` は `requireAdminSession` が「管理機能の存在を
 * 隠す」ために使う `not_found` とは別の意味で、文字どおり「その行が無い」
 * である。delegated 系の入口に認可は無いので、2 つの意味が混ざる心配は
 * ない（`IdentityAdminDelegatedRpcContract` の冒頭）。
 *
 * **呼ぶ側はこれを行き止まりにしないこと。** 消えた・打ち間違えた
 * `userId` を開いたときに空白の画面を出すと、運用者は「取得に失敗した」
 * と区別できない。
 */
export type GetUserDelegatedResult = RpcResult<UserAdminSummary>;

// ------------------------------------------------------------ getUsersByIds

/**
 * 一覧に「所有者」「actor」を名前で出すための、まとめ引き（#471）。
 *
 * **`getUser` をループで呼ばないこと。** カードや監査ログの一覧は 1 画面に
 * 最大 50〜200 行あり、1 行ごとに Service Binding を叩くと**行数ぶんの
 * 往復が走る。** まとめて引く口を別に置く——`listUsers` に絞り込みが
 * 無いのと同じ理由で、`getUser` を使い回さない。
 *
 * **`userIds` は最大 100。** `listUsersInputSchema` の `limit` と同じ
 * 理由——「名簿を 1 リクエストで吸い出す口」を作らないため。
 *
 * **重複と空の除去は呼ぶ側の仕事。** ここでは検証しない
 * （`resolveUserRefs` の冒頭を参照）。auth-worker 側は渡された ID を
 * そのまま `IN` 句へ流すだけで、重複があっても二重に数えない
 * （`findByIds` が一意な行の集合を返すだけだから）。
 */
export const getUsersByIdsDelegatedInputSchema = z.object({
  actorUserId: z.string().min(1),
  userIds: z.array(z.string().min(1).max(64)).max(100),
});
export type GetUsersByIdsDelegatedInput = z.infer<typeof getUsersByIdsDelegatedInputSchema>;

/**
 * 一覧に名前を出すためだけの最小の型。
 *
 * **`UserAdminSummary` を使い回さないこと。** あれは `primaryEmail` を
 * 持つ——カードの所有者や監査ログの actor を並べる一覧に他人のアドレスが
 * 出る画面を作ってしまう。フィルタではなく型で落とす（RR-13）。
 */
export type UserRefAdmin = {
  readonly id: string;
  readonly username: string;
  readonly displayName: string;
  readonly status: "active" | "suspended" | "deleted";
};

/**
 * **見つからなかった ID は、結果から黙って落ちる。** エラーにしない——
 * 退会済み・存在しない ID が 1 件混ざっただけで一覧全体の名前解決が
 * 落ちる作りにしないため（`resolveUserRefs` の冒頭を参照）。何件
 * 渡しても、返るのは見つかった分だけである。
 */
export type GetUsersByIdsDelegatedResult = RpcResult<readonly UserRefAdmin[]>;

// -------------------------------------------------------- listOAuthClients

export const listOAuthClientsDelegatedInputSchema = z.object({
  actorUserId: z.string().min(1),
});
export type ListOAuthClientsDelegatedInput = z.infer<typeof listOAuthClientsDelegatedInputSchema>;
export type ListOAuthClientsDelegatedResult = RpcResult<readonly OAuthClientSummary[]>;

// --------------------------------------------------------- getOAuthClient

/**
 * クライアント 1 件を引く（admin-worker のクライアント詳細ページ用、#473）。
 *
 * **`listOAuthClients` を引いて呼ぶ側で 1 件に絞らないこと。** `getUser`
 * と同じ判断——画面に出すのは常に 1 行なのに、取得の重さだけが登録数に
 * 比例する形にしない（`GetUserDelegatedInput` の冒頭を参照）。
 */
export const getOAuthClientDelegatedInputSchema = z.object({
  actorUserId: z.string().min(1),
  clientId: z.string().min(1).max(255),
});
export type GetOAuthClientDelegatedInput = z.infer<typeof getOAuthClientDelegatedInputSchema>;

/**
 * **存在しない `clientId` は `not_found`。** `getUser` と同じ意味——
 * 「管理機能を隠す」ためのものではなく、文字どおり「その行が無い」。
 *
 * **呼ぶ側はこれを行き止まりにしないこと。** `getUser` の JSDoc と同じ理由。
 */
export type GetOAuthClientDelegatedResult = RpcResult<OAuthClientSummary>;

// ------------------------------------------------------- countOAuthClients

/**
 * 登録数（admin-worker のホーム用、#449）。**`listOAuthClients` を呼んで
 * 数えないこと。** 集計は auth-worker 側の `count(*)` 1 本で行う
 * （`OAuthClientRepository.count()` の冒頭を参照）。
 */
export const countOAuthClientsDelegatedInputSchema = z.object({
  actorUserId: z.string().min(1),
});
export type CountOAuthClientsDelegatedInput = z.infer<typeof countOAuthClientsDelegatedInputSchema>;
export type CountOAuthClientsDelegatedResult = RpcResult<number>;

// ------------------------------------------------------------- countUsers

/**
 * 利用者数（admin-worker のホーム用、#512）。`countOAuthClients`
 * （#449）と同じ判断で、`listUsers` を呼んで数えない——集計は
 * auth-worker 側の `count(*) ... group by status` 1 本で行う
 * （`UserRepository.countByStatus()` の冒頭を参照）。
 *
 * **`deleted` も含めて返す。** ホームの NFC カードの塊が「未紐づけ /
 * 有効 / 無効化済み」の 3 つを並べて出しているのに揃えた——1 つの
 * 状態だけを隠すと、カードの行と並んだときに「合計が合わない」と
 * 運用者を混乱させる（issue #512 の指摘）。退会者数を常時見せたい
 * かは別の議論だが、**出す/出さないを決めるより、3 状態を一貫して
 * 出すほうが単純**で、`group by` が既に全状態の件数を計算している
 * ので追加のクエリも要らない。
 */
export const countUsersDelegatedInputSchema = z.object({
  actorUserId: z.string().min(1),
});
export type CountUsersDelegatedInput = z.infer<typeof countUsersDelegatedInputSchema>;
export type CountUsersDelegatedResult = RpcResult<{
  readonly active: number;
  readonly suspended: number;
  readonly deleted: number;
}>;

// ------------------------------------------------------- createOAuthClient

export const createOAuthClientDelegatedInputSchema = z.object({
  actorUserId: z.string().min(1),
  /**
   * `client_id` は受け取らない。**`IdentityAdminRpcContract` 側（#408）と
   * 揃えた** —— `CreateOAuthClientUseCase` と同じ理由で自動生成する。
   */
  name: z.string().min(1).max(255),
  clientType: z.enum(["confidential", "public"]),
  redirectUris: z.array(z.string().min(1).max(2048)).min(1).max(16),
  scopes: z.array(z.string().min(1).max(64)).min(1).max(16).optional(),
  logoUrl: z.string().max(2048).nullable().optional(),
});
export type CreateOAuthClientDelegatedInput = z.infer<typeof createOAuthClientDelegatedInputSchema>;
export type CreateOAuthClientDelegatedResult = RpcResult<{
  readonly client: OAuthClientSummary;
  readonly clientSecret: string | null;
}>;

// ------------------------------------------------------ disableOAuthClient

export const disableOAuthClientDelegatedInputSchema = z.object({
  actorUserId: z.string().min(1),
  clientId: z.string().min(1).max(255),
});
export type DisableOAuthClientDelegatedInput = z.infer<
  typeof disableOAuthClientDelegatedInputSchema
>;
export type DisableOAuthClientDelegatedResult = RpcResult<{ readonly disabled: boolean }>;

// ------------------------------------------------------ setOAuthClientOwner

export const setOAuthClientOwnerDelegatedInputSchema = z.object({
  actorUserId: z.string().min(1),
  clientId: z.string().min(1).max(255),
  /** `null` で持ち主を外す。 */
  ownerUserId: z.string().min(1).max(64).nullable(),
});
export type SetOAuthClientOwnerDelegatedInput = z.infer<
  typeof setOAuthClientOwnerDelegatedInputSchema
>;
export type SetOAuthClientOwnerDelegatedResult = RpcResult<null>;

// ---------------------------------------------------- setOAuthClientAppUrl

export const setOAuthClientAppUrlDelegatedInputSchema = z.object({
  actorUserId: z.string().min(1),
  clientId: z.string().min(1).max(255),
  /** `null` で外す。形式（`https:` のみ・資格情報を含まない）は auth-worker 側で確かめる。 */
  appUrl: z.string().min(1).max(2048).nullable(),
});
export type SetOAuthClientAppUrlDelegatedInput = z.infer<
  typeof setOAuthClientAppUrlDelegatedInputSchema
>;
export type SetOAuthClientAppUrlDelegatedResult = RpcResult<null>;

// ---------------------------------------------------------- listAuditLogs

export const listAuditLogsDelegatedInputSchema = z.object({
  actorUserId: z.string().min(1),
  event: z.string().min(1).max(64).optional(),
  userId: z.string().min(1).max(64).optional(),
  outcome: z.enum(["success", "failure"]).optional(),
  cursor: z.string().min(1).max(64).optional(),
  limit: z.number().int().min(1).max(200).optional(),
});
export type ListAuditLogsDelegatedInput = z.infer<typeof listAuditLogsDelegatedInputSchema>;
export type ListAuditLogsDelegatedResult = RpcResult<{
  readonly entries: readonly AuditLogEntryAdmin[];
  readonly nextCursor: string | null;
}>;

/**
 * `IdentityAdminDelegatedRPC` の契約。
 *
 * **メソッドが増えるたびに、ここと Entrypoint の両方を変えること。**
 * Service Binding はメソッド単位で絞れないので、この Entrypoint を
 * 束縛した Worker は定義した全メソッドを呼べる —— 束縛先は admin-worker
 * だけにすること（`scripts/check-service-bindings.mjs`）。
 */
export interface IdentityAdminDelegatedRpcContract {
  listUsers(input: ListUsersDelegatedInput): Promise<ListUsersDelegatedResult>;
  /**
   * 1 人だけを引く（#455）。**読み取りなので `actorUserId` の実在確認も
   * しない**（`listUsers` と同じ扱い。監査ログに 1 行も書かない）。
   */
  getUser(input: GetUserDelegatedInput): Promise<GetUserDelegatedResult>;
  /**
   * まとめ引き（#471）。**読み取りなので `actorUserId` の実在確認もしない**
   * （`getUser` と同じ扱い。監査ログに 1 行も書かない）。
   */
  getUsersByIds(input: GetUsersByIdsDelegatedInput): Promise<GetUsersByIdsDelegatedResult>;
  suspendUser(input: SuspendUserDelegatedInput): Promise<SuspendUserDelegatedResult>;
  reinstateUser(input: ReinstateUserDelegatedInput): Promise<ReinstateUserDelegatedResult>;
  revokeUserSessions(
    input: RevokeUserSessionsDelegatedInput,
  ): Promise<RevokeUserSessionsDelegatedResult>;
  listOAuthClients(input: ListOAuthClientsDelegatedInput): Promise<ListOAuthClientsDelegatedResult>;
  /**
   * クライアント 1 件だけを引く（#473）。**`getUser` と同じ扱い**——
   * 読み取りなので `actorUserId` の実在確認もせず、監査ログにも書かない。
   */
  getOAuthClient(input: GetOAuthClientDelegatedInput): Promise<GetOAuthClientDelegatedResult>;
  countOAuthClients(
    input: CountOAuthClientsDelegatedInput,
  ): Promise<CountOAuthClientsDelegatedResult>;
  countUsers(input: CountUsersDelegatedInput): Promise<CountUsersDelegatedResult>;
  createOAuthClient(
    input: CreateOAuthClientDelegatedInput,
  ): Promise<CreateOAuthClientDelegatedResult>;
  disableOAuthClient(
    input: DisableOAuthClientDelegatedInput,
  ): Promise<DisableOAuthClientDelegatedResult>;
  setOAuthClientOwner(
    input: SetOAuthClientOwnerDelegatedInput,
  ): Promise<SetOAuthClientOwnerDelegatedResult>;
  setOAuthClientAppUrl(
    input: SetOAuthClientAppUrlDelegatedInput,
  ): Promise<SetOAuthClientAppUrlDelegatedResult>;
  listAuditLogs(input: ListAuditLogsDelegatedInput): Promise<ListAuditLogsDelegatedResult>;
}

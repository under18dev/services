/**
 * dashboard-worker 側のエラー。
 *
 * auth-worker の失敗をそのまま外へ流さず、この層の語彙へ翻訳する。
 * 「Identity が落ちている」と「セッションが無効」はユーザーへの見せ方が違う。
 */
export type IdentityFailure =
  /** 認証されていない。ログイン画面へ誘導する。 */
  | { readonly kind: "unauthenticated" }
  /** 操作が許可されていない。 */
  | { readonly kind: "forbidden" }
  /** 対象が見つからない。 */
  | { readonly kind: "not_found" }
  /** auth-worker 側の障害・タイムアウト。再試行の案内を出す。 */
  | { readonly kind: "identity_unavailable"; readonly detail: string };

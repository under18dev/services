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
  /**
   * 再認証が要る（#11 / #75）。
   *
   * **`forbidden` と分ける。** 利用者への見せ方が違う —— こちらは
   * 「もう一度ログインすれば通る」で、権限が無いわけではない。
   * 畳むと画面が「権限がありません」と出すしかなくなり、
   * 何をすれば進めるのか分からなくなる。
   */
  | { readonly kind: "reauthentication_required" }
  /** いまの状態では通らない（username の重複、管理者の最後の Passkey）。 */
  | { readonly kind: "conflict" }
  /** auth-worker 側の障害・タイムアウト。再試行の案内を出す。 */
  | { readonly kind: "identity_unavailable"; readonly detail: string };

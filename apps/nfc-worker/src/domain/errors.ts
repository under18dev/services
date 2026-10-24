/**
 * nfc-worker の失敗。
 *
 * auth-worker の `RpcErrorCode` をそのまま外へ流さず、この Worker の語彙へ
 * 翻訳する（dashboard-worker の `IdentityFailure` と同じ方針）。
 *
 * ## `not_found` に畳む対象が広いこと
 *
 * 「カードが存在しない」「他人のカードだった」「無効化済み」は
 * **すべて `card_not_found`** にする。区別して返すと、カード ID を
 * 総当たりする相手に「その ID は実在する」「誰かが持っている」と
 * 教えることになる（仕様書 9 の列挙対策）。
 * 所有者本人は自分のカード一覧を見られるので、区別が無くて困らない。
 */
export type NfcFailure =
  /** ログインしていない / セッションが無効。 */
  | { readonly kind: "unauthenticated" }
  /** 対象のカードが無い、または自分のものではない。区別しない。 */
  | { readonly kind: "card_not_found" }
  /** 入力が不正。理由コードは所有者本人にだけ返す。 */
  | { readonly kind: "invalid_target_url"; readonly reason: string }
  /** 紐づけコードが違う・期限切れ・既に使用済み。理由は区別しない。 */
  | { readonly kind: "claim_rejected" }
  /** auth-worker 側の障害・タイムアウト。 */
  | { readonly kind: "identity_unavailable"; readonly detail: string };

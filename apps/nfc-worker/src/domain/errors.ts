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
  /**
   * 紐づけが通らなかった。**理由は区別しない**（#358）。
   *
   * カードが無い・既に誰かのもの・無効化済みをすべてここへ畳む。
   * 区別すると、カード ID を総当たりする相手に「その ID は実在する」と
   * 教える。**何を区別して何を区別しないかは
   * `domain/services/disclosure.ts` が 1 箇所で決めている。**
   */
  | { readonly kind: "claim_rejected" }
  /**
   * 管理者だけが行える操作を、管理者でない利用者が叩いた（#187）。
   *
   * **`card_not_found` に畳まない。** 畳む理由は「ID を総当たりされると
   * 実在が漏れる」ことだが、**発行エンドポイントの存在は秘密ではない**
   * （仕様書にもコードにも書いてある）。畳むと、権限を外された運営者が
   * 「壊れている」と誤解するほうの損が大きい。
   */
  | { readonly kind: "forbidden" }
  /** auth-worker 側の障害・タイムアウト。 */
  | { readonly kind: "identity_unavailable"; readonly detail: string };

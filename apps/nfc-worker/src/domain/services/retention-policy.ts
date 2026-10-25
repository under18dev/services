/**
 * `nfc_card_events` の保持期限（仕様書 §9 Privacy / §10）。
 *
 * ## なぜ要るのか
 *
 * **このテーブルには掃除する経路が 1 つも無かった。** Identity 側の
 * `RetentionPolicy` は `u18-identity` の 5 テーブルだけを見ており、
 * nfc は別 D1 なので対象外である。結果、`actor_user_id` を持つ行——
 * 「誰がいつどのカードを操作したか」——が無期限に残る状態だった。
 *
 * 仕様書 §9 Privacy は保持期間の明示を要求しているので、
 * **「決めていない」こと自体が要求を満たしていない**。
 *
 * ## auth-worker の `RetentionPolicy` と分けてある
 *
 * 共有しない理由は `packages/nfc-db/src/schema/_shared.ts` と同じで、
 * 共有した瞬間に nfc-worker の依存グラフから Identity 側のテーブル定義が
 * 見える。定数 2 つの重複より境界のほうが大事である。
 *
 * **区分の考え方は意図的に揃えてある。** Identity 側が「アカウントの
 * 支配権が変わる操作」を長期側に置いているのと同じ基準で、こちらは
 * 「カードの支配権が変わる操作」を長期側に置く。
 */

/**
 * 記録するイベント名の登録簿。
 *
 * **`string` ではなく閉じた集合にする。** Identity 側の `AUDIT_EVENTS`
 * （#123）と同じ理由で、typo が黙って通ると調査のときに
 * 「このイベントが 1 件も出てこない」で初めて気づくことになる。
 *
 * **`card.issued` は入れていない。** スキーマのコメントが例として
 * 挙げているが、`src` のどこからも発行されていない。カードの発行は
 * 運用スクリプトが行い、行の存在自体が発行の記録になっている。
 * 発行するようになったら、ここへ足すと区分の判断を迫られる。
 */
export const NFC_CARD_EVENTS = [
  /** 紐づけ。**カードの支配権が移った瞬間。** */
  "card.claimed",
  /** 所有者が自分で紐づけを解除した。支配権の移動の片割れ。 */
  "card.released",
  /** 遷移先の変更。所有者が何度でも行う。 */
  "card.target_updated",
  /** 無効化（紛失・不正利用）。運営の操作。 */
  "card.disabled",
] as const;

export type NfcCardEventName = (typeof NFC_CARD_EVENTS)[number];

/**
 * 保持区分。
 *
 * ## 量では分けていない
 *
 * 4 つとも所有者か運営の操作で、**リダイレクト解決（1 タップごと）は
 * そもそも記録していない。** だから Identity 側と違って「量が多いから
 * 短く」という軸が使えない。
 *
 * 分けているのは**価値の減り方**である。「誰がこのカードを取ったか」は
 * 争いになってから訊かれる質問で、**遅れて効いてくる**。一方「いつ
 * 遷移先を変えたか」は、現在の遷移先が分かれば足りることがほとんどで、
 * 古くなるほど価値が下がる。
 */
export type NfcRetentionTier = "standard" | "ownership";

export const NfcRetention: Readonly<Record<NfcRetentionTier, number>> = {
  /** 180 日。Identity 側の `AuditRetention.standard` と揃える。 */
  standard: 180 * 24 * 60 * 60 * 1000,
  /**
   * 2 年。Identity 側の `AuditRetention.security` と揃える。
   *
   * カードの奪取（配布前にタグを読んで先に claim する、など）は、
   * **気づくのが遅い。** 文化祭で配ったカードの所有権が争いになるのは
   * 配布の当日ではなく、後から「自分のはずだ」と言われたときである。
   */
  ownership: 2 * 365 * 24 * 60 * 60 * 1000,
};

/**
 * **`Record<NfcCardEventName, …>` にしてある。** イベントを足すと
 * ここがコンパイルエラーになり、区分を決めないと通らない。
 * 既定へ黙って落とすと、新しい「支配権が変わる操作」が 180 日で消える
 * 状態が無言で生まれる（Identity 側の `AUDIT_EVENT_RETENTION` と同じ手当て）。
 */
export const NFC_EVENT_RETENTION: Readonly<Record<NfcCardEventName, NfcRetentionTier>> = {
  "card.claimed": "ownership",
  "card.released": "ownership",
  /**
   * 遷移先の変更は `standard`。**現在の遷移先は `nfc_cards.target_url` に
   * 残る**ので、古い変更履歴が消えても「いまどこへ飛ぶか」は分かる。
   */
  "card.target_updated": "standard",
  /**
   * 無効化も `standard`。**カードが止まっている事実は `nfc_cards.status`
   * に残り続ける**ので、消えるのは「いつ止めたか」だけである。
   */
  "card.disabled": "standard",
};

/** 1 回の掃除で消す上限。Identity 側の `RETENTION_SWEEP_LIMIT` と同じ根拠。 */
export const NFC_SWEEP_LIMIT = 1_000;

/**
 * イベント名ごとの境界時刻。
 *
 * 全イベントを返す（Identity 側は既定と違うものだけ返したが、こちらは
 * 4 件しかないので全部渡すほうが読みやすい）。
 */
export function nfcEventDeadlines(now: Date): ReadonlyMap<NfcCardEventName, Date> {
  const deadlines = new Map<NfcCardEventName, Date>();
  for (const event of NFC_CARD_EVENTS) {
    deadlines.set(event, new Date(now.getTime() - NfcRetention[NFC_EVENT_RETENTION[event]]));
  }
  return deadlines;
}

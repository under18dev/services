/**
 * `nfc_cards.disabled_reason` のうち、戻す側のコードが読む値（#436）。
 *
 * ## なぜ `"admin_action"` を使い回さなかったのか
 *
 * 単発の運営操作（`AdminDisableCardUseCase` / `DelegatedDisableCardUseCase`）
 * も、batch 一括無効化（`DelegatedBatchDisableCardsUseCase`）も、これまで
 * 同じ `"admin_action"` を書いていた。**`batch` 列はカードの配布ロット
 * （発行時に決まる）であって、無効化した操作を表すものではない** ——
 * 同じロットのカードが「一括無効化」と「単発の運営操作」の両方で
 * `disabled` になりうる。
 *
 * batch 一括復帰（`DelegatedReinstateBatchToIssuedCardsUseCase`）は
 * 「このバッチ名で一括無効化されたカードだけ」を戻したい。`"admin_action"`
 * のままだと、**たまたま同じバッチのカードを個別に無効化した 1 枚**まで
 * WHERE 句に含めてしまう——単発の判断で止めた理由を一括操作が消してよい
 * わけがない（運用者の指摘）。
 *
 * そこで batch 一括無効化だけ、専用のコードを書く。`disabled_reason` は
 * 元々「理由コード」として作られた列（`packages/nfc-db/src/schema/cards.ts`）
 * なので、新しい区別を増やすのに合っている。
 *
 * ## 選ばなかった案
 *
 * nfc_card_events の `metadata.batch` を読んで判定する案も検討した——
 * あちらは既に batch 一括無効化だけが書いている値で、過去の行にも
 * 遡って効く。**採らなかった理由は、`CardRepository`（`nfc_cards` だけを
 * 見る）に `nfc_card_events` を JOIN させる形になり、Port の境界を越える
 * ため。** 列 1 つの UPDATE/WHERE で足りる話に、テーブルをまたぐ相関
 * サブクエリを持ち込む代償のほうが大きいと判断した。
 *
 * ## このコードを書く前に無効化されていた行は対象外のまま
 *
 * #436 より前に batch 一括無効化で `disabled` になった行は
 * `disabled_reason = "admin_action"` のままで、新しい一括復帰には
 * 引っかからない——安全側（戻し漏れ）に倒れるだけで、誤って他人の
 * 単発操作を巻き込む方向には倒れない。本番にこの行が実在するかは
 * 確かめていない（読み取りの許可が無い）。もし実在すれば、個別の
 * 行を見ながら運用側で判断すること。
 */
export const ADMIN_BATCH_DISABLED_REASON = "admin_batch";

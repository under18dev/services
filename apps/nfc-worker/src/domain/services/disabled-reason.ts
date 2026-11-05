/**
 * `nfc_cards.disabled_reason` のうち、戻す側のコードが読む値（#436）。
 *
 * ## なぜ `"admin_action"` を使い回さなかったのか
 *
 * 単発の運営操作（`DelegatedDisableCardUseCase`）
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

/**
 * 単発の運営操作（`DelegatedDisableCardUseCase`）の既定値（#486 で
 * 定数へ切り出した）。
 *
 * **#436 の時点では切り出していなかった。** あのときは「使い回さなかった
 * 値」として比較に出てくるだけで、コード側で分岐の既定値として参照する
 * 必要が無かった。#486 で `DelegatedDisableCardUseCase` が理由を選べる
 * ようになり（`reason?: string`）、**省略時の既定値をコードから参照する
 * 必要が生まれた**ので、他の 2 つと同じ形で定数にする。
 */
export const ADMIN_ACTION_DISABLED_REASON = "admin_action";

/**
 * アカウントの凍結に連動してカードを止めたときの理由（#486）。
 *
 * ## なぜ `"admin_action"` を使い回さなかったのか
 *
 * `ADMIN_BATCH_DISABLED_REASON` とまったく同じ判断である。凍結の解除
 * （ランブック §11.5）で運用者が知りたいのは「**この凍結のせいで
 * 止まったカードはどれか**」——`"admin_action"` のままだと、**その人が
 * 別の理由（紛失の申告など）で前に単発操作で止めた 1 枚**と区別が
 * 付かない。「無効化は片道」なので、間違えて戻すと元に戻せない
 * （この issue 自体は凍結解除での自動復帰を作らないが、**理由コードを
 * 分けておかないと、将来それを作るときの WHERE 句が書けない**）。
 *
 * ## なぜ `"owner_suspended"` で、`"owner_account_disabled"` ではないか
 *
 * トリガーは `users.status` が `"suspended"` になったことで、
 * admin-worker / auth-worker 全体がこの状態をずっと `"suspended"` と
 * 呼んでいる（`UserAdminSummary.status` 等）。`"disabled"` という別の
 * 語を当てると、同じ状態に 2 つの呼び名ができるうえ、
 * `nfc_cards.disabled_reason` という列自体が「`disabled` な理由」として
 * 読まれる文脈でもう一度 `"disabled"` を使うことになり、**「カードが
 * disabled なのは disabled だから」という同語反復**に見える。
 *
 * ランブックの手書き SQL（`nfc_card_events` への INSERT）は
 * `json_object('reason', 'owner_account_disabled')` と書いていたが、
 * **これは別の列（`nfc_card_events.metadata.reason`、自由記述の JSON）
 * への一度きりの例であって、型で守られたコードでも、他の読み出しが
 * 使っているフィルタ条件でもない。** しかも同じランブックの
 * `nfc_cards.disabled_reason` 列への UPDATE は実は `'ops'` を使っており
 * （下の節を参照）、**2 つの既存ランブック値はそもそも揃っていない**
 * ——どちらか一方に寄せる理由にならない。このコードと一緒に、
 * ランブックの手書き SQL 自体を消す（#486 の範囲）。
 *
 * ## `'ops'` の行について
 *
 * **過去の話ではない。** ランブック §11 ステップ 6（アカウント凍結に
 * 伴うカード無効化）の手書き SQL は #486 で画面に置き換えて消したが、
 * **§12.4(5)（孤立カードへの運用対応——`nfc_cards.owner_user_id` が
 * 存在しない利用者を指すケース）は、対象の利用者自体が存在しないため
 * 画面で置き換えられず、SQL のまま残してある。** `disabled_reason = 'ops'`
 * は**いまも、これからも書かれ続ける**（admin-worker の表示側も同じ
 * 事実を指す——`ui/nfc-analytics-page.tsx` の無効化理由のラベルが
 * `ops: "孤立カードへの運用対応（ランブック §12.4(5)）"` と出典つきで
 * 書いている）。
 *
 * `owner_suspended` を条件にする読み出し（凍結起因で止めた枚数、将来の
 * 「凍結解除で戻す」一括操作の WHERE 句）には `'ops'` の行は引っかからない
 * ——**安全側（戻し漏れ）に倒れるだけで、巻き込みにはならない。** `'ops'`
 * 行を「このアカウントの凍結が原因」と取り違えて勝手に復帰させる経路は
 * 無い。実在する `'ops'` の行を復帰させたい場合は、運用側で個別に監査
 * ログ / `nfc_card_events` を見ながら判断すること。
 */
export const OWNER_SUSPENDED_DISABLED_REASON = "owner_suspended";

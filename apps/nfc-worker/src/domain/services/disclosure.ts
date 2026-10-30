import type { Card } from "../entities/card";

/**
 * **カードについて外へ漏らしてよい区別は、ここだけが決める**（#358）。
 *
 * ## なぜ 1 箇所に集めるのか
 *
 * #358 の前、区別しないという判断は `redirect.routes.ts` の
 * `NOT_FOUND_BODY` のコメントにだけ書かれていた。入口が 1 つだったので
 * それで足りていた。
 *
 * **#358 で入口が 2 つになる。** タップの解決（`GET /c/:cardId`）と、
 * 紐づけの画面（`GET /account/nfc/claim?card=...`）が、**同じカードについて
 * 別々に「何を見せるか」を決める**ことになる。2 箇所で同じ判断を書くと、
 * 片方だけが緩む —— このリポジトリが何度も踏んでいる形である
 * （#211 は Worker 間、#292 は部分一致のアサーション、#310 は検査の範囲）。
 *
 * だから**判断はこの関数 1 本にして、入口は結果の振り分けだけを行う。**
 *
 * ## 区別するもの / しないもの
 *
 * **区別するのは「いま紐づけられるか」だけ。** それ以外はすべて 1 つに畳む。
 *
 * | カードの状態 | `/c/:cardId`（未認証・誰でも叩ける） | 紐づけ画面（ログイン済み） |
 * | --- | --- | --- |
 * | 存在しない | `concealed` | `concealed` |
 * | `issued`（未紐づけ） | **`claimable`** → 紐づけ画面へ送る | **`claimable`** → 紐づけの入口を出す |
 * | `active` + 遷移先あり | `resolvable` → 302 | `concealed`（**他人のもの**） |
 * | `active` + 遷移先なし | `concealed` | `concealed` |
 * | `disabled` | `concealed` | `concealed` |
 *
 * **`resolvable` と `concealed` の差は、タップの解決にしか無い。**
 * 紐づけ画面はこの 2 つを同じものとして扱う（下の `isConcealedForClaim`）。
 * そうしないと「他人のカードだ」と「そんなカードは無い」が区別でき、
 * カード ID の総当たりに意味が出る。
 *
 * ## 漏れる 1 ビットと、その代償
 *
 * `claimable` を区別する以上、**「この ID は実在し、まだ誰のものでもない」
 * が外から分かる。** これは #358 の機能そのものなので受け入れる。
 *
 * 成り立つ前提は **カード ID が当て推量できないこと**で、
 * `newCardId()` の 100 ビットがそれを担っている。nfc-worker には
 * レート制限が無いが（`wrangler.jsonc` に `ratelimits` が 1 つも無い）、
 * 1 万枚・毎秒 1 万回でも最初の 1 枚に当たるまで 4,000 兆年なので、
 * **この脅威に対してレート制限の有無は結論を変えない。**
 * 入れる理由があるとすれば D1 読み取りのコストと可用性のほうである。
 *
 * ## `disabled` を一緒に緩めないこと
 *
 * **`disabled` は「存在しない」と区別が付かないままにする。** 紛失して
 * 止めたカードを拾った人間に「このカードは止められている」と教えない ——
 * 教えると、持ち主を探す動機と、再発行を待ち伏せる手掛かりを与える。
 * #358 が緩めたのは `issued` の 1 ビットだけである。
 */
export type CardDisclosure =
  /** 解決してよい。`targetUrl` は `https:` であることが確かめ済み。 */
  | { readonly kind: "resolvable"; readonly targetUrl: string }
  /** まだ誰のものでもない。タップした人が自分のものにできる。 */
  | { readonly kind: "claimable" }
  /** 何も言わない。**存在しないカードと 1 バイトも変えない。** */
  | { readonly kind: "concealed" };

/** 畳んだ先。毎回オブジェクトを作らないのは、同一性を比べたくなる余地を消すため。 */
export const CONCEALED: CardDisclosure = { kind: "concealed" };

/**
 * カード 1 枚について、外へ出してよい区別を決める。
 *
 * **`null`（存在しない）も引数に取る。** 呼び出し側に「見つからなかった
 * 場合」を書かせると、そこが 2 つ目の判断箇所になる。
 */
export function discloseCard(card: Card | null): CardDisclosure {
  if (card === null) return CONCEALED;

  // 順序が意味を持つ。`resolvable` と `claimable` は状態で排他なので
  // 入れ替えても結果は同じだが、**上から読んで「どちらでもなければ畳む」**
  // と読めるようにしてある。
  if (card.isResolvable()) {
    const targetUrl = card.targetUrl;
    // `isResolvable()` が null を落としているが、ここでも確かめる。
    // 将来 `isResolvable()` の条件が緩んだときに、空文字へ 302 しない。
    if (targetUrl === null) return CONCEALED;
    return { kind: "resolvable", targetUrl };
  }

  if (card.isClaimable()) return { kind: "claimable" };

  return CONCEALED;
}

/**
 * 紐づけ画面から見て、何も言わないほうへ畳むか。
 *
 * **`resolvable` もここでは畳む。** 所有者がいるカードを「他人のもの」として
 * 見せると、存在しないカードとの差が出る。上の表の 2 列目と 3 列目が
 * 違うのはこの 1 行のためで、**差をここへ閉じ込めてある。**
 */
export function isConcealedForClaim(disclosure: CardDisclosure): boolean {
  return disclosure.kind !== "claimable";
}

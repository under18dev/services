import { hashedFileName } from "@u18/web-ui";
import { CARDS_UI_PATH } from "../base-path";
import { CARDS_ISLAND_JS } from "./generated/cards-island.bundle";
import { KIWA_STYLESHEET } from "./generated/kiwa-stylesheet";

/**
 * この Worker が配信する静的アセットのパス。
 *
 * ## なぜ借りるのをやめたか（#211）
 *
 * カード一覧は長らく auth-worker の `/ui/u18.css` を**借りていた**。
 * 本番 route が `auth.under18.dev/account/nfc/*` なので、同一オリジンの
 * auth-worker（`auth.under18.dev/*`）に当たるからである。
 *
 * **#211 で auth-worker の URL に内容ハッシュが入り、`/ui/u18.css` は
 * 404 になった。** 借りている側は何も変えていないので、**画面は描かれる
 * がスタイルが当たらない。** 500 にもならず外形監視にも出ない。
 *
 * ここで重要なのは、**どちらのテストもそれを見られなかった**ことである
 * —— nfc のテストは `u18.css` を一度も見ておらず、auth のテストは nfc が
 * 何を参照しているかを知らない。**依存が Worker をまたいで HTTP の上に
 * あり、両側のテストが自分の Worker の内側に閉じていた**（脅威モデル
 * §4.4 の家系。#216 は npm スクリプトと wrangler の間、#217 は route 解決と
 * Worker の間、#226 はブラウザと Worker の間、これは Worker と Worker の間）。
 *
 * **同じハッシュを計算する形にもできたが、採らなかった。** それは
 * 「両方が同じ関数を呼んでいる」ことしか保証せず、auth が配信をやめた
 * 瞬間にまた黙って壊れる。借りる関係そのものを消すほうを選んだ。
 *
 * **この判断は Kiwa UI へ移っても変わらない**（#338）。配信する中身が
 * 手書きの `UI_STYLESHEET` から Tailwind の出力に替わっただけで、
 * 「自分の画面が読むものは自分で配信する」は同じである。共有している
 * のはトークンと primitives（`@u18/web-ui`）のほうで、**URL は共有
 * しない。**
 *
 * ## `u18.css` はもう配信していない（#338）
 *
 * カード一覧が Kiwa UI へ移り、**この Worker の画面は手書き CSS を 1 枚も
 * 読まなくなった。** 配信ルートだけを残すと「誰も参照しないアセット」に
 * なる —— `test/asset-coverage.test.ts` がまさにそれを落とす検査なので、
 * 残すなら理由を宣言することになる。宣言できる理由が無いので消した。
 */

/**
 * Kiwa UI のスタイルシート（#332 / #338）。
 *
 * ## 中身はビルドが作るが、ハッシュはここが計算する
 *
 * `scripts/build-client.mjs` が Tailwind を回して
 * `generated/kiwa-stylesheet.ts` を書く。**ハッシュをビルドに計算させて
 * いない** —— `hashedFileName` が**配信するのと同じ文字列**から出すので、
 * 生成が古くても URL が古いほうのハッシュになる（#211 / #132）。
 *
 * ## dashboard-worker と同じ内容だが、URL は別である
 *
 * 走査対象が Worker ごとに違うので、**出力が一致する保証は無い**
 * （あちらの画面にしか無い class は、こちらの CSS に入らない）。
 * ハッシュが偶然一致することはあっても、**それに依って借りないこと。**
 * 上の #211 がその形で壊れている。
 */
export const KIWA_STYLESHEET_ROUTE = `/ui/${hashedFileName("kiwa.css", KIWA_STYLESHEET)}`;
export const KIWA_STYLESHEET_PATH = `${CARDS_UI_PATH}${KIWA_STYLESHEET_ROUTE}`;

/**
 * カード画面のアイランド（#338）。
 *
 * **dashboard-worker のものは借りられない。** あちらの
 * `account-island.js` はセッション・パスキー・連携アプリの取り消しで、
 * 中身が別物である。借りる関係を作らない理由は上の #211 と同じ。
 *
 * URL に内容ハッシュが入るので `immutable` で配信してよい。
 */
export const ISLAND_ROUTE = `/ui/${hashedFileName("cards-island.js", CARDS_ISLAND_JS)}`;
export const ISLAND_PATH = `${CARDS_UI_PATH}${ISLAND_ROUTE}`;

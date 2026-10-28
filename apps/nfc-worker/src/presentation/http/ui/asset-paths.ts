import { hashedFileName, UI_STYLESHEET } from "@u18/web-ui";
import { CARDS_UI_PATH } from "../base-path";

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
 * 代償は、同じ CSS を 2 つの Worker が配信することである。中身は
 * `@u18/web-ui` の 1 つで、どちらもバンドルに文字列として持っている
 * （dashboard-worker も同じ形）。
 */

export const STYLESHEET_ROUTE = `/ui/${hashedFileName("u18.css", UI_STYLESHEET)}`;
export const STYLESHEET_PATH = `${CARDS_UI_PATH}${STYLESHEET_ROUTE}`;

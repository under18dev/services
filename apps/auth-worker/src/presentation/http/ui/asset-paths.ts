/**
 * この Worker が配信する静的アセットのパス。
 *
 * **ページ側（`<link>` / `<script>`）と配信ルートの両方がここを見る。**
 * 文字列を各所に直接書くと、パスを変えたときに片方だけ直る —— ページは
 * 古いパスを参照し続け、**ブラウザが 404 を踏むだけで、型検査もテストも
 * 何も言わない。** スタイルシートなら「素の HTML が出る」、アイランドなら
 * 「ボタンが黙って効かなくなる」という形で出る。
 *
 * このリポジトリで繰り返している「宣言はあるが繋がっていない」
 * （#88 / #96 / #122 / #164）と同じ型の事故なので、名前を 1 つにしておく。
 */

/**
 * ## URL に内容ハッシュが入る（#211）
 *
 * `hashedFileName()` が配信する文字列そのものからファイル名を作るので、
 * **中身が変われば URL も変わる。** デプロイ直後に古いアセットと新しい
 * サーバーが重なる窓が消え、`immutable` で配信できる。
 *
 * **実行時に決まるので、テストやページから文字列を書き写さないこと。**
 * ここを import すれば常に正しい値になる。
 */
import { hashedFileName } from "@u18/web-ui";
import { LOGIN_ISLAND_JS } from "./generated/login-island.bundle";
import { KIWA_STYLESHEET } from "./generated/kiwa-stylesheet";

/** ログイン画面のクライアントアイランドの配信先。 */
export const LOGIN_ISLAND_PATH = `/ui/${hashedFileName("login-island.js", LOGIN_ISLAND_JS)}`;

/**
 * Kiwa UI のスタイルシート（#332 の P2）。
 *
 * **この Worker が配信するスタイルシートはこれ 1 本である。** 手書きの
 * `u18.css` は同意画面が Kiwa へ移った時点で読む人がいなくなり、配信も
 * 定義（`@u18/web-ui` の `styles.ts`）ごと消えた。
 *
 * ## 中身はビルドが作るが、ハッシュはここが計算する
 *
 * `scripts/build-client.mjs` が Tailwind を回して
 * `generated/kiwa-stylesheet.ts` を書く。**ハッシュをビルドに計算させて
 * いない** —— `hashedFileName` が**配信するのと同じ文字列**から出すので、
 * 生成が古くても URL が古いほうのハッシュになる（#211 / #132）。
 */
export const KIWA_STYLESHEET_PATH = `/ui/${hashedFileName("kiwa.css", KIWA_STYLESHEET)}`;

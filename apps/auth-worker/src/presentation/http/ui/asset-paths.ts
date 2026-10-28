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
import { hashedFileName, UI_STYLESHEET } from "@u18/web-ui";
import { LOGIN_ISLAND_JS } from "./generated/login-island.bundle";

/** 共有スタイルシート（`@u18/web-ui` の `UI_STYLESHEET`）の配信先。 */
export const STYLESHEET_PATH = `/ui/${hashedFileName("u18.css", UI_STYLESHEET)}`;

/** ログイン画面のクライアントアイランドの配信先。 */
export const LOGIN_ISLAND_PATH = `/ui/${hashedFileName("login-island.js", LOGIN_ISLAND_JS)}`;

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
import { KIWA_STYLESHEET } from "./generated/kiwa-stylesheet";

/** 共有スタイルシート（`@u18/web-ui` の `UI_STYLESHEET`）の配信先。 */
export const STYLESHEET_PATH = `/ui/${hashedFileName("u18.css", UI_STYLESHEET)}`;

/** ログイン画面のクライアントアイランドの配信先。 */
export const LOGIN_ISLAND_PATH = `/ui/${hashedFileName("login-island.js", LOGIN_ISLAND_JS)}`;

/**
 * Kiwa UI のスタイルシート（#332 の P2）。
 *
 * **`u18.css` と両方を配信している。** ログイン画面（新規登録・コード
 * 入力・ログイン済みを含む）はこちらを読み、**同意画面はまだ手書きの
 * `u18.css`** である。移行の途中は必ずこの状態を通る。
 *
 * ## 1 枚のページに両方を読ませない
 *
 * Tailwind は preflight でブラウザ既定を潰す。手書き CSS はその既定を
 * 前提に書かれている（`body` の中央寄せ、`h2` の余白）ので、**同じ
 * ページに重ねると手書き側が崩れる。** `login.ui.test.ts` が
 * `<link rel="stylesheet">` がちょうど 1 本であることを見ている。
 *
 * ## 中身はビルドが作るが、ハッシュはここが計算する
 *
 * `scripts/build-client.mjs` が Tailwind を回して
 * `generated/kiwa-stylesheet.ts` を書く。**ハッシュをビルドに計算させて
 * いない** —— `hashedFileName` が**配信するのと同じ文字列**から出すので、
 * 生成が古くても URL が古いほうのハッシュになる（#211 / #132）。
 */
export const KIWA_STYLESHEET_PATH = `/ui/${hashedFileName("kiwa.css", KIWA_STYLESHEET)}`;

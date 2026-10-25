import { ACCOUNT_BASE_PATH } from "../base-path";

/**
 * この Worker が配信する静的アセットと画面のパス。
 *
 * ## `*_ROUTE` と `*_PATH` の 2 つがあるのはなぜか
 *
 * ルートは `root.basePath(ACCOUNT_BASE_PATH)` に登録するので、`app.get()` に
 * 渡すのは**接頭辞を除いた**パス（`/ui/u18.css`）。一方 HTML の
 * `<link href>` や `<a href>` に書くのは**接頭辞を含む**絶対パス
 * （`/account/ui/u18.css`）である。
 *
 * この 2 つを別々に手で書くと、**片方だけ直してブラウザが 404 を踏む**。
 * スタイルシートなら素の HTML が出るだけ、アイランドなら「ボタンが黙って
 * 効かない」という形で出る。このリポジトリで繰り返している「宣言はあるが
 * 繋がっていない」（#88 / #96 / #122 / #164）と同じ事故である。
 *
 * ここでは `*_PATH` を `*_ROUTE` から**テンプレートリテラル型で導出**して
 * いるので、`*_ROUTE` を変えると `*_PATH` も必ず付いてくる。片方だけ
 * 変えることが型の上でできない。
 */

/** 共有スタイルシート（`@u18/web-ui` の `UI_STYLESHEET`）。 */
export const STYLESHEET_ROUTE = "/ui/u18.css";
export const STYLESHEET_PATH = `${ACCOUNT_BASE_PATH}${STYLESHEET_ROUTE}` as const;

/**
 * クライアントアイランド（失効・解除の操作）。
 *
 * **スタイルシートと同じく `*_ROUTE` から `*_PATH` を導出する。** アイランドで
 * 片方だけ直すと「ボタンが黙って効かない」という形で出る —— 画面は
 * 正常に描画され、JS だけが 404 になるので、見た目では気づけない。
 */
export const ACCOUNT_ISLAND_ROUTE = "/ui/account-island.js";
export const ACCOUNT_ISLAND_PATH = `${ACCOUNT_BASE_PATH}${ACCOUNT_ISLAND_ROUTE}` as const;

/** アカウント概要（プロフィールと Passkey）。 */
export const OVERVIEW_ROUTE = "/";
export const OVERVIEW_PATH = ACCOUNT_BASE_PATH;

/** ログイン中の端末。 */
export const SESSIONS_ROUTE = "/sessions";
export const SESSIONS_PATH = `${ACCOUNT_BASE_PATH}${SESSIONS_ROUTE}` as const;

/** 連携を許可したアプリ（#18）。 */
export const GRANTS_ROUTE = "/grants";
export const GRANTS_PATH = `${ACCOUNT_BASE_PATH}${GRANTS_ROUTE}` as const;

/**
 * ログイン画面。**この Worker は配信しない** —— auth-worker が
 * `auth.under18.dev/login` で持っている（仕様書 §14.1 決定 1 により
 * 同一オリジン）。
 *
 * 接頭辞を付けないこと。`/account/login` は auth-worker へ届かない。
 */
export const LOGIN_PATH = "/login";

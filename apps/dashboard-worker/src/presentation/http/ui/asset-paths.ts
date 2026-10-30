import { hashedFileName } from "@u18/web-ui";
import { ACCOUNT_BASE_PATH } from "../base-path";
import { ACCOUNT_ISLAND_JS } from "./generated/account-island.bundle";
import { KIWA_STYLESHEET } from "./generated/kiwa-stylesheet";

/**
 * この Worker が配信する静的アセットと画面のパス。
 *
 * ## `*_ROUTE` と `*_PATH` の 2 つがあるのはなぜか
 *
 * ルートは `root.basePath(ACCOUNT_BASE_PATH)` に登録するので、`app.get()` に
 * 渡すのは**接頭辞を除いた**パス（`/ui/kiwa.<hash>.css`）。一方 HTML の
 * `<link href>` や `<a href>` に書くのは**接頭辞を含む**絶対パス
 * （`/account/ui/kiwa.<hash>.css`）である。
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

/**
 * ## URL に内容ハッシュが入る（#211）
 *
 * `hashedFileName()` が配信する文字列そのものからファイル名を作るので、
 * **中身が変われば URL も変わる。** デプロイ直後に古いアセットと新しい
 * サーバーが重なる窓が消え、`immutable` で配信できる。
 *
 * ハッシュは実行時に決まるので、`*_PATH` は**テンプレートリテラル型では
 * なくただの `string`** になった。`*_ROUTE` から導出している構造は
 * そのままなので、片方だけ変えられないことは変わらない。
 */

/**
 * ## `u18.css` はもう配信していない（#332 の P1）
 *
 * この Worker の画面が 6 枚とも Kiwa UI へ移り、**手書き CSS を 1 枚も
 * 読まなくなった。** 配信ルートだけを残すと「誰も参照しないアセット」に
 * なる —— `test/asset-coverage.test.ts` がまさにそれを落とす検査なので、
 * 残すなら理由を宣言することになる。宣言できる理由が無いので消した。
 *
 * **`styles.ts` 自体も消えた**（#332 の P2）。最後まで読んでいた
 * auth-worker のログイン画面・同意画面が Kiwa へ移ったため。
 */

/**
 * Kiwa UI のスタイルシート（#332）。
 *
 * **この Worker が配信するスタイルシートはこれ 1 本である。** 6 枚の
 * 画面が全部これを読む。手書きの `u18.css` は #332 の P1 で配信を止め、
 * 定義（`@u18/web-ui` の `styles.ts`）も P2 で消えた。
 *
 * ## 1 枚のページが読むのは 1 本だけ
 *
 * **移行の間は「両方読み込む」が一番楽な逃げ道だった** —— Tailwind の
 * preflight がブラウザ既定を潰し、手書き CSS はその既定を前提に
 * 書かれていたので、重ねると手書き側が崩れる。手書き側は消えたが、
 * **1 本であることを見る検査は残してある**（`ui-pages.test.ts`）。
 *
 * ## 中身はビルドが作るが、ハッシュはここが計算する
 *
 * `scripts/build-client.mjs` が Tailwind を回して
 * `generated/kiwa-stylesheet.ts` を書く。**ハッシュをビルドに計算させて
 * いない** —— `hashedFileName` が**配信するのと同じ文字列**から出すので、
 * 生成が古くても URL が古いほうのハッシュになる（#211 / #132）。
 */
export const KIWA_STYLESHEET_ROUTE = `/ui/${hashedFileName("kiwa.css", KIWA_STYLESHEET)}`;
export const KIWA_STYLESHEET_PATH = `${ACCOUNT_BASE_PATH}${KIWA_STYLESHEET_ROUTE}`;

/**
 * 取り消し操作のアイランド（#9）。
 *
 * **スタイルシートと違い、auth-worker のものは借りられない。** あちらの
 * `/ui/login-island.js` は WebAuthn 専用で中身が別物である。
 */
export const ISLAND_ROUTE = `/ui/${hashedFileName("account-island.js", ACCOUNT_ISLAND_JS)}`;
export const ISLAND_PATH = `${ACCOUNT_BASE_PATH}${ISLAND_ROUTE}`;

/**
 * ダッシュボードのホーム（#308）。
 *
 * **以前はここがプロフィールとパスキーの本体だった。** いまは各ページへの
 * 導線と件数だけを置く。中身は `/account/profile` と `/account/passkeys` へ
 * 移した。
 */
export const OVERVIEW_ROUTE = "/";
export const OVERVIEW_PATH = ACCOUNT_BASE_PATH;

/**
 * プロフィール（#308）。
 *
 * **概要から切り出した。** 以前は `/account` が「プロフィール + パスキー」
 * の 2 節を持っていたが、サイドバーを置くと**どの項目が現在地か**を
 * 1 つに決められない。1 画面 1 主題にする。
 */
export const PROFILE_ROUTE = "/profile";
export const PROFILE_PATH = `${ACCOUNT_BASE_PATH}${PROFILE_ROUTE}` as const;

/** パスキー（#308 で概要から切り出した）。 */
export const PASSKEYS_ROUTE = "/passkeys";
export const PASSKEYS_PATH = `${ACCOUNT_BASE_PATH}${PASSKEYS_ROUTE}` as const;

/** ログイン中の端末。 */
export const SESSIONS_ROUTE = "/sessions";
export const SESSIONS_PATH = `${ACCOUNT_BASE_PATH}${SESSIONS_ROUTE}` as const;

/** 連携を許可したアプリ（#18）。 */
export const GRANTS_ROUTE = "/grants";
export const GRANTS_PATH = `${ACCOUNT_BASE_PATH}${GRANTS_ROUTE}` as const;

/**
 * u18 Identity で使えるアプリの一覧（#308）。
 *
 * **`/account/grants` とは別物である。** あちらは「あなたが同意した RP」、
 * こちらは「u18 で使えるアプリとして**運用側が載せたもの**」のカタログ。
 * 前者は利用者ごとに中身が変わり、後者は全員に同じものが出る。
 * **一方だけを見て「連携しているアプリ」と読むと、必ずどちらかを
 * 取り違える**ので、画面の見出しでも「連携アプリ」と「アプリ」を
 * 言い分けている。
 *
 * **「繋がっているアプリ全部」ではない。** 載せるかどうかは運用の判断で
 * （`app-catalog.ts`）、`oauth_clients` の全件とは一致しない。
 */
export const APPS_ROUTE = "/apps";
export const APPS_PATH = `${ACCOUNT_BASE_PATH}${APPS_ROUTE}` as const;

/**
 * OAuth クライアントの管理（#308 / #333）。**管理者だけ。**
 *
 * **`/account/admin` そのものは作らない。** 作ると、サイドバーから
 * 辿れないページが 1 枚できる（`account-nav.ts` の「押しても何も無い
 * リンクを置かない」の裏返しで、こちらは「辿れないページを置かない」）。
 * 管理の節には**行き先のある項目だけ**が並ぶ。
 *
 * 更新系はこの下にぶら下げる。**別の接頭辞に置かない** —— 管理の経路が
 * 2 か所に散ると、`isAdmin` の確認を片方だけ忘れた状態が作れる。
 */
/**
 * 利用者の管理（#375）。**管理者だけ。**
 *
 * **一覧の GET と、検索の POST を分けてある。** 検索語はメールアドレス
 * になりうるので、**クエリに載せない** —— `csrf.ts` が CSRF 失敗時の
 * ログに `pathname` を書く（`search` は意図的に落としている）が、
 * パスに入れればそれが残る。#358 が `CLAIM_CARD_PARAM` で辿った道と
 * 同じ理由で、**こちらは逆向きに「クエリにも置かない」**にした ——
 * 検索語は Referer にも履歴にも残る。
 */
export const ADMIN_USERS_ROUTE = "/admin/users";
export const ADMIN_USERS_PATH = `${ACCOUNT_BASE_PATH}${ADMIN_USERS_ROUTE}` as const;

/** 検索と続きの読み込み（form POST）。**検索語を URL に出さないため。** */
export const ADMIN_USERS_SEARCH_ROUTE = "/admin/users/search";
export const ADMIN_USERS_SEARCH_PATH = `${ACCOUNT_BASE_PATH}${ADMIN_USERS_SEARCH_ROUTE}` as const;

export const ADMIN_CLIENTS_ROUTE = "/admin/clients";
export const ADMIN_CLIENTS_PATH = `${ACCOUNT_BASE_PATH}${ADMIN_CLIENTS_ROUTE}` as const;

/** 登録（form POST）。応答に `client_secret` の平文が 1 度だけ出る。 */
export const ADMIN_CLIENTS_CREATE_ROUTE = "/admin/clients/create";
export const ADMIN_CLIENTS_CREATE_PATH =
  `${ACCOUNT_BASE_PATH}${ADMIN_CLIENTS_CREATE_ROUTE}` as const;

/** 失効（form POST）。冪等。 */
export const ADMIN_CLIENTS_DISABLE_ROUTE = "/admin/clients/disable";
export const ADMIN_CLIENTS_DISABLE_PATH =
  `${ACCOUNT_BASE_PATH}${ADMIN_CLIENTS_DISABLE_ROUTE}` as const;

/**
 * NFC カードの管理画面。**この Worker は配信しない** —— nfc-worker が
 * `auth.under18.dev/account/nfc` で持っている（#31、あちらの
 * `wrangler.jsonc` の production routes が `/account/*` より長いので、
 * 両方に一致するこのパスは nfc-worker へ届く）。
 *
 * **`ACCOUNT_BASE_PATH` から組み立てないこと。** 接頭辞が同じなのは
 * たまたまで、持ち主が違う。ここを導出にすると「dashboard の画面を 1 つ
 * 増やした」ように読めてしまう。
 */
export const NFC_CARDS_PATH = "/account/nfc";

/**
 * ログイン画面。**この Worker は配信しない** —— auth-worker が
 * `auth.under18.dev/login` で持っている（仕様書 §14.1 決定 1 により
 * 同一オリジン）。
 *
 * 接頭辞を付けないこと。`/account/login` は auth-worker へ届かない。
 */
export const LOGIN_PATH = "/login";

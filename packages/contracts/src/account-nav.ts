/**
 * `auth.under18.dev/account` の中身と、その並び（#332 / #338）。
 *
 * ## なぜ contracts にあるのか
 *
 * **並びは Worker をまたぐ取り決めである。** 画面を描くのは
 * dashboard-worker だが、`/account/nfc` に答えるのは **nfc-worker** で、
 * そちらも同じサイドバーを出す。並びを片方に置くと、**もう片方だけ
 * 項目が欠けたサイドバー**が作れてしまう —— 落ちもせず、どちらの画面も
 * 正しく見えるので、利用者が「さっきあった項目が消えた」と思うまで
 * 誰も気づかない。
 *
 * **`@u18/web-ui` には置かない。** あちらは見た目の部品（`Layout` /
 * `styles` / Kiwa の primitives）で、そこへ「どの Worker がどの URL を
 * 持つか」を入れると、**UI の部品がデプロイの構成を抱える。**
 * `KiwaShell` を読んだ人は、それがトポロジに依存しているとは思わない。
 *
 * この package は既に Worker をまたぐ取り決めの置き場である
 * （`return-to` / `session-cookie` / `identity`）。並びはまさにそれ。
 *
 * ## `CONTRACT_VERSION` は上げない
 *
 * **ここへ項目を足しても上げなくてよい。** 判定条件は「**消費者を
 * 揃えてデプロイし直す必要があるか**」で（#337）、並びが 1 つ増えても
 * 各 Worker は自分のビルドに入った値を読むだけで、デプロイの順序に
 * 制約が出ない。
 *
 * **`version.ts` の JSDoc は RPC 契約の話に限られている。** あちらは
 * dashboard-worker が auth-worker の `IdentityRPC` を呼ぶときに、
 * 古い側と新しい側が同時に動く窓があるという話で、ここは関係が無い。
 *
 * ## 行き先が実在することは lint が見ている
 *
 * `scripts/check-app-catalog-routes.mjs` が、ここに書いたパスを
 * **本番 route で勝つ Worker** に解決し、**その Worker の
 * `route-inventory.ts` に登録があるか**まで見る。
 *
 * **これが無いと、nfc-worker が route を動かした瞬間にダッシュボードの
 * サイドバーが 404 のリンクを並べる。** 持ち主が別の Worker なので、
 * dashboard 側のテストは何も言わない（#211 / #327 の家系）。
 */

export type AccountNavKey = "profile" | "passkeys" | "sessions" | "grants" | "apps" | "nfc";

export type AccountNavItem = {
  readonly key: AccountNavKey;
  /** 絶対パス。**Worker をまたぐので接頭辞から組み立てない。** */
  readonly href: string;
  readonly label: string;
};

export type AccountNavGroup = {
  readonly label: string;
  readonly items: readonly AccountNavItem[];
};

/**
 * 表示順はこの配列の順。**件数や更新日で並べ替えない** —— 並びが
 * 変わると、前に見た位置を覚えている人が毎回探し直すことになる。
 *
 * ## 中身の無いカテゴリを先に置かない
 *
 * **押しても何も無いリンクを置かない** —— パスキーの登録ボタンが
 * 「API はあるのに入口が無い」まま残っていた #306 と、向きは逆だが
 * 同じ種類の嘘になる。「開発」（OAuth クライアントの管理、#331）は
 * まだ画面が無いので置いていない。
 */
export const ACCOUNT_NAV_GROUPS: readonly AccountNavGroup[] = [
  {
    label: "アカウント",
    items: [
      { key: "profile", href: "/account/profile", label: "プロフィール" },
      { key: "passkeys", href: "/account/passkeys", label: "パスキー" },
      { key: "sessions", href: "/account/sessions", label: "ログイン中の端末" },
      { key: "grants", href: "/account/grants", label: "連携アプリ" },
    ],
  },
  {
    /**
     * **「アカウント」と分ける。** あちらは「自分の設定をいじる」場所、
     * こちらは「u18 でログインして使う別のアプリへ行く」場所である。
     * 用事が違うものを同じ並びに置くと、どちらを探しているのか決めてから
     * でないと読めない一覧になる。
     */
    label: "サービス",
    items: [
      { key: "apps", href: "/account/apps", label: "アプリ" },
      /**
       * **この 1 行だけ持ち主が違う。** `/account/nfc` に答えるのは
       * nfc-worker で（`wrangler.jsonc` の production route が
       * dashboard の `/account/*` より長いので勝つ）、dashboard-worker は
       * 配信しない。
       *
       * **ダッシュボードから操作できる口が無かった**のが #338 で、
       * ここに出していなかったことがその一部である（画面はあったが、
       * サイドバーからは辿れなかった）。
       */
      { key: "nfc", href: "/account/nfc", label: "NFC カード" },
    ],
  },
];

/** ダッシュボードのホーム。サイドバーのブランドが指す先。 */
export const ACCOUNT_HOME_PATH = "/account";

/**
 * サイドバーの現在地。
 *
 * **`"home"` が `AccountNavKey` に入っていないのは意図的である。**
 * ホームは並びの項目ではなく、サイドバーの**ブランドのリンク**が
 * 指す先なので、`ACCOUNT_NAV_GROUPS` に項目を作ると 2 つ出る。
 *
 * それでも「いまホームに居る」は言える必要がある —— 言えないと、
 * ホームの画面だけ**サイドバー全体がどこも現在地でない**状態になり、
 * 利用者がどこに居るのか画面から読めない。
 */
export type AccountNavCurrent = AccountNavKey | "home";

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

export type AccountNavKey =
  "profile" | "passkeys" | "sessions" | "grants" | "apps" | "nfc" | "clients" | "users";

export type AccountNavItem = {
  readonly key: AccountNavKey;
  /** 絶対パス。**Worker をまたぐので接頭辞から組み立てない。** */
  readonly href: string;
  readonly label: string;
  /**
   * 管理者にだけ出す項目か（#333）。
   *
   * **ここに書くのは「誰に出すか」だけで、「誰が叩けるか」ではない。**
   * サイドバーから消えても URL は叩けるので、**画面側が自分で
   * `isAdmin` を見て `not_found` を返すこと。** 片方だけだと、
   * #306 と向きが逆の同じ嘘になる（出るのに叩けない / 出ないのに叩ける）。
   */
  readonly adminOnly?: boolean;
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
 * 同じ種類の嘘になる。「管理」の節は #373 で RPC が入り、#333 で画面が
 * 入ったので置いた。**節の名前は「開発」ではない** —— OAuth クライアント
 * だけを想定していたときはそう呼んでいたが、NFC カードの管理
 * （`/account/nfc/admin`）が同じ節に入るので合わなくなった。
 *
 * ## 管理者向けの項目も、ここに足す（#333）
 *
 * **別の配列を作らない。** `adminOnly: true` を付けて同じ並びに置き、
 * 出し分けは `accountNavFor()` が行う。分けると
 * `check-app-catalog-routes.mjs` の走査から外れ、**行き先が実在する
 * ことを誰も見なくなる。**
 *
 * 上の規則は管理者向けにも同じく当てはまる —— **画面が入る PR で、
 * その PR がここへ足すこと。** 最初の 1 つは `clients`（#333）で、
 * 画面（`/account/admin/clients`）と同じ PR で入った。
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
  {
    /**
     * **管理者にだけ出る節**（#333）。
     *
     * **「アカウント」「サービス」と分ける。** あの 2 つは「自分のもの」を
     * 扱う場所で、ここは **u18 そのものの設定**を扱う。同じ並びに混ぜると、
     * 管理者には「自分の連携アプリ」と「u18 に登録されたクライアント」が
     * 隣り合って見え、**取り消すつもりで失効させる**ことが起こりうる。
     *
     * 節ごと `adminOnly` なので、非管理者には**見出しごと消える**
     * （`accountNavFor`）。見出しだけ残すと、隠している意味が無くなる。
     *
     * **NFC カードの管理（`/account/nfc/admin`）も同じ節に入る**
     * （持ち主は nfc-worker）。グループ名が 1 文字でも違うと
     * **管理の節が 2 つ並ぶ**ので、ここの文字列は動かさないこと。
     */
    label: "管理",
    items: [
      {
        /**
         * **利用者の管理を先に置く**（#375）。運用の問い合わせはまず
         * 「この人」から始まるので、管理の節で最初に目に入るべきものが
         * これになる。OAuth クライアントは頻度が低い。
         */
        key: "users",
        href: "/account/admin/users",
        label: "利用者",
        adminOnly: true,
      },
      {
        key: "clients",
        href: "/account/admin/clients",
        label: "OAuth クライアント",
        adminOnly: true,
      },
    ],
  },
];

/**
 * このセッションに出す並び（#333）。
 *
 * **`adminOnly` の項目を落とし、それで空になったグループも落とす。**
 * 見出しだけが残ると、**管理者にだけ中身がある節が、非管理者には
 * 空の見出しとして見える** —— 存在を隠す意味が無くなる。
 *
 * ## なぜ呼ぶ側に書かせないのか
 *
 * dashboard-worker と nfc-worker が**それぞれ** `isAdmin ? ... : ...` と
 * 書くと、**片方だけ条件を間違えた状態**が作れる。どちらの画面も落ちず、
 * 気づくのは「NFC の画面では管理の節が出ないのですが」と言われたとき
 * である。**このファイルの冒頭が並びを contracts に置いた理由が、
 * そのまま出し分けにも当てはまる。**
 *
 * **`isAdmin` の値そのものは呼ぶ側が持つ。** あれはセッションごとに
 * 変わる値で、Worker 間の取り決めではない。両方の Worker が
 * `getSession`（`SessionSummary.isAdmin`）から取れる。
 *
 * ## `check-app-catalog-routes.mjs` はフィルタ前を見る
 *
 * あの検査は `ACCOUNT_NAV_GROUPS` の**ソースを正規表現で読む**
 * （`scripts/lib/app-catalog-routes.mjs` の `readNavHrefs`）ので、
 * `adminOnly` を付けても走査から外れない。**行き先が実在することは
 * `isAdmin` と無関係に要る。**
 */
export function accountNavFor(isAdmin: boolean): readonly AccountNavGroup[] {
  if (isAdmin) return ACCOUNT_NAV_GROUPS;

  return ACCOUNT_NAV_GROUPS.map((group) => ({
    ...group,
    items: group.items.filter((item) => item.adminOnly !== true),
  })).filter((group) => group.items.length > 0);
}

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

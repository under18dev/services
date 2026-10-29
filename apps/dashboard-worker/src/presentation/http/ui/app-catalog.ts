/**
 * u18 Identity で使えるアプリのカタログ（#308）。
 *
 * ## なぜ D1 の `oauth_clients` から引かないのか
 *
 * **あのテーブルには「公開してよいか」を表す列が無い。** 列はクライアント
 * 種別・`allowed_scopes`・`disabled_at` などで、どれも「認可をどう通すか」
 * の話である。そのまま一覧にすると、運用者が検証用に登録したクライアント
 * （runbook §12.6 の `u18-oidc-probe` のような、登録して数分で失効させる
 * もの）や内部用のクライアントが、**そのまま利用者の画面に出る。**
 *
 * **カタログに載せるかどうかは運用の判断であって、登録済みかどうかとは
 * 別の問いである。** 「`oauth_clients` に行がある」は「u18 でログインできる」
 * を意味するだけで、「利用者に勧めてよい」は意味しない。D1 を正本にすると
 * この 2 つを分けて表現する場所が無くなる。
 *
 * **将来 D1 側に列（`is_listed` / `description` / `category`）を足すなら、
 * そのときこのファイルを置き換える。** いまコードに持つのは、
 * 分ける場所が無いあいだの置き場所であって、設計の終点ではない。
 *
 * ## カタログは「全部」ではない
 *
 * ここに載るのは**運用側が載せると決めたものだけ**で、`oauth_clients` の
 * 全件でも、u18 でログインできるアプリの全件でもない。上の「載せるかは
 * 運用の判断」と裏表なので、**画面でも「全部」と言わないこと。**
 *
 * ## 実在するものしか載せない
 *
 * **押しても何も無いリンクを置かない**（#306）。載せる前に
 * `wrangler.jsonc` の production の `routes` と `docs/runbook.md` の
 * 「本番ホスト」の表を見て、**本番で実際に答えるホストであること**を
 * 確かめること。「作る予定のアプリ」を placeholder で並べると、
 * カタログ自体が信用されなくなる。
 *
 * **`/` 始まりの url は `scripts/check-app-catalog-routes.mjs` が
 * 検査する** —— どれかの Worker の production route が覆っていなければ
 * `pnpm lint` が落ちる。別 Worker 宛てのパス（`/account/nfc` は
 * nfc-worker）を手で書いているので、向こうが動いたときにここが
 * 黙って嘘になるのを防ぐ（#211 と同じ家系）。
 *
 * **0 件になっても構わない。** 画面は「まだありません」を出す。
 * 枠だけ先に埋めるより、空であることが読めるほうがよい。
 */

import type { GrantListItem } from "@u18/contracts";
import { NFC_CARDS_PATH } from "./asset-paths";

/**
 * カテゴリ。**画面に直書きしない。**
 *
 * サイドバーのグループ（`dashboard-shell.tsx`）と同じ語を使っている。
 * 利用者から見て「アカウント」「サービス」が別の場所で別の意味になると、
 * どこを探せばよいか決められなくなる。
 *
 * **「開発」をまだ作らない。** OAuth クライアントの管理画面（#308 の
 * 3 番目）が入るまで載せるものが無く、**定義だけ残すと「使えるのに
 * 使っていない」と読まれる。** 要るときに足すほうが安い。
 */
export type AppCategoryKey = "service";

export type AppCategory = {
  readonly key: AppCategoryKey;
  readonly label: string;
  /** そのカテゴリが何の集まりかの 1 行。見出しの下に出す。 */
  readonly description: string;
};

/**
 * 表示順はこの配列の順。**カテゴリごとの件数で並べ替えない** ——
 * 1 つアプリが増えただけで画面の並びが変わると、前に見た位置を覚えて
 * いる人が毎回探し直すことになる。
 */
export const APP_CATEGORIES: readonly AppCategory[] = [
  {
    key: "service",
    label: "サービス",
    description: "u18 Identity のアカウントでそのまま使えるアプリ。",
  },
];

export type AppCatalogEntry = {
  /** 画面の `key` に使う安定した識別子。表示はしない。 */
  readonly id: string;
  readonly name: string;
  /** 1 行の説明。「何ができるか」を書く。機能の列挙はしない。 */
  readonly description: string;
  /**
   * 行き先。**同一オリジンなら `/` 始まりの絶対パス、別ホストなら
   * `https://` 始まりの URL。** 判定は `isExternalUrl` が
   * `new URL()` で行うので、`//evil.example` や `/\evil.example` を
   * 書いても内部とは見なされない。
   */
  readonly url: string;
  readonly category: AppCategoryKey;
  /**
   * OIDC の `client_id`。**`listGrants` の結果と突き合わせる鍵である。**
   *
   * `undefined` なのは「RP ではない」という意味で、「まだ連携していない」
   * ではない。u18 と同じオリジンに載っていてセッション Cookie を直接読む
   * アプリ（NFC がこれ）は OAuth を通らないので `client_id` を持たない。
   * **こういうアプリに「未連携」と出すと嘘になる**ので、バッジ自体を出さない
   * （`connected` が `null` になる）。
   */
  readonly clientId?: string;
};

/**
 * 本番で実在するものだけ。**増やすときは上の「実在するものしか載せない」を
 * 読むこと。**
 *
 * いま 1 件しかないのは、**本番に登録されている RP が 0 件だから**である
 * （runbook §12.6 に「RP がまだ 1 つも居ない」と書いてある）。検証用に
 * 登録した `u18-oidc-probe` は `/authorize` が踏まれないまま失効させて
 * あり、常設のものは無い。
 */
export const APP_CATALOG: readonly AppCatalogEntry[] = [
  {
    id: "nfc-cards",
    name: "NFC カード",
    description: "カードをかざしたときの行き先を、カードを書き換えずに変更できます。",
    // nfc-worker が `auth.under18.dev/account/nfc` で答える（#31、あちらの
    // `wrangler.jsonc` の production routes）。dashboard と同一オリジンなので
    // 絶対パスで書く。**この組み合わせは `check:app-catalog` が検査する。**
    url: NFC_CARDS_PATH,
    category: "service",
  },
];

/** 画面へ渡す 1 件分。カタログの定義に「自分が連携済みか」を足したもの。 */
export type AppCatalogItem = AppCatalogEntry & {
  /**
   * `true` のときだけ「連携済み」を出す。
   *
   * **`false` と `null` は違う。** `false` は「RP だが、まだ同意していない」、
   * `null` は「**言えない**」——
   *
   *  - `clientId` が無い（NFC のように OAuth を通らない。連携という概念が無い）
   *  - `listGrants` が取れなかった（`grantsKnown` が false）
   *
   * どちらの `null` も**何も出さない**のが正しい。`false` に畳むと
   * 「未連携」と読める情報を出せてしまい、嘘になる。`boolean` 1 つに
   * していたときは、この区別が JSX の書き方だけで守られていた。
   */
  readonly connected: boolean | null;
};

export type AppCatalogGroup = {
  readonly category: AppCategory;
  readonly items: readonly AppCatalogItem[];
};

export type AppCatalogView = {
  readonly groups: readonly AppCatalogGroup[];
  /**
   * `listGrants` が取れたか。**false なら「連携済み」を 1 件も出せない。**
   *
   * 画面はこれを見て「いま連携状況を確認できない」と言う。黙って
   * バッジを消すと、連携しているのにしていないように見える。
   */
  readonly grantsKnown: boolean;
};

/**
 * カタログの url を解決するときの基準。**実在しないホストにしてある。**
 *
 * 自分のオリジンは dev と本番で違い、この関数は `Context` を持たない。
 * 要るのは「`/` 始まりのままか、どこかへ出て行ったか」だけなので、
 * **番兵のオリジンへ解決して変化を見る**ほうが、ホストを知るより正確に
 * 答えが出る。
 */
const CATALOG_URL_BASE = "https://dashboard.invalid";

function resolveCatalogUrl(url: string): URL | null {
  try {
    return new URL(url, CATALOG_URL_BASE);
  } catch {
    return null;
  }
}

/**
 * 画面に出してよい行き先か。**`https:` に解決できるものだけ。**
 *
 * `/` 始まりの絶対パスは番兵（`https:`）を継ぐので通る。落ちるのは
 * `javascript:` / `data:` のような別スキームと、`http://` の平文である。
 *
 * **いまカタログは手書きなので実害が無い。** それでも関門を置くのは、
 * このファイル自身が「将来 D1 側へ移す」と書いているからで、そのとき
 * `url` は**運用者が画面から入れた文字列**になる。関門をその時に足すと、
 * 「前は要らなかった」を理由に省かれる。
 */
export function isAllowedUrl(url: string): boolean {
  return resolveCatalogUrl(url)?.protocol === "https:";
}

/**
 * 別ホストへのリンクか。`rel="noopener noreferrer"` を付けるかを決める。
 *
 * **文字列の形で判定しない。** `/` 始まりだけを見ると
 * `//evil.example` を、`//` を弾いても `/\evil.example` を取りこぼす
 * （特別スキームでは `\` が `/` として読まれる）。`new URL()` に解決
 * させて**オリジンが番兵のままか**を見れば、この種の形は全部片付く。
 *
 * 解決できないものは外部として扱う。`isAllowedUrl` が先に落とすので
 * 画面には出ないが、**ここだけを使った呼び出しが安全側に倒れる**ように。
 */
export function isExternalUrl(url: string): boolean {
  const resolved = resolveCatalogUrl(url);
  return resolved === null || resolved.origin !== CATALOG_URL_BASE;
}

/**
 * カタログを画面に出せる形へ畳む。
 *
 * **ここが `listGrants` との突き合わせ点である。** 画面側で同じ照合を
 * 書かせると、カタログが増えたときに片方だけ直す形になる。
 *
 * **中身の無いカテゴリは返さない。** 見出しだけがあって下に何も無い
 * 状態は「読み込みに失敗した」に見える。
 *
 * @param grants `null` は「**取れなかった**」。「連携が 0 件」ではない。
 *   呼び出し側（`account.routes.tsx`）は `listGrants` が失敗しても画面を
 *   出すので、この 2 つを同じ値で渡せてはいけない。
 */
export function buildAppCatalog(
  entries: readonly AppCatalogEntry[],
  grants: readonly GrantListItem[] | null,
): AppCatalogView {
  const grantedClientIds = grants === null ? null : new Set(grants.map((g) => g.clientId));

  const groups = APP_CATEGORIES.flatMap((category) => {
    const items = entries
      // **出せない url を持つ行は落とす。** 載せた側のバグなので、
      // `app-catalog.test.ts` が実物を端から端まで見て落としている。
      .filter((entry) => entry.category === category.key && isAllowedUrl(entry.url))
      .map((entry) => ({
        ...entry,
        connected:
          entry.clientId === undefined || grantedClientIds === null
            ? null
            : grantedClientIds.has(entry.clientId),
      }));

    return items.length === 0 ? [] : [{ category, items }];
  });

  return { groups, grantsKnown: grants !== null };
}

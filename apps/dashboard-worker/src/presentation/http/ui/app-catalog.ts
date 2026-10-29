/**
 * u18 Identity で使えるアプリのカタログ（#308）。
 *
 * ## なぜ D1 の `oauth_clients` から引かないのか
 *
 * **`oauth_clients` には「公開してよいか」を表す列が無い。** 列は
 * クライアント種別・`allowed_scopes`・`disabled_at` などで、どれも
 * 「認可をどう通すか」の話である。そのまま一覧にすると、運用者が検証用に
 * 登録したクライアント（runbook §13 の `u18-oidc-probe` のような、
 * 登録して数分で失効させるもの）や内部用のクライアントが、
 * **そのまま利用者の画面に出る。**
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
 * ## 実在するものしか載せない
 *
 * **押しても何も無いリンクを置かない**（#306）。載せる前に
 * `wrangler.jsonc` の production の `routes` と `docs/runbook.md` の
 * 「本番ホスト」の表を見て、**本番で実際に答えるホストであること**を
 * 確かめること。「作る予定のアプリ」を placeholder で並べると、
 * カタログ自体が信用されなくなる。
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
 * 利用者から見て「アカウント」「開発」「サービス」が別の場所で別の意味に
 * なると、どこを探せばよいか決められなくなる。
 */
export type AppCategoryKey = "service" | "development";

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
  {
    key: "development",
    label: "開発",
    description: "アプリを作る人向けのもの。",
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
   * `https://` 始まりの URL。** この区別で `rel` を付けるかどうかが決まる
   * （`isExternalUrl`）ので、同一オリジンのものを絶対 URL で書かないこと。
   */
  readonly url: string;
  readonly category: AppCategoryKey;
  /**
   * OIDC の `client_id`。**`listGrants` の結果と突き合わせる鍵である。**
   *
   * `undefined` なのは「RP ではない」という意味で、「まだ連携していない」
   * ではない。u18 と同じオリジンに載っていてセッション Cookie を直接読む
   * アプリ（NFC がこれ）は OAuth を通らないので `client_id` を持たない。
   * **こういうアプリに「未連携」と出すと嘘になる**ので、バッジ自体を出さない。
   */
  readonly clientId?: string;
};

/**
 * 本番で実在するものだけ。**増やすときは上の「実在するものしか載せない」を
 * 読むこと。**
 *
 * いま 1 件しかないのは、**本番に登録されている RP が 0 件だから**である
 * （仕様書 §14.1 決定 11 の段階 (1)、runbook §9）。検証用に登録した
 * `u18-oidc-probe` は使用後に失効させてあり、常設のものは無い。
 * OAuth クライアントの管理画面（#308 の 3 番目）はまだ無いので、
 * 「開発」カテゴリに載せられるものも無い —— **空のカテゴリは出さない。**
 */
export const APP_CATALOG: readonly AppCatalogEntry[] = [
  {
    id: "nfc-cards",
    name: "NFC カード",
    description: "カードをかざしたときの行き先を、カードを書き換えずに変更できます。",
    // nfc-worker が `auth.under18.dev/account/nfc` で答える（#31、同 Worker の
    // `wrangler.jsonc` の production routes）。dashboard と同一オリジンなので
    // 絶対パスで書く。
    url: NFC_CARDS_PATH,
    category: "service",
  },
];

/** 画面へ渡す 1 件分。カタログの定義に「自分が連携済みか」を足したもの。 */
export type AppCatalogItem = AppCatalogEntry & {
  /**
   * `true` のときだけ「連携済み」を出す。**`false` と「`clientId` が無い」を
   * 区別すること** —— 後者は連携という概念が無いので、何も出さない。
   */
  readonly connected: boolean;
};

export type AppCatalogGroup = {
  readonly category: AppCategory;
  readonly items: readonly AppCatalogItem[];
};

/**
 * 別ホストへのリンクかどうか。
 *
 * **`/` 始まりを同一オリジンとみなす。** カタログの `url` は手で書くので、
 * `//evil.example` のような形を書き得る。`/` が 2 つ続くものは
 * プロトコル相対 URL として別ホストへ飛ぶので、**外部として扱う。**
 */
export function isExternalUrl(url: string): boolean {
  return !url.startsWith("/") || url.startsWith("//");
}

/**
 * カタログを画面に出せる形へ畳む。
 *
 * **ここが `listGrants` との突き合わせ点である。** 画面側で同じ照合を
 * 書かせると、カタログが増えたときに片方だけ直す形になる。
 *
 * **中身の無いカテゴリは返さない。** 見出しだけがあって下に何も無い
 * 状態は「読み込みに失敗した」に見える。
 */
export function buildAppCatalog(
  entries: readonly AppCatalogEntry[],
  grants: readonly GrantListItem[],
): readonly AppCatalogGroup[] {
  const grantedClientIds = new Set(grants.map((grant) => grant.clientId));

  return APP_CATEGORIES.flatMap((category) => {
    const items = entries
      .filter((entry) => entry.category === category.key)
      .map((entry) => ({
        ...entry,
        connected: entry.clientId !== undefined && grantedClientIds.has(entry.clientId),
      }));

    return items.length === 0 ? [] : [{ category, items }];
  });
}

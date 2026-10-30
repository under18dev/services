import {
  APPS_PATH,
  GRANTS_PATH,
  OVERVIEW_PATH,
  PASSKEYS_PATH,
  PROFILE_PATH,
  SESSIONS_PATH,
} from "../src/presentation/http/ui/asset-paths";

/**
 * アカウント管理画面の 6 枚（#332）。
 *
 * ## なぜ共有するのか
 *
 * **2 つのテストが同じ 6 枚を、違う角度から見ている。**
 *
 *  - `ui-pages.test.ts` —— どのスタイルシートを読むか、何本読むか
 *  - `kiwa-stylesheet.test.ts` —— 読んだ CSS に class が在るか
 *
 * 片方にしか無い画面があると、**その画面だけ片目で見ている**ことになる。
 * しかも**気づく手立てが無い** —— どちらも自分の一覧の分は緑を返すので、
 * 2 つを並べて数えるまで分からない。
 *
 * **最初は `kiwa-stylesheet.test.ts` が自分の一覧を持ち、「`ui-pages.test.ts`
 * の `PAGES` を漏れなく覆っている」という名前の検査を添えていた。**
 * その本文は**あちらを 1 度も読んでおらず**、ローカル定数の長さ
 * （`toBe(6)`）と重複を見ているだけだった。しかも長さの検査は**向きが逆**で、
 * 7 枚目を足して**書き忘れた**ときは 6 のままで緑、**正しく足した**ときだけ
 * 赤になる。実測で、片方から `GRANTS_PATH` を外して literal を 5 に
 * 合わせると、**2 つの一覧が食い違ったまま 283 本すべて緑**だった
 * （`grants-page.tsx` に注入した class も見逃したまま）。
 *
 * **突き合わせの検査を直すのではなく、一覧を 1 つにした。** ズレる余地が
 * 無ければ、ズレを見る検査は要らない（`test/route-inventory.ts` が
 * 同じ形でテスト用の共有データを持っているのが前例）。
 *
 * ## ここに無いもの
 *
 * **`/account/nfc` は入れない。** 本番 route では nfc-worker が勝つので、
 * この Worker に投げると 404 が返る。サイドバーの行き先としては
 * `ui-pages.test.ts` が `FOREIGN_NAV_HREFS` で別に扱っている。
 *
 * **未認証で返る画面（`message-page.tsx`）も入れない。** URL を持たず、
 * 上の 6 つすべてから返る。引き方が違うので、それぞれのテストが
 * 自分で引いている。
 */
export const PAGES: readonly string[] = [
  OVERVIEW_PATH,
  PROFILE_PATH,
  PASSKEYS_PATH,
  SESSIONS_PATH,
  GRANTS_PATH,
  APPS_PATH,
];

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  KiwaShell,
} from "@u18/web-ui/kiwa";
import { ITEM_RAW_CLASS } from "@u18/web-ui/kiwa/island-classes";
import type { FC } from "hono/jsx";
import { ISLAND_PATH, KIWA_STYLESHEET_PATH } from "./asset-paths";

/**
 * 承認待ちの画面（`/pending`、#443）。**運用者が必ず通る唯一の入口。**
 *
 * **最初の 1 人として承認を受けるための画面**——ログインはできたが、
 * admin-worker 自身の承認リストにまだ無い人の行き先（`app.ts` のガード
 * を参照）。
 *
 * ## コピーボタン（#488）
 *
 * かつては `<textarea readonly>` ＋「クリックして Ctrl+A」の案内文だった
 * ——#443 の時点では admin-worker にクライアント JS が無く（#470 より前）、
 * コピーボタン 1 個のために新しく組むのは見合わなかったため。いまは
 * `admin-island.ts`（#470）の `data-copy` がどの画面からも使えるので、
 * 素直にボタンへ置き換えた。案内文は不要になったので消した。
 *
 * **`NAV_PAGE_ROUTES` の外にある画面であること。** `/pending` は未承認の
 * 人だけが見る画面で、承認済みの管理者が辿る `route-inventory.ts` の
 * `NAV_PAGE_ROUTES` には入らない——`test/asset-coverage.test.ts` の
 * 「`data-*` を使う画面は `ISLAND_PATH` も読む」という検査はそちらを
 * 引くので、この画面はその検査の対象外になる（別途 `PENDING_ROUTES` を
 * 足して確かめている。同ファイルを参照）。**`scripts` を忘れても検査が
 * 気づかない以上、ここで確実に渡すこと。**
 *
 * ## `sub` を `<code>` で固定幅にする
 *
 * 運用者がこれを CLI へ書き写す。可変幅フォントだと `l`（エル）と
 * `1`（いち）のような字形が紛らわしい。
 */
export type PendingPageProps = {
  readonly sub: string;
  readonly grantCommand: string;
};

export const PendingPage: FC<PendingPageProps> = ({ sub, grantCommand }) => (
  <KiwaShell
    title="承認待ち"
    nav={[]}
    brandHref="/login"
    stylesheet={KIWA_STYLESHEET_PATH}
    heading="承認待ち"
    lead="ログインはできました。この管理画面を使うには、承認の権限を持つ人の承認が必要です。"
    scripts={[ISLAND_PATH]}
  >
    <Card>
      <CardHeader>
        <CardTitle>あなたの ID</CardTitle>
        <CardDescription>承認する人に、この ID を伝えてください。</CardDescription>
      </CardHeader>
      <CardContent>
        <div class="flex items-center gap-2">
          <p class={ITEM_RAW_CLASS}>{sub}</p>
          <button
            type="button"
            class="shrink-0 text-xs text-foreground underline underline-offset-4"
            data-copy={sub}
            hidden
          >
            コピー
          </button>
        </div>
      </CardContent>
    </Card>

    <Card>
      <CardHeader>
        <CardTitle>承認する人へ</CardTitle>
        <CardDescription>
          上の ID を使って、次のコマンドを実行してください。最初の 1 人を承認するには{" "}
          <code class={ITEM_RAW_CLASS}>--super</code> が要ります。
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div class="flex items-start gap-2">
          <p class={ITEM_RAW_CLASS}>{grantCommand}</p>
          <button
            type="button"
            class="shrink-0 text-xs text-foreground underline underline-offset-4"
            data-copy={grantCommand}
            hidden
          >
            コピー
          </button>
        </div>
      </CardContent>
    </Card>
  </KiwaShell>
);

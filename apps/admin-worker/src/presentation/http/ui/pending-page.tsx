import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  KiwaShell,
} from "@u18/web-ui/kiwa";
import { ITEM_META_CLASS, ITEM_RAW_CLASS, INPUT_CLASS } from "@u18/web-ui/kiwa/island-classes";
import type { FC } from "hono/jsx";
import { KIWA_STYLESHEET_PATH } from "./asset-paths";

/**
 * 承認待ちの画面（`/pending`、#443）。**運用者が必ず通る唯一の入口。**
 *
 * **最初の 1 人として承認を受けるための画面**——ログインはできたが、
 * admin-worker 自身の承認リストにまだ無い人の行き先（`app.ts` のガード
 * を参照）。
 *
 * ## `<pre><code>` ではなく `<textarea readonly>`
 *
 * コマンドをコピーできるようにしたいが、**クライアント JS はゼロ**
 * （#443）。admin-worker にはまだ島の仕組みが無く（`build-client.mjs`
 * の冒頭を参照）、コピーボタン 1 個のために新しく組むのは見合わない。
 *
 * `<textarea readonly>` はトリプルクリックか `Ctrl+A` で全選択でき、
 * `<pre><code>` を手でドラッグするより確実にコピーできる——JS を
 * 1 行も使わずに得られる改善として、これを選んだ。
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
  >
    <Card>
      <CardHeader>
        <CardTitle>あなたの ID</CardTitle>
        <CardDescription>承認する人に、この ID を伝えてください。</CardDescription>
      </CardHeader>
      <CardContent>
        <p class={ITEM_RAW_CLASS}>{sub}</p>
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
        <textarea
          readonly
          rows={2}
          class={`${INPUT_CLASS} h-auto resize-none font-mono text-xs`}
          aria-label="承認コマンド"
        >
          {grantCommand}
        </textarea>
        <p class={ITEM_META_CLASS}>クリックしてから Ctrl+A（Mac は Cmd+A）で全体を選択できます。</p>
      </CardContent>
    </Card>
  </KiwaShell>
);

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  KiwaShell,
} from "@u18/web-ui/kiwa";
import { ITEM_META_CLASS, ITEM_RAW_CLASS } from "@u18/web-ui/kiwa/island-classes";
import type { AdminCardStatusDelegated, AuditLogEntryAdmin } from "@u18/contracts";
import type { FC } from "hono/jsx";
import { ADMIN_NAV_GROUPS } from "./nav";
import { KIWA_STYLESHEET_PATH } from "./asset-paths";
import { formatDateTime } from "./format";

/**
 * ホーム（`/`、#449）。**承認済みの人だけが来る**（`app.ts` のガード）。
 *
 * #443（完了済み）の段階では、Kiwa UI の `Card` 1 枚に「サインイン
 * しました」とリンク列挙を並べただけだった——**枠には入ったが、
 * ダッシュボードではなかった。** ここでは「いま何が起きているか」が
 * 開いた瞬間に分かるよう、**いまの状態を表す数**（押すとその一覧へ飛ぶ）と
 * **直近の管理操作**を最初に出す。
 *
 * ## 承認待ちの人数は出さない（運用者の優先度 ① だが、出せない）
 *
 * issue が最優先に挙げていた数字だが、**admin-worker には「承認待ち」の
 * 行が存在しない**（`packages/admin-db/src/schema/approvals.ts` の
 * 冒頭を参照）——「ログインできたが承認リストに無い人は全員承認待ち」
 * という設計そのものが、承認待ちを**行の不在**で表すことを選んでいる。
 * 誰がいつログインを試したかは Workers の `observability` に委ねる
 * という決定で、D1 のどのテーブルにも記録が無い。
 *
 * これは「集計 RPC が無いので足りない」ではない——**集計する対象の
 * データが、設計上どこにも存在しない。** 新しい「ログイン試行」テーブルを
 * 足せば数えられるが、それは `approvals.ts` が明示的に選ばなかった形を
 * 後から持ち込むことになる。出さないほうが正しい。
 *
 * ## 集計はそれぞれの Worker 側で行う
 *
 * `listAllCards` / `listOAuthClients` を呼んで JS 側で数えない
 * （`NfcAdminDelegatedRpcContract.countCards` /
 * `IdentityAdminDelegatedRpcContract.countOAuthClients` の冒頭を参照）。
 * 一覧を全部引く形は、件数が増えたときに破綻する。
 *
 * ## 塊ごとに失敗を受け止める
 *
 * 3 つの塊（NFC・クライアント・監査ログ）はそれぞれ独立に取得し、
 * 失敗した塊だけ「いま取れません」に差し替える——`serviceUnavailable`
 * は画面全体を潰すので、ここでは使わない。管理画面のホームが
 * 行き止まりになるのが一番まずい（運用者の立っている指示）。
 */
export type HomePageProps = {
  readonly sub: string;
  /** `null` は取得に失敗したことを表す。0 件（本当に無い）とは区別する。 */
  readonly nfcCounts: Readonly<Record<AdminCardStatusDelegated, number>> | null;
  readonly clientCount: number | null;
  readonly recentAuditEntries: readonly AuditLogEntryAdmin[] | null;
};

const TILE_CLASS =
  "block rounded-xl transition-colors hover:bg-foreground/5 focus-visible:outline-none " +
  "focus-visible:ring-[3px] focus-visible:ring-ring/20";

const BIG_NUMBER_CLASS = "text-foreground text-xl font-semibold";

const NfcCountTile: FC<{
  readonly counts: Readonly<Record<AdminCardStatusDelegated, number>> | null;
}> = ({ counts }) => (
  <a href="/nfc" class={TILE_CLASS}>
    <Card>
      <CardHeader>
        <CardTitle>NFC カード</CardTitle>
        {counts === null ? (
          <CardDescription>いま取れません。</CardDescription>
        ) : (
          <CardDescription>
            未紐づけ <span class={BIG_NUMBER_CLASS}>{counts.issued}</span>
            {" ・ "}
            有効 <span class={BIG_NUMBER_CLASS}>{counts.active}</span>
            {" ・ "}
            無効化済み <span class={BIG_NUMBER_CLASS}>{counts.disabled}</span>
          </CardDescription>
        )}
      </CardHeader>
    </Card>
  </a>
);

const OAuthClientCountTile: FC<{ readonly count: number | null }> = ({ count }) => (
  <a href="/clients" class={TILE_CLASS}>
    <Card>
      <CardHeader>
        <CardTitle>OAuth クライアント</CardTitle>
        <CardDescription>
          {count === null ? "いま取れません。" : <span class={BIG_NUMBER_CLASS}>{count}</span>}
        </CardDescription>
      </CardHeader>
    </Card>
  </a>
);

const RecentAuditEntry: FC<{ readonly entry: AuditLogEntryAdmin }> = ({ entry }) => (
  <li class={ITEM_META_CLASS}>
    {formatDateTime(entry.createdAt)}
    {" ・ "}
    <span class={ITEM_RAW_CLASS}>{entry.event}</span>
    {entry.userId === null ? null : (
      <>
        {" ・ "}
        <span class={ITEM_RAW_CLASS}>{entry.userId}</span>
      </>
    )}
  </li>
);

export const HomePage: FC<HomePageProps> = ({
  sub,
  nfcCounts,
  clientCount,
  recentAuditEntries,
}) => (
  <KiwaShell
    title="u18 Admin"
    nav={ADMIN_NAV_GROUPS}
    current="home"
    brandHref="/"
    stylesheet={KIWA_STYLESHEET_PATH}
    heading="u18 Admin"
    lead="いまの状態です。押すとその一覧へ飛びます。"
  >
    <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <NfcCountTile counts={nfcCounts} />
      <OAuthClientCountTile count={clientCount} />
    </div>

    <Card>
      <CardHeader>
        <CardTitle>直近の管理操作</CardTitle>
        <CardDescription>
          <a href="/audit" class="underline underline-offset-4">
            すべて見る
          </a>
        </CardDescription>
      </CardHeader>
      <CardContent>
        {recentAuditEntries === null ? (
          <p class={ITEM_META_CLASS}>いま取れません。</p>
        ) : recentAuditEntries.length === 0 ? (
          <p class={ITEM_META_CLASS}>記録はまだありません。</p>
        ) : (
          <ul class="flex flex-col gap-2">
            {recentAuditEntries.map((entry) => (
              <RecentAuditEntry entry={entry} />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>

    {/*
      **畳む。** 「サインインしました」は情報量が無い（issue の指摘）。
      ID を知りたい人（運用者自身がトラブル報告で貼るときなど）のために
      隅に残すが、既定では開かない。
    */}
    <details>
      <summary class={ITEM_META_CLASS}>サインイン情報</summary>
      <p class={ITEM_RAW_CLASS}>{sub}</p>
    </details>
  </KiwaShell>
);

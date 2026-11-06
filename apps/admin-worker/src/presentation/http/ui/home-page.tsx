import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  KiwaShell,
} from "@u18/web-ui/kiwa";
import { ITEM_META_CLASS, ITEM_RAW_CLASS } from "@u18/web-ui/kiwa/island-classes";
import type { AdminCardStatusDelegated, AuditLogEntryAdmin, UserRefAdmin } from "@u18/contracts";
import type { FC } from "hono/jsx";
import { ADMIN_NAV_GROUPS } from "./nav";
import { KIWA_STYLESHEET_PATH } from "./asset-paths";
import { formatDateTime } from "./format";
import { UserRef } from "./user-ref";

/**
 * ホーム（`/`、#449）。**承認済みの人だけが来る**（`app.ts` のガード）。
 *
 * #443（完了済み）の段階では、Kiwa UI の `Card` 1 枚に「サインイン
 * しました」とリンク列挙を並べただけだった——**枠には入ったが、
 * ダッシュボードではなかった。** ここでは「いま何が起きているか」が
 * 開いた瞬間に分かるよう、**いまの状態を表す数**（押すとその一覧へ飛ぶ）と
 * **利用者・アプリの操作**を最初に出す。
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
 * 4 つの塊（NFC・クライアント・利用者・監査ログ）はそれぞれ独立に取得し、
 * 失敗した塊だけ「いま取れません」に差し替える——`serviceUnavailable`
 * は画面全体を潰すので、ここでは使わない。管理画面のホームが
 * 行き止まりになるのが一番まずい（運用者の立っている指示）。
 *
 * ## 利用者数は `deleted` も出す（#512）
 *
 * NFC カードの塊が「未紐づけ / 有効 / 無効化済み」の 3 状態を並べて
 * 出しているのに揃えた。1 つの状態だけ隠すと、カードの行と並んだときに
 * 「合計が合わない」と運用者を混乱させる——`countUsers` の JSDoc を参照。
 *
 * ## 「直近の管理操作」は見出しどおりではなかった（#515）
 *
 * 絞り込み無しで `listAuditLogs` を引くと、`audit_logs` には**ログイン・
 * セッション発行・OTP 検証・トークン発行が運営の操作より桁違いに多く
 * 入る**ので、本番ではこの節がほぼ常に「誰かがログインした」だけを表示
 * していた。運営が利用者を凍結しても、カードを無効化しても、次のログイン
 * 5 件に流されてホームから見えない——見出しが約束していることと、出て
 * いるものが違っていた。
 *
 * `listAuditLogs({ category: "operator_action" })` で絞り込む。**どの
 * `event` 名が「運営の操作」かは auth-worker 側に閉じている**
 * （`OPERATOR_ACTION_EVENTS` の冒頭を参照）——ここではカテゴリ名だけを
 * 渡し、具体的なイベント名は知らない。
 *
 * **見出しも範囲に合わせた。** 「直近の管理操作」のままだと、カードの
 * 無効化・復帰も含まれると誤読される——しかし NFC カードの操作は
 * `nfc_card_events`（別 D1）に入り、ここにはそもそも現れない
 * （ランブックの「別の D1 にあるため、片方しか見ない事故」と同じ構図）。
 * 「利用者・アプリの操作」という、実際に出る系統を指す見出しに変え、
 * カードの操作を探す人のために `/nfc` への導線を添えた。
 *
 * **「権限」は見出しに入れていない。** `ops.admin.*`（`users.is_admin`
 * の付与・剥奪）は利用者に対する操作として出るが、**運用者が「権限」と
 * 聞いて最初に思い浮かべるのはおそらく `/approvals` での承認・権限の
 * 変更** であり、あれは `ops.approval.*` / `ops.permission.*` として
 * `admin_approval_events`（admin-worker 自身の D1）に入る——**この一覧
 * （auth-worker の `audit_logs`）にはそもそも現れない。**
 *
 * カードと違い、`/approvals` の履歴を見る画面はどこにも無い
 * （`approvals-page.tsx` は現在の状態だけを出し、
 * `admin_approval_events` を読まない）——「別の場所で見られます」と
 * 書ける行き先が無いので、見出しから「権限」を外す側（いちばん正直で
 * いちばん小さい変更）を選んだ。`ops.admin.*` は出続けるので、情報が
 * 減るわけではない。
 */
export type HomePageProps = {
  readonly sub: string;
  /** `null` は取得に失敗したことを表す。0 件（本当に無い）とは区別する。 */
  readonly nfcCounts: Readonly<Record<AdminCardStatusDelegated, number>> | null;
  readonly clientCount: number | null;
  readonly userCounts: Readonly<{
    readonly active: number;
    readonly suspended: number;
    readonly deleted: number;
  }> | null;
  readonly recentAuditEntries: readonly AuditLogEntryAdmin[] | null;
  /**
   * `recentAuditEntries` の `userId` の名前解決（#482）。
   *
   * **`recentAuditEntries` が `null`（取得に失敗）でも、ここは空の `Map`
   * でよい。** `UserRef` は解決できなかった ID を生のまま出すだけで、
   * 「監査ログ自体が取れなかった」こととは区別されて表示される
   * （そもそも `recentAuditEntries` が `null` なら一覧自体を描かない）。
   */
  readonly userRefs: ReadonlyMap<string, UserRefAdmin>;
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

const UserCountTile: FC<{
  readonly counts: Readonly<{
    readonly active: number;
    readonly suspended: number;
    readonly deleted: number;
  }> | null;
}> = ({ counts }) => (
  <a href="/users" class={TILE_CLASS}>
    <Card>
      <CardHeader>
        <CardTitle>利用者</CardTitle>
        {counts === null ? (
          <CardDescription>いま取れません。</CardDescription>
        ) : (
          <CardDescription>
            有効 <span class={BIG_NUMBER_CLASS}>{counts.active}</span>
            {" ・ "}
            停止中 <span class={BIG_NUMBER_CLASS}>{counts.suspended}</span>
            {" ・ "}
            削除済み <span class={BIG_NUMBER_CLASS}>{counts.deleted}</span>
          </CardDescription>
        )}
      </CardHeader>
    </Card>
  </a>
);

const RecentAuditEntry: FC<{
  readonly entry: AuditLogEntryAdmin;
  readonly userRefs: ReadonlyMap<string, UserRefAdmin>;
}> = ({ entry, userRefs }) => (
  <li class={ITEM_META_CLASS}>
    {formatDateTime(entry.createdAt)}
    {" ・ "}
    <span class={ITEM_RAW_CLASS}>{entry.event}</span>
    {entry.userId === null ? null : (
      <>
        {" ・ "}
        <UserRef id={entry.userId} refs={userRefs} />
      </>
    )}
  </li>
);

export const HomePage: FC<HomePageProps> = ({
  sub,
  nfcCounts,
  clientCount,
  userCounts,
  recentAuditEntries,
  userRefs,
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
    <div class="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      <NfcCountTile counts={nfcCounts} />
      <OAuthClientCountTile count={clientCount} />
      <UserCountTile counts={userCounts} />
    </div>

    <Card>
      <CardHeader>
        <CardTitle>利用者・アプリの操作</CardTitle>
        <CardDescription>
          カードの操作は{" "}
          <a href="/nfc" class="underline underline-offset-4">
            /nfc
          </a>{" "}
          側で見られます。{" "}
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
              <RecentAuditEntry entry={entry} userRefs={userRefs} />
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

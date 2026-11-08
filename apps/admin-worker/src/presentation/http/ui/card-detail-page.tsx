import {
  Alert,
  AlertDescription,
  Badge,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  getButtonClasses,
  KiwaShell,
} from "@u18/web-ui/kiwa";
import {
  DANGER_BUTTON_CLASS,
  FIELD_CLASS,
  INPUT_CLASS,
  ITEM_ACTIONS_CLASS,
  ITEM_META_CLASS,
  ITEM_RAW_CLASS,
  LABEL_CLASS,
} from "@u18/web-ui/kiwa/island-classes";
import type {
  AdminCardDetailDelegated,
  AdminCardStatusDelegated,
  CardTapHistoryAnalytics,
  UserRefAdmin,
} from "@u18/contracts";
import type { FC } from "hono/jsx";
import { CSRF_FIELD_NAME } from "../csrf";
import { ADMIN_NAV_GROUPS } from "./nav";
import { ISLAND_PATH, KIWA_STYLESHEET_PATH } from "./asset-paths";
import { formatDateTime } from "./format";
import { UserRef } from "./user-ref";

/**
 * カード 1 枚の詳細（`admin.under18.dev/nfc/:cardId`、#472）。
 *
 * **`/nfc` の一覧には「1 枚を選んで調べる」材料が無かった。** 誰のか・
 * いつ発行で何回タップされたかは、長い表を目で追うしかなかった
 * （`user-detail-page.tsx` が一覧に対して持つ関係と同じ形）。
 *
 * ## 所有者の名前は #471（`ui/user-ref.tsx`）経由
 *
 * nfc-worker は Identity D1 を持たず、`AdminCardDetailDelegated` にも
 * userId までしか無い。名前解決は `ui/user-refs.ts` の `resolveUserRefs`
 * （ルート側、`nfc.routes.tsx` の `fetchAndRenderCardDetail`）が行い、
 * 表示は共有の `UserRef`（`ui/user-ref.tsx`）に任せる——**ここで独自の
 * 所有者コンポーネントは持たない**（#473 も同じものを使う）。
 *
 * ## タップの時間帯別・生ログは出していない
 *
 * `CardTapHistoryAnalytics` にそもそも無い——
 * `DelegatedCardTapHistoryUseCase`（nfc-worker）の冒頭を参照。
 *
 * ## 操作はこの画面に集める（`/nfc` の一覧とは別に持たない）
 *
 * **POST 先は `/nfc/:cardId/*` の既存ルートをそのまま使う。** 新しい
 * 更新系は作らない——フォームに `from=detail` を積むことで、操作後の
 * 戻り先だけをこの画面向けに変える（`users.routes.tsx` の
 * `cameFromDetail` と同じ形）。
 */

export type DayWindow = 30 | 90 | 180;

export type CardDetailPageProps = {
  readonly csrfToken: string;
  readonly card: AdminCardDetailDelegated;
  readonly days: DayWindow;
  /** タップ履歴の取得に失敗していれば `null`（`nfc-analytics-page.tsx` と同じ判断）。 */
  readonly tapHistory: CardTapHistoryAnalytics | null;
  /** `resolveUserRefs` の戻り値（#471）。解決できなければ `UserRef` 自身が ID を出す。 */
  readonly ownerRefs: ReadonlyMap<string, UserRefAdmin>;
  readonly error?: string;
};

const STATUS_LABEL: Readonly<Record<AdminCardStatusDelegated, string>> = {
  issued: "未紐づけ",
  active: "有効",
  disabled: "無効化済み",
};

/** `nfc-page.tsx` と同じ割り当て。**色で良し悪しを言わない。** */
const STATUS_VARIANT: Readonly<Record<AdminCardStatusDelegated, "secondary" | "destructive">> = {
  issued: "secondary",
  active: "secondary",
  disabled: "destructive",
};

/**
 * 無効化の理由と日時。**`disabled` ならこの画面でいちばん上に出す**
 * （issue #472 の指示）。理由が空なら「理由は記録されていません」と
 * 書く——空欄にすると、詰め忘れと記録が無いことの区別がつかなくなる。
 *
 * **鉤括弧は実際に記録された文字列を出すときだけ。** 「理由が記録されて
 * いません」まで鉤括弧に入れると、その文字列自体が理由として記録されて
 * いるように読める（3b のレビュー）。
 */
const DisabledBanner: FC<{ readonly card: AdminCardDetailDelegated }> = ({ card }) => {
  if (card.status !== "disabled") return null;

  return (
    <Alert>
      <AlertDescription>
        <strong>無効化されています。</strong>
        {card.disabledReason === null || card.disabledReason === "" ? (
          <>理由は記録されていません</>
        ) : (
          <>
            理由は「<code class={ITEM_RAW_CLASS}>{card.disabledReason}</code>」
          </>
        )}
        。{card.disabledAt === null ? null : <>（{formatDateTime(card.disabledAt)}）</>}
      </AlertDescription>
    </Alert>
  );
};

const CardOverview: FC<{
  readonly card: AdminCardDetailDelegated;
  readonly ownerRefs: ReadonlyMap<string, UserRefAdmin>;
}> = ({ card, ownerRefs }) => (
  <Card>
    <CardHeader>
      <CardTitle>
        <span class="flex flex-wrap items-center gap-2 font-medium">
          <code class={ITEM_RAW_CLASS}>{card.cardId}</code>
          {/* コピーの実装は #470 の JS が担う。属性だけ先に付ける。 */}
          <button type="button" data-copy={card.cardId} hidden>
            コピー
          </button>
          <Badge variant={STATUS_VARIANT[card.status]}>{STATUS_LABEL[card.status]}</Badge>
        </span>
      </CardTitle>
    </CardHeader>
    <CardContent class="flex flex-col gap-4">
      <DisabledBanner card={card} />
      <dl class="grid gap-3 sm:grid-cols-2">
        <div>
          <dt class={LABEL_CLASS}>所有者</dt>
          <dd class={ITEM_META_CLASS}>
            <UserRef id={card.ownerUserId} refs={ownerRefs} />
          </dd>
        </div>
        <div>
          <dt class={LABEL_CLASS}>ロット</dt>
          <dd class={ITEM_META_CLASS}>{card.batch ?? "—"}</dd>
        </div>
        <div>
          <dt class={LABEL_CLASS}>発行</dt>
          <dd class={ITEM_META_CLASS}>{formatDateTime(card.issuedAt)}</dd>
        </div>
        <div>
          <dt class={LABEL_CLASS}>引き取り</dt>
          <dd class={ITEM_META_CLASS}>
            {card.claimedAt === null ? "まだ引き取られていません" : formatDateTime(card.claimedAt)}
          </dd>
        </div>
        <div>
          <dt class={LABEL_CLASS}>譲渡回数</dt>
          <dd class={ITEM_META_CLASS}>{card.transferCount}</dd>
        </div>
        <div>
          <dt class={LABEL_CLASS}>遷移先</dt>
          {/* **リンクにしない**（`nfc-page.tsx` と同じ理由——利用者が自由に入れた外部 URL）。 */}
          <dd class="max-w-xs font-mono text-xs break-all whitespace-normal text-foreground-soft">
            {card.targetUrl ?? "未設定"}
            {card.targetUrl === null ? null : (
              <>
                {" "}
                {/* コピー用（#470）。JS が外すまでは存在しない（#488）。 */}
                <button type="button" data-copy={card.targetUrl} hidden class="text-xs underline">
                  コピー
                </button>
              </>
            )}
          </dd>
        </div>
      </dl>
    </CardContent>
  </Card>
);

/**
 * 日次タップの棒グラフ。**`nfc-analytics-page.tsx` の `TapChart` と同じ
 * 作りを写した**（issue #472 の指示）。あちらを import しない——
 * `ui/nfc-analytics-page.tsx` は #470 の持ち分で、触らない約束になっている。
 *
 * `<rect>` に `data-tip` を付ける（#470 の約束）——JS が無ければ何も
 * 起きないが、吹き出しの実装はここで属性を待つだけでよい形にしてある。
 */
const TapChart: FC<{ readonly dailyTotals: CardTapHistoryAnalytics["dailyTotals"] }> = ({
  dailyTotals,
}) => {
  const total = dailyTotals.reduce((sum, day) => sum + day.total, 0);
  if (total === 0) {
    return <p class={ITEM_META_CLASS}>この期間はタップがありません。</p>;
  }

  const width = 600;
  const height = 100;
  const days = dailyTotals.length;
  const gap = 1;
  const barWidth = width / days - gap;
  const max = Math.max(...dailyTotals.map((day) => day.total));

  return (
    <div class="flex flex-col gap-1">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        class="h-24 w-full text-primary"
        role="img"
        aria-label={`日次タップ数の推移。${dailyTotals.length} 日ぶん、合計 ${total} 回`}
      >
        {dailyTotals.map((day, index) => {
          const barHeight = max === 0 ? 0 : (day.total / max) * height;
          return (
            <rect
              x={index * (barWidth + gap)}
              y={height - barHeight}
              width={barWidth}
              height={barHeight}
              fill="currentColor"
              data-tip={`${day.date} · ${day.total} タップ`}
            />
          );
        })}
      </svg>
      <div class={`flex justify-between ${ITEM_META_CLASS}`}>
        <span>{dailyTotals[0]?.date}</span>
        <span>{dailyTotals[dailyTotals.length - 1]?.date}</span>
      </div>
    </div>
  );
};

const DAY_WINDOWS: readonly DayWindow[] = [30, 90, 180];

const DayWindowLinks: FC<{ readonly cardId: string; readonly current: DayWindow }> = ({
  cardId,
  current,
}) => (
  <div class="flex gap-3">
    {DAY_WINDOWS.map((window) =>
      window === current ? (
        <span class="text-sm font-medium text-foreground">{window} 日</span>
      ) : (
        <a href={`/nfc/${cardId}?days=${window}`} class="text-sm underline underline-offset-4">
          {window} 日
        </a>
      ),
    )}
  </div>
);

/** 期間の比較を 1 行で。**増減を色で言わない**（design.md の方針）。 */
function comparisonText(label: string, comparison: CardTapHistoryAnalytics["last7d"]): string {
  const delta = comparison.total - comparison.previousTotal;
  const change = delta === 0 ? "増減なし" : delta > 0 ? `+${delta}` : `${delta}`;
  return `${label} ${comparison.total} 回（前の同じ長さの期間は ${comparison.previousTotal} 回、${change}）`;
}

const TapHistorySection: FC<{
  readonly cardId: string;
  readonly status: AdminCardStatusDelegated;
  readonly claimedAt: string | null;
  readonly days: DayWindow;
  readonly tapHistory: CardTapHistoryAnalytics | null;
}> = ({ cardId, status, claimedAt, days, tapHistory }) => {
  // **引き取り済みでタップ 0 件なら、はっきり出す**（issue #472「死蔵の
  // 1 枚ごとの顔」）。`lastTappedAt` は保持期間を跨いだ全期間の判定—— 選んだ
  // `days` の窓の中だけを見る `totalTaps` と違う（use case 側の冒頭を参照）。
  //
  // **`disabled` では出さない。** 無効化されたカードがタップされないのは
  // 当たり前で、この指摘は「有効なのに使われていない」死蔵を見つけるため
  // のもの——無効化済みに出すと意味が反転する（問題は無効化したこと自体
  // で、タップ 0 件はその結果でしかない。3b のレビュー）。
  const isDormant =
    status !== "disabled" &&
    claimedAt !== null &&
    tapHistory !== null &&
    tapHistory.lastTappedAt === null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>タップ</CardTitle>
        <CardDescription>
          {tapHistory !== null && (
            <>
              保持期間（{tapHistory.retentionDays} 日）より前のタップは残っていません——
              「全期間」ではなく「直近 {days} 日」です。
            </>
          )}
        </CardDescription>
      </CardHeader>
      <CardContent class="flex flex-col gap-4">
        {isDormant && (
          <Alert>
            <AlertDescription>
              <strong>引き取り済みですが、1 回もタップされていません。</strong>
            </AlertDescription>
          </Alert>
        )}

        {tapHistory === null ? (
          <p class={ITEM_META_CLASS}>いま取れません。</p>
        ) : (
          <>
            <DayWindowLinks cardId={cardId} current={days} />
            <TapChart dailyTotals={tapHistory.dailyTotals} />
            <p class={ITEM_META_CLASS}>
              合計 <span class="font-medium text-foreground">{tapHistory.totalTaps}</span> 回 （直近{" "}
              {days} 日）
            </p>
            <p class={ITEM_META_CLASS}>
              {tapHistory.lastTappedAt === null
                ? "まだ 1 回もタップされていません。"
                : `最終タップ: ${tapHistory.lastTappedAt}（${tapHistory.daysSinceLastTap} 日前）`}
            </p>
            <p class={ITEM_META_CLASS}>{comparisonText("直近 7 日:", tapHistory.last7d)}</p>
            <p class={ITEM_META_CLASS}>{comparisonText("直近 30 日:", tapHistory.last30d)}</p>
          </>
        )}
      </CardContent>
    </Card>
  );
};

/**
 * この画面からの操作。**`/nfc` の一覧（`CardActions`、`nfc-page.tsx`）と
 * 同じ POST 先を使う。** 違いは `from=detail` の hidden input だけ——
 * 押した後の戻り先がこの画面（`/nfc/:cardId`）になる
 * （`users.routes.tsx` の `cameFromDetail` と同じ形）。
 *
 * **状態で出し分ける。** `issued` のカードに「所有権の剥奪」を出さない
 * ——押すと必ず失敗する入口を作らない（issue #472 の指示、`CardActions`
 * と同じ判断）。
 */
const CardDetailActions: FC<{
  readonly card: AdminCardDetailDelegated;
  readonly csrfToken: string;
}> = ({ card, csrfToken }) => {
  if (card.status === "disabled") {
    const action =
      card.ownerUserId === null
        ? `/nfc/${card.cardId}/reinstate-to-issued`
        : `/nfc/${card.cardId}/reinstate`;
    const label = card.ownerUserId === null ? "未紐づけへ戻す" : "復帰させる";
    return (
      <form method="post" action={action} class={ITEM_ACTIONS_CLASS}>
        <input type="hidden" name={CSRF_FIELD_NAME} value={csrfToken} />
        <input type="hidden" name="from" value="detail" />
        <button type="submit" class={getButtonClasses("outline", "sm")}>
          {label}
        </button>
      </form>
    );
  }

  if (card.status === "issued") {
    return (
      <form method="post" action={`/nfc/${card.cardId}/disable`} class={ITEM_ACTIONS_CLASS}>
        <input type="hidden" name={CSRF_FIELD_NAME} value={csrfToken} />
        <input type="hidden" name="from" value="detail" />
        <button type="submit" class={DANGER_BUTTON_CLASS}>
          無効化する
        </button>
      </form>
    );
  }

  if (card.status !== "active") return null;

  return (
    <div class="flex flex-col gap-3">
      <form
        method="post"
        action={`/nfc/${card.cardId}/target`}
        class="flex flex-wrap items-end gap-2"
      >
        <input type="hidden" name={CSRF_FIELD_NAME} value={csrfToken} />
        <input type="hidden" name="from" value="detail" />
        <label class={FIELD_CLASS} for="card-target-url">
          <span class={LABEL_CLASS}>遷移先</span>
          <input
            id="card-target-url"
            type="url"
            name="targetUrl"
            value={card.targetUrl ?? ""}
            class={`${INPUT_CLASS} w-72`}
            placeholder="https://example.com/"
          />
        </label>
        <button type="submit" class={getButtonClasses("outline", "sm")}>
          書き換える
        </button>
      </form>
      <div class={ITEM_ACTIONS_CLASS}>
        <form method="post" action={`/nfc/${card.cardId}/release`}>
          <input type="hidden" name={CSRF_FIELD_NAME} value={csrfToken} />
          <input type="hidden" name="from" value="detail" />
          <button type="submit" class={DANGER_BUTTON_CLASS}>
            手放させる
          </button>
        </form>
        <form method="post" action={`/nfc/${card.cardId}/disable`}>
          <input type="hidden" name={CSRF_FIELD_NAME} value={csrfToken} />
          <input type="hidden" name="from" value="detail" />
          <button type="submit" class={DANGER_BUTTON_CLASS}>
            無効化する
          </button>
        </form>
      </div>
    </div>
  );
};

export const CardDetailPage: FC<CardDetailPageProps> = ({
  csrfToken,
  card,
  days,
  tapHistory,
  ownerRefs,
  error,
}) => (
  <KiwaShell
    title="カードの詳細"
    nav={ADMIN_NAV_GROUPS}
    current="nfc"
    brandHref="/"
    stylesheet={KIWA_STYLESHEET_PATH}
    scripts={[ISLAND_PATH]}
    heading="カードの詳細"
    lead="誰のカードで、いつ発行され、何回タップされたかを 1 枚で確かめられます。"
  >
    <div>
      <a href="/nfc" class="text-sm text-foreground-muted underline underline-offset-4">
        ← NFC カードの一覧へ戻る
      </a>
    </div>

    {error === undefined ? null : (
      <p class="text-sm/relaxed text-destructive" role="alert" data-notice>
        {error}
      </p>
    )}

    {/*
      #470 のタブ（`admin-island.ts` の `attachTabs`）。markup・クラスは
      `ui/client/README.md` の見本、`client-detail-page.tsx`（#473）と同じ
      形に揃えてある——書き方が画面ごとに分かれるのを避けるため。
      JS が無ければ `data-panel` の節は見出し付きで縦に並ぶ（絶対条件）。
      JS があれば既定で 1 枚目だけが見える。
    */}
    <div data-tabs>
      <div role="tablist" class="flex gap-2 border-b border-border" aria-label="カード詳細のタブ">
        <button
          type="button"
          data-tab="overview"
          class="px-3 py-2 text-sm font-medium text-foreground-muted hover:text-foreground"
        >
          概要
        </button>
        <button
          type="button"
          data-tab="taps"
          class="px-3 py-2 text-sm font-medium text-foreground-muted hover:text-foreground"
        >
          タップ
        </button>
        <button
          type="button"
          data-tab="actions"
          class="px-3 py-2 text-sm font-medium text-foreground-muted hover:text-foreground"
        >
          操作
        </button>
      </div>

      <section data-panel="overview" class="flex flex-col gap-4">
        <CardOverview card={card} ownerRefs={ownerRefs} />
      </section>

      <section data-panel="taps" class="flex flex-col gap-4">
        <TapHistorySection
          cardId={card.cardId}
          status={card.status}
          claimedAt={card.claimedAt}
          days={days}
          tapHistory={tapHistory}
        />
      </section>

      <section data-panel="actions" class="flex flex-col gap-4">
        <Card>
          <CardHeader>
            <CardTitle>操作</CardTitle>
          </CardHeader>
          <CardContent>
            <CardDetailActions card={card} csrfToken={csrfToken} />
          </CardContent>
        </Card>
      </section>
    </div>
  </KiwaShell>
);

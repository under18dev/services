import {
  Badge,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Empty,
  EmptyHeader,
  EmptyTitle,
  KiwaShell,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@u18/web-ui/kiwa";
import { ITEM_META_CLASS, ITEM_RAW_CLASS } from "@u18/web-ui/kiwa/island-classes";
import type {
  AdminCardStatusDelegated,
  BatchAnalyticsRow,
  CardUsageRankingAnalytics,
  DisabledReasonBreakdownAnalytics,
  TapTimeseriesAnalytics,
  TransferCountDistributionAnalytics,
  UsageFunnelAnalytics,
} from "@u18/contracts";
import type { FC } from "hono/jsx";
import { ADMIN_NAV_GROUPS } from "./nav";
import { ISLAND_PATH, KIWA_STYLESHEET_PATH } from "./asset-paths";

/**
 * NFC の解析画面（`/nfc/analytics`、#454 / #470）。
 *
 * **6 区画とも、取得に失敗していれば `null`。** `null` と「0 件（本当に
 * 無い）」を区別する——`home-page.tsx` の `HomePageProps` と同じ判断。
 *
 * **グラフはサーバ側の inline SVG だけ。** 軸・目盛り・凡例は作らず、
 * 数値はテキストで併記する——運用者から「デザインに AI 味が強い」
 * 「Vercel っぽく」と繰り返し言われているため、Kiwa の色トークン
 * （`text-primary` など）をそのまま使い、自前の配色を作らない。
 *
 * **6 区画をタブにしない（#470）。** `admin-island.ts` はタブの primitive
 * （`data-tabs`）を持つが、ここでは使わない——運用者は「解析はガッチガチに
 * 見たい」と言っており、半分をタブの裏に隠すのは逆行する。足すのは
 * グラフの吹き出し（`data-tip`）だけ。
 */
export type DayWindow = 30 | 90 | 180;

export type NfcAnalyticsPageProps = {
  readonly days: DayWindow;
  readonly timeseries: TapTimeseriesAnalytics | null;
  readonly funnel: UsageFunnelAnalytics | null;
  readonly batches: { readonly rows: readonly BatchAnalyticsRow[] } | null;
  readonly usage: CardUsageRankingAnalytics | null;
  readonly disabledBreakdown: DisabledReasonBreakdownAnalytics | null;
  readonly transferDistribution: TransferCountDistributionAnalytics | null;
};

const STATUS_LABEL: Readonly<Record<AdminCardStatusDelegated, string>> = {
  issued: "未紐づけ",
  active: "有効",
  disabled: "無効化済み",
};

/** 件数が取れなかったときの共通表示。`home-page.tsx` と同じ文言。 */
const Unavailable: FC = () => <p class={ITEM_META_CLASS}>いま取れません。</p>;

/**
 * 日次タップの棒グラフ（#454「①」）。
 *
 * **軸もラベルも持たない。** `viewBox` で原点に固定するだけの、純粋な
 * 装飾 SVG——読み取るべき数値（合計・日平均・最大の日）はこのすぐ下に
 * テキストで出す。タップが 1 件も無い期間は、0 の棒を並べても意味が
 * 無いので描かない。
 */
const TapChart: FC<{ readonly timeseries: TapTimeseriesAnalytics }> = ({ timeseries }) => {
  if (timeseries.totalTaps === 0) {
    return <p class={ITEM_META_CLASS}>この期間はタップがありません。</p>;
  }

  const width = 600;
  const height = 100;
  const days = timeseries.dailyTotals.length;
  const gap = 1;
  const barWidth = width / days - gap;
  const max = Math.max(...timeseries.dailyTotals.map((day) => day.total));

  return (
    <div class="flex flex-col gap-1">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        class="h-24 w-full text-primary"
        role="img"
        aria-label={`日次タップ数の推移。${timeseries.dailyTotals.length} 日ぶん、合計 ${timeseries.totalTaps} 回`}
      >
        {timeseries.dailyTotals.map((day, index) => {
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
        <span>{timeseries.dailyTotals[0]?.date}</span>
        <span>{timeseries.dailyTotals[timeseries.dailyTotals.length - 1]?.date}</span>
      </div>
    </div>
  );
};

const DAY_WINDOWS: readonly DayWindow[] = [30, 90, 180];

const DayWindowLinks: FC<{ readonly current: DayWindow }> = ({ current }) => (
  <div class="flex gap-3">
    {DAY_WINDOWS.map((window) =>
      window === current ? (
        <span class="text-sm font-medium text-foreground">{window} 日</span>
      ) : (
        <a href={`/nfc/analytics?days=${window}`} class="text-sm underline underline-offset-4">
          {window} 日
        </a>
      ),
    )}
  </div>
);

const TapTimeseriesSection: FC<{
  readonly days: DayWindow;
  readonly timeseries: TapTimeseriesAnalytics | null;
}> = ({ days, timeseries }) => (
  <Card>
    <CardHeader>
      <CardTitle>タップの時系列</CardTitle>
      <CardDescription>
        直近 {days} 日の日次合計。
        {timeseries !== null && (
          <>
            保持期間（{timeseries.retentionDays} 日）より前のタップは残っていません——
            「全期間」ではなく「直近 {days} 日」です。
          </>
        )}
      </CardDescription>
    </CardHeader>
    <CardContent class="flex flex-col gap-4">
      <DayWindowLinks current={days} />
      {timeseries === null ? (
        <Unavailable />
      ) : (
        <>
          <TapChart timeseries={timeseries} />
          <p class={ITEM_META_CLASS}>
            合計 <span class="font-medium text-foreground">{timeseries.totalTaps}</span> 回 ・ 1
            日平均 <span class="font-medium text-foreground">{timeseries.dailyAverage}</span> 回
            {timeseries.maxDay !== null && (
              <>
                {" "}
                ・ 最大 {timeseries.maxDay.date}（
                <span class="font-medium text-foreground">{timeseries.maxDay.total}</span> 回）
              </>
            )}
          </p>
        </>
      )}
    </CardContent>
  </Card>
);

function rate(numerator: number, denominator: number): string {
  if (denominator === 0) return "—";
  return `${Math.round((numerator / denominator) * 1000) / 10}%`;
}

const UsageFunnelSection: FC<{ readonly funnel: UsageFunnelAnalytics | null }> = ({ funnel }) => (
  <Card>
    <CardHeader>
      <CardTitle>ファネル</CardTitle>
      <CardDescription>
        発行 → 引き取り → 使用。各段は「通過したことがあるか」で、無効化されても戻らない。
      </CardDescription>
    </CardHeader>
    <CardContent>
      {funnel === null ? (
        <Unavailable />
      ) : (
        <div class="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div>
            <p class={ITEM_META_CLASS}>発行</p>
            <p class="text-xl font-semibold text-foreground">{funnel.issued}</p>
          </div>
          <div>
            <p class={ITEM_META_CLASS}>引き取り済み（{rate(funnel.claimedEver, funnel.issued)}）</p>
            <p class="text-xl font-semibold text-foreground">{funnel.claimedEver}</p>
          </div>
          <div>
            <p class={ITEM_META_CLASS}>
              直近 {funnel.retentionDays} 日でタップされた（
              {rate(funnel.tappedEver, funnel.claimedEver)}）
            </p>
            <p class="text-xl font-semibold text-foreground">{funnel.tappedEver}</p>
          </div>
        </div>
      )}
    </CardContent>
  </Card>
);

const BatchAnalyticsSection: FC<{
  readonly batches: { readonly rows: readonly BatchAnalyticsRow[] } | null;
}> = ({ batches }) => (
  <Card>
    <CardHeader>
      <CardTitle>バッチ別</CardTitle>
      <CardDescription>配布ロット単位の発行・引き取り・無効化・タップ。</CardDescription>
    </CardHeader>
    <CardContent>
      {batches === null ? (
        <Unavailable />
      ) : batches.rows.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>発行されたカードはありません。</EmptyTitle>
          </EmptyHeader>
        </Empty>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>バッチ</TableHead>
              <TableHead>発行</TableHead>
              <TableHead>引き取り済み</TableHead>
              <TableHead>無効化済み</TableHead>
              <TableHead>タップ合計</TableHead>
              <TableHead>直近 7 日</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {batches.rows.map((row) => (
              <TableRow key={row.batch ?? "__no_batch__"}>
                <TableCell>
                  {/*
                    **「（バッチ名なし）」の行はリンクにしない**（issue #481
                    への追記）。あれは `null` であって「`なし` という名前の
                    バッチ」ではない——`/nfc?batch=` へ飛ばすと、
                    バッチ名を持たない全カードを「ロット名が空文字のカード」
                    として検索する形になり、質問がすり替わる。
                  */}
                  {row.batch === null ? (
                    "（バッチ名なし）"
                  ) : (
                    <a
                      href={`/nfc?batch=${encodeURIComponent(row.batch)}`}
                      class="underline underline-offset-4"
                    >
                      {row.batch}
                    </a>
                  )}
                </TableCell>
                <TableCell>{row.issued}</TableCell>
                <TableCell>
                  {row.claimedEver}（{rate(row.claimedEver, row.issued)}）
                </TableCell>
                <TableCell>{row.disabled}</TableCell>
                <TableCell>{row.tapsAllTime}</TableCell>
                <TableCell>{row.tapsLast7d}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </CardContent>
  </Card>
);

const CardUsageSection: FC<{ readonly usage: CardUsageRankingAnalytics | null }> = ({ usage }) => (
  <Card>
    <CardHeader>
      <CardTitle>カード別ランキングと死蔵の検出</CardTitle>
      <CardDescription>
        タップ上位と、引き取り済みでタップが 1 回も無いカード。所有者は出していません——
        カードの操作は、カード ID を押して詳細から行ってください。
      </CardDescription>
    </CardHeader>
    <CardContent class="flex flex-col gap-6">
      {usage === null ? (
        <Unavailable />
      ) : (
        <>
          <div>
            <h3 class="mb-2 text-sm font-medium text-foreground">タップ上位</h3>
            {usage.ranking.length === 0 ? (
              <p class={ITEM_META_CLASS}>タップされたカードがありません。</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>カード ID</TableHead>
                    <TableHead>ロット</TableHead>
                    <TableHead>状態</TableHead>
                    <TableHead>タップ合計</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {usage.ranking.map((row) => (
                    <TableRow key={row.cardId}>
                      <TableCell class="font-mono text-xs">
                        {/*
                          **カード詳細（#472）へのリンク**（#518、見つけた
                          カードへ手を打ちに行けなかった穴）。`/nfc` の
                          一覧（#481）と同じ規則——ID が人の見分けに使う
                          ものなので、ID 自体をリンクにする。
                        */}
                        <a
                          href={`/nfc/${encodeURIComponent(row.cardId)}`}
                          class="underline underline-offset-4"
                        >
                          {row.cardId}
                        </a>{" "}
                        <button
                          type="button"
                          data-copy={row.cardId}
                          hidden
                          class="text-xs underline"
                        >
                          コピー
                        </button>
                      </TableCell>
                      <TableCell>{row.batch ?? "—"}</TableCell>
                      <TableCell>
                        <Badge variant="secondary">{STATUS_LABEL[row.status]}</Badge>
                      </TableCell>
                      <TableCell>{row.total}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </div>

          <div>
            <h3 class="mb-2 text-sm font-medium text-foreground">
              死蔵（引き取り済み・タップ 0 件）—— {usage.dormant.count} 枚
            </h3>
            {usage.dormant.rows.length === 0 ? (
              <p class={ITEM_META_CLASS}>該当するカードはありません。</p>
            ) : (
              <>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>カード ID</TableHead>
                      <TableHead>ロット</TableHead>
                      <TableHead>引き取り</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {usage.dormant.rows.map((row) => (
                      <TableRow key={row.cardId}>
                        <TableCell class="font-mono text-xs">
                          <a
                            href={`/nfc/${encodeURIComponent(row.cardId)}`}
                            class="underline underline-offset-4"
                          >
                            {row.cardId}
                          </a>{" "}
                          <button
                            type="button"
                            data-copy={row.cardId}
                            hidden
                            class="text-xs underline"
                          >
                            コピー
                          </button>
                        </TableCell>
                        <TableCell>{row.batch ?? "—"}</TableCell>
                        <TableCell class={ITEM_META_CLASS}>{row.claimedAt.split("T")[0]}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                {usage.dormant.count > usage.dormant.rows.length && (
                  <p class={`${ITEM_META_CLASS} mt-2`}>
                    古い順に {usage.dormant.rows.length} 件を表示。ほか{" "}
                    {usage.dormant.count - usage.dormant.rows.length} 件。
                  </p>
                )}
              </>
            )}
          </div>
        </>
      )}
    </CardContent>
  </Card>
);

/**
 * `nfc_cards.disabled_reason` のうち、コードが実際に書く値（#496）。
 *
 * **正本はここ。** 以前はこの画面が理由コードを 1 つも訳さず生のまま
 * 並べていて、`schema`（`packages/nfc-db/src/schema/cards.ts`）のコメントが
 * 挙げていた例（`"abuse"` `"ops"`）はどこにも実在しなかった。コードが
 * 書く値はソースから数えられる——`lost` / `unused` は `cards.routes.ts`
 * の `POST /:cardId/disable`、`admin_action` は
 * `DelegatedDisableCardUseCase`、`admin_batch` は
 * `domain/services/disabled-reason.ts` の `ADMIN_BATCH_DISABLED_REASON`
 * （#436）、`owner_suspended` は同ファイルの
 * `OWNER_SUSPENDED_DISABLED_REASON`（アカウント凍結に連動した無効化、
 * #486）。
 *
 * **`"ops"` はコードの既定語彙では無いが、今も実在する運用値。**
 * ランブック §12.4(5)（対象利用者の行自体が無い、孤立カードへの対応）が
 * 手書き SQL で使い続けている——過去の 1 回きりの書き込みではないので、
 * 「過去の行にだけ残っている値」として扱わず、ここに含めてラベルを
 * 付ける（コードが書く値ではないので、上の 5 つとは別に添えてある）。
 *
 * **ここに無い値（`"abuse"` など、実在が確認できていないもの）は
 * 生のコードのまま出す。** 「不明」とは書かない——#471 の `UserRef` と
 * 同じ理由で、値そのものが無いのか、知らない値が入っているのかを
 * 運用者が区別できなくなる。
 */
const DISABLED_REASON_LABEL: Readonly<Record<string, string>> = {
  lost: "紛失のため",
  unused: "使っていないため",
  admin_action: "運営の単発操作で無効化",
  admin_batch: "運営の一括無効化",
  owner_suspended: "所有者の利用停止に伴う無効化",
  ops: "孤立カードへの運用対応（ランブック §12.4(5)）",
};

/** 理由コード 1 つぶんの表示。**既知なら日本語＋コード、未知ならコードのまま。** */
const DisabledReasonLabel: FC<{ readonly reason: string | null }> = ({ reason }) => {
  if (reason === null) return <span class={ITEM_META_CLASS}>（なし）</span>;

  const label = DISABLED_REASON_LABEL[reason];
  if (label === undefined) {
    // **「不明」と書かない。** 値が無いのではなく、ここに登録していない
    // だけ——その違いが読めなくなる。
    return <code class={ITEM_RAW_CLASS}>{reason}</code>;
  }

  return (
    <>
      {label} <span class={ITEM_META_CLASS}>（{reason}）</span>
    </>
  );
};

const DisabledReasonSection: FC<{
  readonly disabledBreakdown: DisabledReasonBreakdownAnalytics | null;
}> = ({ disabledBreakdown }) => (
  <Card>
    <CardHeader>
      <CardTitle>無効化の内訳</CardTitle>
      <CardDescription>
        理由コードは、カードを止めた経路（本人の申告・運営の操作・アカウント凍結など）で
        決まります。既知の値は日本語で、対応表に無い値はコードのまま出します——
        ここに出ている理由コードが、いま無効化されているカードに実在するものの全部です
        （絞り込みはしていません）。
      </CardDescription>
    </CardHeader>
    <CardContent>
      {disabledBreakdown === null ? (
        <Unavailable />
      ) : disabledBreakdown.rows.length === 0 ? (
        <p class={ITEM_META_CLASS}>無効化されたカードはありません。</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>理由</TableHead>
              <TableHead>枚数</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {disabledBreakdown.rows.map((row) => (
              <TableRow key={row.reason ?? "__null__"}>
                <TableCell class="whitespace-normal">
                  <DisabledReasonLabel reason={row.reason} />
                </TableCell>
                <TableCell>{row.count}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </CardContent>
  </Card>
);

const TRANSFER_BUCKET_LABEL: Readonly<Record<keyof TransferCountDistributionAnalytics, string>> = {
  zero: "0 回",
  one: "1 回",
  two: "2 回",
  threeOrMore: "3 回以上",
};

const TransferDistributionSection: FC<{
  readonly transferDistribution: TransferCountDistributionAnalytics | null;
}> = ({ transferDistribution }) => (
  <Card>
    <CardHeader>
      <CardTitle>持ち主が変わり続けるカード</CardTitle>
      <CardDescription>移転（手放す → 誰かが紐づける）の回数の分布。</CardDescription>
    </CardHeader>
    <CardContent>
      {transferDistribution === null ? (
        <Unavailable />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>移転の回数</TableHead>
              <TableHead>枚数</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(
              Object.keys(TRANSFER_BUCKET_LABEL) as (keyof TransferCountDistributionAnalytics)[]
            ).map((key) => (
              <TableRow key={key}>
                <TableCell>{TRANSFER_BUCKET_LABEL[key]}</TableCell>
                <TableCell>{transferDistribution[key]}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </CardContent>
  </Card>
);

export const NfcAnalyticsPage: FC<NfcAnalyticsPageProps> = ({
  days,
  timeseries,
  funnel,
  batches,
  usage,
  disabledBreakdown,
  transferDistribution,
}) => (
  <KiwaShell
    title="NFC 解析"
    nav={ADMIN_NAV_GROUPS}
    current="nfcAnalytics"
    brandHref="/"
    stylesheet={KIWA_STYLESHEET_PATH}
    heading="NFC 解析"
    lead="発行・引き取り・使用のされ方です。期間は右上のリンクで切り替えられます。"
    scripts={[ISLAND_PATH]}
  >
    <TapTimeseriesSection days={days} timeseries={timeseries} />
    <UsageFunnelSection funnel={funnel} />
    <BatchAnalyticsSection batches={batches} />
    <CardUsageSection usage={usage} />
    <DisabledReasonSection disabledBreakdown={disabledBreakdown} />
    <TransferDistributionSection transferDistribution={transferDistribution} />
  </KiwaShell>
);

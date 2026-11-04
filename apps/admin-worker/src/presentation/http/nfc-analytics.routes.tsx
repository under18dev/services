import { pageSecurityHeaders } from "@u18/web-ui";
import type { RpcResult } from "@u18/contracts";
import type { Hono } from "hono";
import { NfcAnalyticsPage, type DayWindow } from "./ui/nfc-analytics-page";
import type { AppBindings } from "./types";

/** ランキング・死蔵の一覧に出す上限。issue の既定値（20）。 */
const RANK_LIMIT = 20;

/**
 * NFC の解析画面（`admin.under18.dev/nfc/analytics`、#454）。
 *
 * **`/nfc` とは別のルートにした。** 一覧・操作の画面はすでに大きく、
 * 6 区画ぶんの集計を同じ画面に混ぜると「何のための画面か」が読み取り
 * にくくなる——運用者の要望（「解析はガッチガチに」）に応えるなら、
 * 専用の画面にするのが素直。
 *
 * ## `days` のフォールバックは、落ちた値をそのまま画面全体で使い回す
 *
 * 不正値・未指定は 30 に丸めるが、**丸めた後の値を見出し・期間リンクの
 * ハイライト・RPC 呼び出しの全部に使う。** 生のクエリ値を画面のどこかに
 * 出す経路を作らない——URL と画面がずれると、スクリーンショットを撮って
 * 共有した人が別の期間だと思い込む（レビューの指摘）。
 *
 * ## 6 本の RPC を固定で呼ぶ。`Promise.allSettled` で区画ごとに受け止める
 *
 * `app.tsx` の `/`（#449/#452）と同じ判断——1 つの RPC が reject しても
 * 残りの区画は出す。件数に応じて呼ぶ回数が増える経路（N+1）は作らない。
 */
export function registerNfcAnalyticsRoutes(app: Hono<AppBindings>): void {
  app.get("/nfc/analytics", pageSecurityHeaders, async (c) => {
    const container = c.get("container");
    const days = resolveDays(c.req.query("days"));

    const [timeseries, funnel, batches, usage, disabledBreakdown, transferDistribution] =
      await Promise.allSettled([
        container.nfcCards.tapTimeseries({ days }),
        container.nfcCards.usageFunnel(),
        container.nfcCards.batchAnalytics(),
        container.nfcCards.cardUsageRanking({ limit: RANK_LIMIT }),
        container.nfcCards.disabledReasonBreakdown(),
        container.nfcCards.transferCountDistribution(),
      ]);

    c.header("Cache-Control", "no-store");
    return c.html(
      <NfcAnalyticsPage
        days={days}
        timeseries={pickValue(timeseries)}
        funnel={pickValue(funnel)}
        batches={pickValue(batches)}
        usage={pickValue(usage)}
        disabledBreakdown={pickValue(disabledBreakdown)}
        transferDistribution={pickValue(transferDistribution)}
      />,
    );
  });
}

/** `?days=` を 3 択へ丸める。不正値・未指定は既定の 30。 */
function resolveDays(raw: string | undefined): DayWindow {
  if (raw === "90") return 90;
  if (raw === "180") return 180;
  return 30;
}

/**
 * `Promise.allSettled` の 1 件ぶんを、成功していれば値、それ以外は
 * `null` へ落とす。**`RpcResult` の `ok: false` も `null` に畳む**——
 * 画面側は「失敗した理由」を区別しない（`home-page.tsx` と同じ判断）。
 */
function pickValue<T>(settled: PromiseSettledResult<RpcResult<T>>): T | null {
  if (settled.status !== "fulfilled") return null;
  if (!settled.value.ok) return null;
  return settled.value.value;
}

import { env } from "cloudflare:test";
import { parseJsonc } from "@u18/testing";
import { describe, expect, it } from "vitest";
import { ACCOUNT_BASE_PATH } from "../src/base-path";

/**
 * 本番の route と `ACCOUNT_BASE_PATH` が噛み合っていることを確かめる（#106）。
 *
 * #120 は**コード側**を route に合わせ、接頭辞なしのパスが 404 になることを
 * `api.test.ts` で固定した。ここが見るのは**逆向き**——
 * `wrangler.jsonc` の route だけを変えて定数を直し忘れる事故である。
 *
 * その向きはコード側のテストでは捕まらない。route を
 * `auth.under18.dev/dashboard/*` に変えても、ハンドラは `/account/...` の
 * ままなので**テストは全部通る**。壊れるのは本番だけで、しかも
 * `wrangler deploy --dry-run` も通る（route の文字列は検証されない）。
 * 設定そのものを読んで突き合わせるしか止める手が無い。
 *
 * 同じ理由で auth-worker の `ratelimits` も照合している
 * （`apps/auth-worker/test/rate-limit-config.test.ts`、#21）。
 */

type RouteConfig = { pattern: string; zone_name?: string };

const config = parseJsonc(
  (env as unknown as { TEST_WRANGLER_JSONC: string }).TEST_WRANGLER_JSONC,
) as { env?: { production?: { routes?: RouteConfig[] } } };

describe("本番 route と ACCOUNT_BASE_PATH", () => {
  const routes = config.env?.production?.routes ?? [];

  it("本番に route が設定されている", () => {
    // routes が無いと、deploy しても Worker にトラフィックが入らない。
    expect(routes.length, "env.production に routes が無い").toBeGreaterThan(0);
  });

  it("すべての route の接頭辞が ACCOUNT_BASE_PATH と一致する", () => {
    for (const route of routes) {
      // "auth.under18.dev/account/*" -> "/account/*"
      const path = route.pattern.slice(route.pattern.indexOf("/"));
      expect(path, `route ${route.pattern} がハンドラの接頭辞と噛み合っていない`).toBe(
        `${ACCOUNT_BASE_PATH}/*`,
      );
    }
  });

  it("ホスト付きの route である", () => {
    // パスだけの route はゾーン内の全ホストに当たる。auth-worker と
    // nfc-worker が同じゾーンにいるので、取り合いになる。
    for (const route of routes) {
      expect(route.pattern.startsWith("/"), `route ${route.pattern} にホストが無い`).toBe(false);
      expect(route.zone_name, `route ${route.pattern} に zone_name が無い`).toBeDefined();
    }
  });
});

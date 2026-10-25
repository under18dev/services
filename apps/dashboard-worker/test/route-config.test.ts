import { env } from "cloudflare:test";
import { parseJsonc } from "@u18/testing";
import { describe, expect, it } from "vitest";
import { ACCOUNT_BASE_PATH } from "../src/presentation/http/base-path";

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

  /** "auth.under18.dev/account/*" -> "/account/*" */
  const pathsOf = (): string[] => routes.map((r) => r.pattern.slice(r.pattern.indexOf("/")));

  it("すべての route の接頭辞が ACCOUNT_BASE_PATH と一致する", () => {
    for (const path of pathsOf()) {
      expect(
        [ACCOUNT_BASE_PATH, `${ACCOUNT_BASE_PATH}/*`],
        `route ${path} がハンドラの接頭辞と噛み合っていない`,
      ).toContain(path);
    }
  });

  it("裸の接頭辞と /* の両方がある", () => {
    // **`/*` は裸の接頭辞に一致しない。** `auth.under18.dev/account/*` は
    // `/account/` を拾うが `/account` を拾わず、auth-worker の
    // `auth.under18.dev/*` へ落ちて 404 になる。**利用者が URL バーに
    // 打つのはこちら**で、実際に本番で踏んだ（#217）。
    //
    // 同じことを `scripts/check-route-patterns.mjs` がリポジトリ全体に
    // 対して見ている。**こちらは `ACCOUNT_BASE_PATH` と結び付いている**
    // 点が違う —— 定数を変えて route を直し忘れた場合も、ここで落ちる。
    const paths = pathsOf();
    expect(paths, `裸の ${ACCOUNT_BASE_PATH} が無い`).toContain(ACCOUNT_BASE_PATH);
    expect(paths, `${ACCOUNT_BASE_PATH}/* が無い`).toContain(`${ACCOUNT_BASE_PATH}/*`);
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

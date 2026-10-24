import { env } from "cloudflare:test";
import { parseJsonc } from "@u18/testing";
import { describe, expect, it } from "vitest";
import { RateLimitPolicy, type RateLimitScope } from "../src/domain/services/rate-limit-policy";

/**
 * `wrangler.jsonc` の `ratelimits` と `RateLimitPolicy` が一致していることを確かめる。
 *
 * `limit` / `period` の実体は設定側にあり、**コードからは読めない**。
 * 一方で `Retry-After` に載せる秒数はコード側（`RateLimitPolicy`）から出る。
 * 片方だけ変えると、利用者には「60 秒待て」と言いながら実際の窓は 10 秒、
 * といった食い違いが起きる。型では止まらないのでここで照合する。
 *
 * **本番の env も確かめる。** `ratelimits` は named environment へ継承されない
 * （wrangler のスキーマに明記がある）。書き忘れると本番だけ binding が無く、
 * 429 ではなく 500 になる。`/health` は影響を受けないので #66 のデプロイ後
 * スモークテストでは気づけない。
 */

type RateLimitConfig = {
  name: string;
  namespace_id: string;
  simple: { limit: number; period: number };
};

const config = parseJsonc(env.TEST_WRANGLER_JSONC) as {
  ratelimits?: RateLimitConfig[];
  env?: { production?: { ratelimits?: RateLimitConfig[] } };
};

const SCOPES = Object.keys(RateLimitPolicy) as RateLimitScope[];

function expectMatchesPolicy(bindings: RateLimitConfig[] | undefined, where: string): void {
  expect(bindings, `${where}: ratelimits が無い`).toBeDefined();

  for (const scope of SCOPES) {
    const rule = RateLimitPolicy[scope];
    const found = bindings?.find((b) => b.name === rule.binding);

    expect(found, `${where}: ${rule.binding} の binding が無い`).toBeDefined();
    expect(found?.simple.limit, `${where}: ${rule.binding} の limit`).toBe(rule.limit);
    expect(found?.simple.period, `${where}: ${rule.binding} の period`).toBe(rule.periodSeconds);
  }
}

describe("ratelimits の設定と RateLimitPolicy が一致する", () => {
  it("既定の env", () => {
    expectMatchesPolicy(config.ratelimits, "default");
  });

  it("env.production —— 継承されないので別に書かれている必要がある", () => {
    expectMatchesPolicy(config.env?.production?.ratelimits, "production");
  });

  it("namespace_id を使い回していない", () => {
    // 同じ namespace_id を共有すると、別のエンドポイントがカウンタを
    // 食い合う。OTP 送信の枠を Passkey のログインが消費する、という形になる。
    for (const [where, bindings] of [
      ["default", config.ratelimits],
      ["production", config.env?.production?.ratelimits],
    ] as const) {
      const ids = (bindings ?? []).map((b) => b.namespace_id);
      expect(new Set(ids).size, `${where}: namespace_id が重複している`).toBe(ids.length);
    }
  });

  it("period は binding が取れる 10 / 60 のどちらかである", () => {
    // ポリシー側の型でも縛っているが、設定側は数値なら何でも書けてしまう。
    // 不正な値はデプロイ時まで分からないので、ここで落とす。
    for (const bindings of [config.ratelimits, config.env?.production?.ratelimits]) {
      for (const binding of bindings ?? []) {
        expect([10, 60]).toContain(binding.simple.period);
      }
    }
  });
});

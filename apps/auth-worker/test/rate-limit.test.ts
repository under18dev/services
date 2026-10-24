import { SELF, env } from "cloudflare:test";
import { auditLogs, createIdentityDatabase, users } from "@u18/db";
import { aUser } from "@u18/testing";
import { count } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { RateLimitPolicy } from "../src/domain/services/rate-limit-policy";
import { resetDatabase } from "./helpers";

/**
 * IP 単位のレート制限（#21、仕様書 9 Abuse）。
 *
 * 本物の binding 越しに確かめる。`RateLimiter` の fake を差すと
 * 「呼んでいること」しか言えず、**設定した回数で実際に止まること**は
 * 分からない。#88 で「上限が宣言されているのに一度も発動しない」形を
 * 直したばかりなので、ここは実体に聞く。
 *
 * ## 鍵は IP なので、テストごとに別の IP を使う
 *
 * レート制限の状態はテストファイルをまたいで残る（Cloudflare 側＝ここでは
 * miniflare の Durable Object が持つ）。同じ IP を使い回すと、前のテストが
 * 使った枠の続きから始まって結果が実行順に依存する。
 */

const BASE = "http://localhost";
const ORIGIN = "http://localhost:8787";

let nextIp = 0;
/** テストごとに重複しない IP を配る。 */
function freshIp(): string {
  nextIp += 1;
  return `203.0.113.${nextIp}`;
}

function startOtp(ip: string, body: unknown = { email: "nobody@example.com", purpose: "login" }) {
  return SELF.fetch(`${BASE}/api/auth/email/start`, {
    method: "POST",
    headers: {
      Origin: ORIGIN,
      "Content-Type": "application/json",
      "CF-Connecting-IP": ip,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("OTP 送信要求の IP レート制限", () => {
  const { limit, periodSeconds } = RateLimitPolicy.email_start;

  beforeEach(async () => {
    await resetDatabase();
  });

  it("上限までは通り、超えると 429 を返す", async () => {
    const ip = freshIp();

    for (let i = 0; i < limit; i += 1) {
      const response = await startOtp(ip);
      expect(response.status, `${i + 1} 回目は通るはず`).toBe(202);
    }

    const blocked = await startOtp(ip);
    expect(blocked.status).toBe(429);
    expect(await blocked.json()).toEqual({ error: "rate_limited", message: "too many requests" });
  });

  it("429 に Retry-After が付き、窓の長さそのものを返す", async () => {
    // binding は「いつ窓が空くか」を返さない。短く見積もると、まだ閉じている
    // 窓を叩かせることになるので、必ず窓全体を返す。
    const ip = freshIp();
    for (let i = 0; i < limit; i += 1) await startOtp(ip);

    const blocked = await startOtp(ip);
    expect(blocked.headers.get("Retry-After")).toBe(String(periodSeconds));
  });

  it("別の IP は別の枠を持つ", async () => {
    // 1 人が詰まらせても他の利用者を巻き込まない。
    const attacker = freshIp();
    for (let i = 0; i < limit + 1; i += 1) await startOtp(attacker);

    const bystander = await startOtp(freshIp());
    expect(bystander.status).toBe(202);
  });

  it("登録済みアドレスでも未登録アドレスでも 429 の見え方が同じ", async () => {
    // 429 の出方で実在が分かると、制限そのものが列挙の道具になる（#21）。
    const known = aUser({ email: "known@example.com" });
    await createIdentityDatabase(env.IDENTITY_DB)
      .insert(users)
      .values({
        id: known.id,
        username: known.username,
        displayName: known.displayName,
        primaryEmail: known.email,
        emailVerified: true,
      })
      .run();

    const ipA = freshIp();
    for (let i = 0; i < limit; i += 1) await startOtp(ipA);
    const blockedKnown = await startOtp(ipA, { email: known.email, purpose: "login" });

    const ipB = freshIp();
    for (let i = 0; i < limit; i += 1) await startOtp(ipB);
    const blockedUnknown = await startOtp(ipB, { email: "nobody@example.com", purpose: "login" });

    expect(blockedKnown.status).toBe(blockedUnknown.status);
    expect(blockedKnown.headers.get("Retry-After")).toBe(blockedUnknown.headers.get("Retry-After"));
    expect(await blockedKnown.json()).toEqual(await blockedUnknown.json());
  });

  it("本文を読む前に止める", async () => {
    // 壊れた本文なら本来 400。429 が先に出るということは、アドレスを
    // 見る前に判断しているということ。列挙の担保がここにある。
    const ip = freshIp();
    for (let i = 0; i < limit; i += 1) await startOtp(ip);

    const blocked = await startOtp(ip, "{ not json");
    expect(blocked.status).toBe(429);
  });

  it("Origin 検証に落ちたリクエストは枠を消費しない", async () => {
    // CSRF の試行で被害者の枠を削れるなら、それ自体が嫌がらせになる。
    const ip = freshIp();
    for (let i = 0; i < limit + 3; i += 1) {
      const response = await SELF.fetch(`${BASE}/api/auth/email/start`, {
        method: "POST",
        headers: {
          Origin: "https://evil.example",
          "Content-Type": "application/json",
          "CF-Connecting-IP": ip,
        },
        body: JSON.stringify({ email: "nobody@example.com", purpose: "login" }),
      });
      expect(response.status).toBe(403);
    }

    expect((await startOtp(ip)).status).toBe(202);
  });

  it("弾いたリクエストで D1 に書き込まない", async () => {
    // 429 を 1 本ごとに監査ログへ書くと、攻撃者は「弾かれること」を
    // そのまま D1 への書き込みに変換できる。レート制限が防ぐはずの
    // 資源枯渇（脅威モデル D-2）を、レート制限自身が引き起こす。
    const ip = freshIp();
    const db = createIdentityDatabase(env.IDENTITY_DB);

    for (let i = 0; i < limit; i += 1) await startOtp(ip);
    const before = await db.select({ n: count() }).from(auditLogs).get();

    for (let i = 0; i < 5; i += 1) {
      expect((await startOtp(ip)).status).toBe(429);
    }

    const after = await db.select({ n: count() }).from(auditLogs).get();
    expect(after?.n, "弾かれたリクエストが監査ログの行を増やしている").toBe(before?.n);
  });

  /*
   * 「超過が Workers のログに出ること」はここでは検証していない。
   *
   * `@cloudflare/vitest-plugin` の下では `vi.spyOn(console, "warn")` が
   * **直接の `console.warn("x")` すら捕まえない**（実測済み。pool 側が workerd の
   * console を先に差し替えているため）。`SELF.fetch` を `createApp().fetch()` に
   * 置き換えて同じ isolate で動かしても同じだった。
   *
   * 再挑戦するなら、ログの出力先を Port にして注入する形にすること。ただし
   * ログ 1 行のために Port を 1 つ増やす価値があるかは別途判断が要る。
   * 上の「弾いたリクエストで D1 に書き込まない」が、D1 を使わない（=
   * 増幅が起きない）ことまでは保証している。
   */
});

describe("OTP 検証の IP レート制限", () => {
  it("上限を超えると 429 になる", async () => {
    const ip = freshIp();
    const { limit } = RateLimitPolicy.email_verify;

    const verify = () =>
      SELF.fetch(`${BASE}/api/auth/email/verify`, {
        method: "POST",
        headers: {
          Origin: ORIGIN,
          "Content-Type": "application/json",
          "CF-Connecting-IP": ip,
        },
        body: JSON.stringify({ email: "nobody@example.com", code: "000000", purpose: "login" }),
      });

    for (let i = 0; i < limit; i += 1) {
      expect((await verify()).status, `${i + 1} 回目`).not.toBe(429);
    }

    expect((await verify()).status).toBe(429);
  });
});

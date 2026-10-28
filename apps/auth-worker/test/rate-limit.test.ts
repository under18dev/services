import { SELF, env } from "cloudflare:test";
import { auditLogs, createIdentityDatabase, users } from "@u18/db";
import { aUser } from "@u18/testing";
import { count } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { RateLimitPolicy } from "../src/domain/services/rate-limit-policy";
import { freshIpFactory } from "./fresh-ip";
import { resetDatabase, startOfRateLimitWindow } from "./helpers";

/**
 * IP 単位のレート制限（#21、仕様書 9 Abuse）。
 *
 * 本物の binding 越しに確かめる。`RateLimiter` の fake を差すと
 * 「呼んでいること」しか言えず、**設定した回数で実際に止まること**は
 * 分からない。#88 で「上限が宣言されているのに一度も発動しない」形を
 * 直したばかりなので、ここは実体に聞く。
 *
 * ## ここで言う「実体」は **miniflare** である（#236）
 *
 * 下のテストはどれも「**上限までは通り、超えると 429**」を主張している。
 * これが通るのは **miniflare が厳密に実装しているから**で、**本番にその
 * 性質は無い**。Cloudflare の Rate Limiting API は近似・コロ単位・
 * 非同期で、本番の `email_start`（`limit: 10`）は実測で**同一 60 秒窓に
 * 45 本通った**（ランブック §13.2）。
 *
 * **このファイルが守っているのは「呼んでいること」と「回帰していないこと」
 * であって、本番の上限ではない。** 数字を本番の保証として引用しないこと。
 * 止まること自体は本番でも成り立つ（続ければ止まる）が、**何本目で止まるか
 * は成り立たない**。
 *
 * ## 鍵は IP なので、テストごとに別の IP を使う
 *
 * レート制限の状態はテストファイルをまたいで残る（Cloudflare 側＝ここでは
 * miniflare の Durable Object が持つ）。同じ IP を使い回すと、前のテストが
 * 使った枠の続きから始まって結果が実行順に依存する。
 */

const BASE = "http://localhost";
const ORIGIN = "http://localhost:8787";

/** テストごとに重複しない IP を配る。割り当ては `fresh-ip.ts`。 */
const freshIp = freshIpFactory("rate-limit");

/**
 * 窓の**境界を跨がない**位置から始める（#176）。
 *
 * ## なぜ要るのか
 *
 * Cloudflare の Rate Limiting は**壁時計に揃った固定窓**で、
 * `epoch = floor(now / period)` で数える。つまり全キーが**同じ瞬間に
 * 一斉にリセットされる**。
 *
 * このファイルのテストはどれも「上限まで送ってから 1 本余計に送る」形なので、
 * その途中で窓が切り替わるとカウンタが 0 に戻り、**最後の 1 本が通ってしまう**。
 * 実装は正しいのにテストだけが落ちる。実際 #163 のマージ後、無関係な
 * ドキュメント PR が `expected 401 to be 429` で赤くなった。
 *
 * ## 直し方
 *
 * 窓の残り時間が足りなければ、次の窓の頭まで待ってから始める。
 * 実測でバースト 20 本が 21ms（1 本あたり約 1ms）なので、最大でも
 * 60 本で 70ms 程度。1 秒の余裕は 10 倍以上ある。
 *
 * **個々のテストに「気をつけて書く」ことを求めない。** `beforeEach` で
 * 全件に効かせてあるので、あとから足したテストも自動的に守られる。
 *
 * ## 境界そのものは固定していない
 *
 * 「窓を跨ぐと 2×limit 通る」のは**プラットフォーム側の性質**で、
 * こちらのコードに判断が無い。再現するには最大 60 秒待つ必要があり、
 * 得られるのは「Cloudflare の固定窓が固定窓であること」の確認でしかない。
 * **性質としてはランブック §13 に書いてある**（攻撃者が境界を狙えば
 * 短時間に 2 倍送れる）。
 */
beforeEach(async () => {
  // 全 scope が同じ period を使っている前提（下のテストで固定している）。
  await startOfRateLimitWindow(RateLimitPolicy.email_start.periodSeconds);
});

it("すべての scope が同じ窓の長さを使う", () => {
  // 違う長さが混ざると、上の beforeEach が片方の境界しか避けられない。
  // 混ぜるなら、scope ごとに待つ形へ変えること。
  const periods = new Set(Object.values(RateLimitPolicy).map((rule) => rule.periodSeconds));

  expect([...periods]).toEqual([60]);
});

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

/**
 * OAuth 経路（#21 の残り）。
 *
 * ## 鍵の形を**両側から**挟んでいる
 *
 * `/oauth/token` の鍵は `<client_id>:<ipHash>`。どちらか一方だけにすると
 * 別々の壊れ方をするので、テストも 2 本で挟んである（実測済み）。
 *
 * | 鍵を変えると | 落ちるテスト |
 * | --- | --- |
 * | IP 単体（RP のサーバが詰まる） | 「同じ IP でも client_id が違えば別の枠」 |
 * | `client_id` 単体（他人を締め出せる） | 「攻撃者は他人の client_id の枠を減らせない」 |
 *
 * **片方だけではもう片方の誤りに気づけない。** 特に `client_id` 単体は
 * #21 の本文どおりの実装なので、何も知らずに「仕様どおり」に書くと
 * そちらへ倒れる。
 */
describe("OAuth 経路のレート制限", () => {
  const ORIGIN_HEADER = { Origin: ORIGIN } as const;

  /** `/oauth/token` を叩く。`client_id` は自称でよい（鍵に混ざるだけ）。 */
  function token(ip: string, clientId: string) {
    return SELF.fetch(`${BASE}/oauth/token`, {
      method: "POST",
      headers: {
        ...ORIGIN_HEADER,
        "Content-Type": "application/x-www-form-urlencoded",
        "CF-Connecting-IP": ip,
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: clientId,
        client_secret: "wrong-secret",
        code: "cod_whatever",
        redirect_uri: "https://rp.example/callback",
      }).toString(),
    });
  }

  it("client_id と IP を混ぜた鍵で止まる", async () => {
    const ip = freshIp();
    const { limit } = RateLimitPolicy.oauth_client;

    for (let i = 0; i < limit; i += 1) {
      expect((await token(ip, "cli_victim")).status, `${i + 1} 回目`).not.toBe(429);
    }

    expect((await token(ip, "cli_victim")).status).toBe(429);
  });

  it("攻撃者は他人の client_id の枠を減らせない", async () => {
    // **これが鍵に IP を混ぜている理由。** `client_id` は秘密ではないので、
    // client_id 単体を鍵にすると他人を名乗るだけで締め出せてしまう。
    const attacker = freshIp();
    const victimRp = freshIp();
    const { limit } = RateLimitPolicy.oauth_client;

    for (let i = 0; i < limit + 5; i += 1) await token(attacker, "cli_victim");

    // 本物の RP は自分の IP に自分の枠を持っている。
    expect((await token(victimRp, "cli_victim")).status).not.toBe(429);
  });

  it("同じ IP でも client_id が違えば別の枠", async () => {
    // 1 台の RP サーバが複数のクライアントを抱える構成で、
    // 片方の事故がもう片方を巻き込まないこと。
    const ip = freshIp();
    const { limit } = RateLimitPolicy.oauth_client;

    for (let i = 0; i < limit + 1; i += 1) await token(ip, "cli_a");

    expect((await token(ip, "cli_b")).status).not.toBe(429);
  });

  it("/oauth/revoke は /oauth/token と枠を共有する", async () => {
    // RFC 7009 §2.1 が同じクライアント認証を求めており、実装も共有している。
    // 攻撃者がどちらを叩いても同じ予算を消費するほうが総量として素直。
    const ip = freshIp();
    const { limit } = RateLimitPolicy.oauth_client;

    for (let i = 0; i < limit; i += 1) await token(ip, "cli_shared");

    const revoked = await SELF.fetch(`${BASE}/oauth/revoke`, {
      method: "POST",
      headers: {
        ...ORIGIN_HEADER,
        "Content-Type": "application/x-www-form-urlencoded",
        "CF-Connecting-IP": ip,
      },
      body: new URLSearchParams({
        client_id: "cli_shared",
        client_secret: "wrong-secret",
        token: "tok_whatever",
      }).toString(),
    });

    expect(revoked.status).toBe(429);
  });

  it("/oauth/authorize は IP 単位で止まる", async () => {
    const ip = freshIp();
    const { limit } = RateLimitPolicy.oauth_authorize;

    const authorize = () =>
      SELF.fetch(`${BASE}/oauth/authorize?client_id=cli_x&response_type=code`, {
        headers: { "CF-Connecting-IP": ip },
      });

    for (let i = 0; i < limit; i += 1) {
      expect((await authorize()).status, `${i + 1} 回目`).not.toBe(429);
    }

    expect((await authorize()).status).toBe(429);
  });

  it("クライアント認証より前に止める", async () => {
    // 認証を先にすると、総当たりの 1 回ごとに秘密の照合（定時間比較つき）を
    // 走らせることになる。429 が返るなら照合まで到達していない。
    const ip = freshIp();
    const { limit } = RateLimitPolicy.oauth_client;

    for (let i = 0; i < limit; i += 1) await token(ip, "cli_early");
    const blocked = await token(ip, "cli_early");

    expect(blocked.status).toBe(429);
    // OAuth のエラー本文（invalid_client 等）ではなく 429 の本文が返る。
    expect(await blocked.json()).toEqual({ error: "rate_limited", message: "too many requests" });
  });
});

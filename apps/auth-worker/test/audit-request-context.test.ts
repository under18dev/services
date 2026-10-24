import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { auditLogs, createIdentityDatabase, users } from "@u18/db";
import { sessionCookieName } from "@u18/contracts";
import { aUser } from "@u18/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuditEvent } from "../src/application/ports/audit-log.port";
import type { IpHasher } from "../src/application/ports/crypto.port";
import { RequestScopedAuditLogger } from "../src/infrastructure/audit/request-scoped-audit-logger";
import { Sha256TokenHasher } from "../src/infrastructure/crypto/web-crypto";
import { DrizzleSessionRepository } from "../src/infrastructure/persistence/drizzle-session.repository";
import { createApp } from "../src/presentation/http/app";
import { RecordingAuditLogger } from "./fakes";
import { resetDatabase } from "./helpers";

/**
 * 監査ログに発信元を載せる（#122）。
 *
 * 列も `DrizzleAuditLogger` の配線もあったのに、**呼び出し側がどこからも
 * 渡していなかった**ので `audit_logs.ip_hash` は常に NULL だった。
 * ランブック 5.2 / 5.3 は監査ログから「どこから」を辿る前提なので、
 * 失敗したログイン試行の出どころが分からない状態になっていた。
 */

const IP = "198.51.100.42";
const UA = "u18-test/1.0";

class CountingIpHasher implements IpHasher {
  calls = 0;

  async hash(ip: string): Promise<string> {
    this.calls += 1;
    return `hashed:${ip}`;
  }
}

class ThrowingIpHasher implements IpHasher {
  async hash(): Promise<string> {
    throw new Error("ip hashing is not configured: IP_HASH_PEPPER is not set outside development");
  }
}

const anEvent = (overrides: Partial<AuditEvent> = {}): AuditEvent => ({
  event: "session.rejected",
  outcome: "failure",
  ...overrides,
});

describe("RequestScopedAuditLogger", () => {
  it("ip_hash と user_agent を全イベントに足す", async () => {
    const sink = new RecordingAuditLogger();
    const logger = new RequestScopedAuditLogger(sink, new CountingIpHasher(), {
      ip: IP,
      userAgent: UA,
    });

    await logger.record(anEvent({ event: "otp.start" }));

    expect(sink.events[0]).toMatchObject({ ipHash: `hashed:${IP}`, userAgent: UA });
  });

  it("ハッシュ化はリクエストにつき 1 回だけ", async () => {
    // 1 本のリクエストが 2 件以上書くことがある（OTP 検証 → セッション発行）。
    const hasher = new CountingIpHasher();
    const logger = new RequestScopedAuditLogger(new RecordingAuditLogger(), hasher, {
      ip: IP,
      userAgent: UA,
    });

    await Promise.all([logger.record(anEvent()), logger.record(anEvent())]);
    await logger.record(anEvent());

    expect(hasher.calls).toBe(1);
  });

  it("呼び出し側が明示した値を上書きしない", async () => {
    // イベントが指す対象（例: 他端末のセッション）と、いま叩いている
    // 発信元は別物でありうる。
    const sink = new RecordingAuditLogger();
    const logger = new RequestScopedAuditLogger(sink, new CountingIpHasher(), {
      ip: IP,
      userAgent: UA,
    });

    await logger.record(anEvent({ ipHash: "explicit-hash", userAgent: "explicit-ua" }));

    expect(sink.events[0]).toMatchObject({ ipHash: "explicit-hash", userAgent: "explicit-ua" });
  });

  it("IP が取れなければ null のまま通す", async () => {
    const sink = new RecordingAuditLogger();
    const logger = new RequestScopedAuditLogger(sink, new CountingIpHasher(), {
      ip: null,
      userAgent: null,
    });

    await logger.record(anEvent());

    expect(sink.events[0]?.ipHash).toBeUndefined();
    expect(sink.events[0]?.userAgent).toBeUndefined();
  });

  it("ハッシュ化が失敗してもイベントは記録される", async () => {
    // **ここが #122 で一番危ない所。** `UnconfiguredIpHasher` は非 development で
    // pepper が無いと投げる。素通しすると、監査のためだけの計算が認証経路を
    // 道連れにする（pepper の設定漏れ = ログイン不能）。
    const sink = new RecordingAuditLogger();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const logger = new RequestScopedAuditLogger(sink, new ThrowingIpHasher(), {
      ip: IP,
      userAgent: UA,
    });

    await expect(logger.record(anEvent())).resolves.toBeUndefined();

    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]?.ipHash).toBeUndefined();
    // user_agent まで落とさない。IP が取れないことと UA が取れないことは別。
    expect(sink.events[0]?.userAgent).toBe(UA);
    // 握り潰すのではなく Workers のログには残す。
    expect(errors).toHaveBeenCalledWith("audit ip hashing failed", expect.anything());
    errors.mockRestore();
  });
});

/**
 * HTTP の入口からの通し。
 *
 * ミドルウェアでの配線が外れていれば、ここが落ちる。
 */
describe("HTTP 経由の監査ログ（pepper が無い本番設定）", () => {
  const user = aUser({ email: "ctx@example.com" });
  const SESSION_ID = "ses_ctx_probe";
  const TOKEN = "session-token-ctx-probe";

  // `IP_HASH_PEPPER` が無い本番。`UnconfiguredIpHasher` が選ばれる。
  const brokenProd = {
    ...env,
    ENVIRONMENT: "production",
    IP_HASH_PEPPER: undefined,
  } as unknown as Env;

  beforeEach(async () => {
    await resetDatabase();
    const db = createIdentityDatabase(env.IDENTITY_DB);
    await db
      .insert(users)
      .values({
        id: user.id,
        username: user.username,
        displayName: user.displayName,
        primaryEmail: user.email,
        emailVerified: true,
      })
      .run();

    // 期限切れのセッション。提示すると `session.rejected` が 1 件書かれる。
    await new DrizzleSessionRepository(db).create({
      id: SESSION_ID,
      userId: user.id,
      tokenHash: await new Sha256TokenHasher().hash(TOKEN),
      expiresAt: new Date(Date.now() - 60 * 1000),
      authMethod: "email_otp",
      userAgent: "seed",
      ipHash: null,
    });
  });

  async function callMe(): Promise<Response> {
    const ctx = createExecutionContext();
    const response = await createApp().fetch(
      new Request("http://localhost/api/me", {
        headers: {
          Cookie: `${sessionCookieName("production")}=${TOKEN}`,
          "CF-Connecting-IP": IP,
          "User-Agent": UA,
        },
      }),
      brokenProd,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    return response;
  }

  it("pepper が無くても認証経路は 500 にならない", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    // 401（セッションが期限切れ）まで進むこと。500 になるなら、監査のための
    // ハッシュ化が認証経路を落としている。
    expect((await callMe()).status).toBe(401);

    errors.mockRestore();
  });

  it("ip_hash は空でも user_agent は残る", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    await callMe();
    errors.mockRestore();

    const rows = await createIdentityDatabase(env.IDENTITY_DB).select().from(auditLogs).all();
    const rejected = rows.filter((row) => row.event === "session.rejected");

    expect(rejected, "session.rejected が記録されていない").toHaveLength(1);
    expect(rejected[0]?.ipHash).toBeNull();
    expect(rejected[0]?.userAgent).toBe(UA);
  });
});

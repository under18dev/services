import { auditLogs, createIdentityDatabase, users } from "@u18/db";
import { sessionCookieName } from "@u18/contracts";
import { FixedClock, aUser } from "@u18/testing";
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import type { AuditEvent, AuditLogger } from "../src/application/ports/audit-log.port";
import { GetSessionUseCase } from "../src/application/use-cases/get-session.use-case";
import {
  InlineSideEffectScheduler,
  WaitUntilSideEffectScheduler,
} from "../src/infrastructure/scheduling/side-effect-schedulers";
import { Sha256TokenHasher } from "../src/infrastructure/crypto/web-crypto";
import { DrizzleSessionRepository } from "../src/infrastructure/persistence/drizzle-session.repository";
import { createApp } from "../src/presentation/http/app";
import { FakeHasher, InMemorySessionRepository, InMemoryUserRepository } from "./fakes";
import { resetDatabase } from "./helpers";

/**
 * セッション検証の応答時間からトークンの実在が漏れないこと
 * （#126 / 脅威モデル RR-15）。
 *
 * ## 時間を測らない
 *
 * **所要時間そのものを測るテストは書かない。** workerd の isolate の
 * ノイズは、ここで塞ぎたい「D1 への書き込み 1 回ぶん」より大きい。
 * 差があっても無くても緑になるテストは、#122 で見つかった
 * 「`SELF.fetch` に壊れた env を注入できていなかった」resilience テストと
 * 同じで、**検査しているつもりで何も検査していない**。
 *
 * 代わりに 2 つの不変条件を固定する。
 *
 * 1. **書き込みが固まっても応答は返る。** 応答経路に乗っていれば、
 *    固まった時点で `execute()` も返らなくなる。これは時間ではなく
 *    「返るか返らないか」なので、ノイズに左右されない。
 * 2. **応答までに待つ SELECT の回数が、実在しないトークンと
 *    失効済みトークンで等しい。** 漏れていたのはこの 2 つの区別である。
 */

const NOW = new Date("2026-10-24T12:00:00.000Z");

/** 呼ばれた回数を数える監査ログ。`record()` は永久に解決しない。 */
class HangingAuditLogger implements AuditLogger {
  readonly events: AuditEvent[] = [];

  record(event: AuditEvent): Promise<void> {
    this.events.push(event);
    return new Promise<void>(() => {});
  }
}

class CountingSessionRepository extends InMemorySessionRepository {
  reads = 0;
  /** 立てると `touch()` が永久に解決しない。 */
  hangOnTouch = false;

  override async findByTokenHash(tokenHash: string) {
    this.reads += 1;
    return super.findByTokenHash(tokenHash);
  }

  override touch(id: string, at: Date): Promise<void> {
    if (this.hangOnTouch) return new Promise<void>(() => {});
    return super.touch(id, at);
  }
}

class CountingUserRepository extends InMemoryUserRepository {
  reads = 0;

  override async findById(id: string) {
    this.reads += 1;
    return super.findById(id);
  }
}

const user = aUser();

type Fixture = {
  useCase: GetSessionUseCase;
  sessions: CountingSessionRepository;
  users: CountingUserRepository;
  audit: HangingAuditLogger;
};

/**
 * `waitUntil` を持つ入口（= 本番の HTTP 経路）を再現する。
 *
 * 逃がした先は捨てる。**捨ててよいのは、ここで見たいのが
 * 「応答がそれを待たないこと」だから。** 本物は `ctx.waitUntil` が
 * 完了まで isolate を生かす。
 */
function fixture(): Fixture {
  const sessions = new CountingSessionRepository();
  const users = new CountingUserRepository();
  const audit = new HangingAuditLogger();
  users.seed(user);

  return {
    sessions,
    users,
    audit,
    useCase: new GetSessionUseCase({
      sessions,
      users,
      hasher: new FakeHasher(),
      clock: new FixedClock(NOW),
      audit,
      sideEffects: new WaitUntilSideEffectScheduler(() => {}),
    }),
  };
}

const aSession = (id: string, overrides: Partial<{ expiresAt: Date; revokedAt: Date }> = {}) => ({
  id,
  userId: user.id,
  expiresAt: overrides.expiresAt ?? new Date(NOW.getTime() + 60 * 60 * 1000),
  revokedAt: overrides.revokedAt ?? null,
  authMethod: "passkey" as const,
  lastSeenAt: NOW,
  userAgent: null,
  ipHash: null,
  createdAt: NOW,
});

describe("GetSessionUseCase — 応答時間から実在が漏れない（RR-15）", () => {
  it("失効済みトークンでも、監査ログの書き込みを待たずに返る", async () => {
    // **これが #126 の本体。** 以前はここで INSERT を待っていたので、
    // 「トークンが見つかった」ことが所要時間として観測されえた。
    const { useCase, sessions, audit } = fixture();
    sessions.seed(aSession("ses_revoked", { revokedAt: NOW }));

    const result = await useCase.execute({ sessionToken: "ses_revoked" });

    expect(result.ok && result.value).toBeNull();
    // 記録自体は発行されている。待っていないだけ。
    expect(audit.events.map((e) => e.reason)).toEqual(["revoked"]);
  });

  it("停止中ユーザーのセッションでも、書き込みを待たずに返る", async () => {
    const { useCase, sessions, users } = fixture();
    users.seed({ ...user, status: "suspended" });
    sessions.seed(aSession("ses_suspended"));

    const result = await useCase.execute({ sessionToken: "ses_suspended" });

    expect(result.ok && result.value).toBeNull();
  });

  it("有効なセッションでも、touch の UPDATE を待たずに返る", async () => {
    const { useCase, sessions } = fixture();
    sessions.seed(aSession("ses_live"));
    sessions.hangOnTouch = true;

    const result = await useCase.execute({ sessionToken: "ses_live" });

    expect(result.ok && result.value?.userId).toBe(user.id);
  });

  it("実在しないトークンと失効済みトークンで、待つ SELECT の回数が等しい", async () => {
    // 漏れていたのはこの 2 つの区別 ——「このトークン値は DB に存在した」。
    const missing = fixture();
    const revoked = fixture();
    revoked.sessions.seed(aSession("ses_revoked", { revokedAt: NOW }));

    await missing.useCase.execute({ sessionToken: "ses_does_not_exist" });
    await revoked.useCase.execute({ sessionToken: "ses_revoked" });

    expect(missing.sessions.reads).toBe(revoked.sessions.reads);
    expect(missing.users.reads).toBe(revoked.users.reads);
    // 念のため実数も固定する。両方 0 回になったら経路ごと壊れている。
    expect(revoked.sessions.reads).toBe(1);
    expect(revoked.users.reads).toBe(0);
  });

  it("使えるセッションの経路だけ SELECT が 1 回多い（埋めていない）", async () => {
    // ここへ到達できるのは**使えるトークンを既に持っている相手だけ**で、
    // 「まだ有効だ」と知っても得るものが無い（使えば分かる）。
    // ダミーの findById で埋めると、未認証のリクエスト 1 本ごとに
    // D1 のクエリが 1 回増える。割に合わない、という判断の記録。
    const { useCase, sessions, users } = fixture();
    sessions.seed(aSession("ses_live"));

    await useCase.execute({ sessionToken: "ses_live" });

    expect(sessions.reads).toBe(1);
    expect(users.reads).toBe(1);
  });
});

describe("SideEffectScheduler の 2 つの実装", () => {
  it("Inline はその場で待つ", async () => {
    // Cron の `scheduled` はこちら。返した Promise の完了まで生存が
    // 保証されるので、待って結果をログに出すほうがよい。
    let done = false;
    await new InlineSideEffectScheduler().schedule(
      "test",
      (async () => {
        await Promise.resolve();
        done = true;
      })(),
    );

    expect(done).toBe(true);
  });

  it("Inline は副作用の失敗を呼び出し元へ伝播しない", async () => {
    await expect(
      new InlineSideEffectScheduler().schedule("test", Promise.reject(new Error("boom"))),
    ).resolves.toBeUndefined();
  });

  it("WaitUntil は待たずに返し、タスクを waitUntil へ渡す", async () => {
    const handed: Promise<unknown>[] = [];
    let done = false;
    // マイクロタスク 1 回で終わるタスクだと、`await schedule(...)` の
    // 1 ターンで完了してしまって「待っていない」ことを示せない。
    // 自分で解決するまで終わらないタスクにする。
    let release = (): void => {};
    const task = new Promise<void>((resolve) => {
      release = () => {
        done = true;
        resolve();
      };
    });

    await new WaitUntilSideEffectScheduler((t) => handed.push(t)).schedule("test", task);

    // schedule() が返った時点ではまだ終わっていない。
    expect(done).toBe(false);
    expect(handed).toHaveLength(1);

    // 渡した先が完走すれば終わる。本物は ctx.waitUntil がこれをやる。
    release();
    await handed[0];
    expect(done).toBe(true);
  });

  it("WaitUntil へ渡す Promise は reject しない", async () => {
    // reject したまま waitUntil へ渡すと Workers が「未処理の拒否」として
    // 扱う。失敗は飲み込んでログにだけ残す、という契約はここでも同じ。
    const handed: Promise<unknown>[] = [];

    await new WaitUntilSideEffectScheduler((task) => handed.push(task)).schedule(
      "test",
      Promise.reject(new Error("boom")),
    );

    await expect(handed[0]).resolves.toBeUndefined();
  });
});

/**
 * 本物の HTTP 入口が `waitUntil` を渡していること。
 *
 * **ここが無いと上のテストは意味を失う。** `requestContext()` は
 * `c.executionCtx` が取れなければ黙って `undefined` を返し、コンテナは
 * Inline（応答前に待つ）側へ倒れる。つまり **UseCase 側を直しても、
 * 入口が渡していなければ応答時間は元のまま**になる。
 *
 * #122 で「`/health` の resilience テストが壊れた env を注入できていなかった」
 * のと同じ構図なので、入口まで通して確かめる。
 */
describe("HTTP の入口が waitUntil を渡している", () => {
  it("失効済みセッションの提示で ctx.waitUntil が呼ばれる", async () => {
    await resetDatabase();
    const db = createIdentityDatabase(env.IDENTITY_DB);
    const probe = aUser({ email: "timing@example.com" });
    await db
      .insert(users)
      .values({
        id: probe.id,
        username: probe.username,
        displayName: probe.displayName,
        primaryEmail: probe.email,
        emailVerified: true,
      })
      .run();
    await new DrizzleSessionRepository(db).create({
      id: "ses_timing_probe",
      userId: probe.id,
      tokenHash: await new Sha256TokenHasher().hash("timing-probe-token"),
      expiresAt: new Date(Date.now() - 60 * 1000),
      authMethod: "email_otp",
      userAgent: null,
      ipHash: null,
    });

    const ctx = createExecutionContext();
    const waitUntil = vi.spyOn(ctx, "waitUntil");

    const response = await createApp().fetch(
      new Request("http://localhost/api/me", {
        headers: { Cookie: `${sessionCookieName("development")}=timing-probe-token` },
      }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(401);
    expect(waitUntil, "入口が waitUntil を渡していない").toHaveBeenCalled();

    // 逃がした先はちゃんと書かれている。応答を待たせないことと、
    // 記録を捨てることは別。
    const rows = await db.select().from(auditLogs).all();
    expect(rows.map((row) => row.event)).toContain("session.rejected");
  });
});

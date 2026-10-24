import { auditLogs, createIdentityDatabase, users } from "@u18/db";
import { aUser } from "@u18/testing";
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { Sha256TokenHasher } from "../src/infrastructure/crypto/web-crypto";
import { DrizzleSessionRepository } from "../src/infrastructure/persistence/drizzle-session.repository";
import { IdentityRPC } from "../src/presentation/rpc/identity.entrypoint";
import { resetDatabase } from "./helpers";

/**
 * RPC 越しの操作が `audit_logs.actor` に残ること（#22）。
 *
 * ## なぜ要るのか
 *
 * `IdentityRpcContract` の消費者は **dashboard-worker と nfc-worker の 2 つ**。
 * 監査ログを見ても**どちらから来た操作か分からない**状態だと、侵害調査で
 * 「どの Worker が侵害されたか」を切り分けられない。
 *
 * ## これは認証ではない
 *
 * `caller` は自己申告で、Service Binding は呼び出し元の身元を運ばない。
 * 侵害された Worker は別の Worker を名乗れる。**帰属にだけ使う**ので、
 * ここで確かめるのも「名乗りがそのまま記録されること」であって
 * 「名乗りが正しいこと」ではない。
 */
describe("IdentityRPC が actor を記録する", () => {
  const user = aUser({ email: "rpc-actor@example.com" });
  const TOKEN = `rpc-actor-probe-token-${"x".repeat(20)}`;

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

    // 期限切れのセッション。提示すると session.rejected が 1 件書かれる。
    await new DrizzleSessionRepository(db).create({
      id: "ses_rpc_actor",
      userId: user.id,
      tokenHash: await new Sha256TokenHasher().hash(TOKEN),
      expiresAt: new Date(Date.now() - 60 * 1000),
      authMethod: "email_otp",
      userAgent: null,
      ipHash: null,
    });
  });

  async function callGetSession(caller?: "dashboard-worker" | "nfc-worker"): Promise<string[]> {
    const ctx = createExecutionContext();
    const rpc = new IdentityRPC(ctx, env);
    await rpc.getSession(
      caller === undefined ? { sessionToken: TOKEN } : { sessionToken: TOKEN, caller },
    );
    // 副作用は waitUntil へ逃がしてあるので、完了を待ってから読む（#143）。
    await waitOnExecutionContext(ctx);

    const rows = await createIdentityDatabase(env.IDENTITY_DB).select().from(auditLogs).all();
    return rows.filter((r) => r.event === "session.rejected").map((r) => r.actor ?? "<null>");
  }

  it.each([["dashboard-worker"], ["nfc-worker"]] as const)(
    "%s からの呼び出しがそのまま actor になる",
    async (caller) => {
      expect(await callGetSession(caller)).toEqual([caller]);
    },
  );

  it("名乗らない呼び出しは unknown として残る", async () => {
    // 契約上 optional なので、デプロイ順の都合で古い呼び出し元が
    // 残っていても壊れない。ただし黙って空にはしない —— 空だと
    // 「RPC 経由ではない」と区別できなくなる。
    expect(await callGetSession()).toEqual(["unknown"]);
  });

  it("公開 HTTP 経由の操作には actor を付けない", async () => {
    // actor は「利用者本人以外が動かした」ことを示す列。公開 HTTP では
    // 主体は user_id で表されるので、ここに値が入ると意味が濁る。
    const { createApp } = await import("../src/presentation/http/app");
    const ctx = createExecutionContext();
    await createApp().fetch(
      new Request("http://localhost/api/me", { headers: { Cookie: `u18_session=${TOKEN}` } }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    const rows = await createIdentityDatabase(env.IDENTITY_DB).select().from(auditLogs).all();
    const rejected = rows.filter((r) => r.event === "session.rejected");
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.actor).toBeNull();
  });
});

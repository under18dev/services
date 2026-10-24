import { env } from "cloudflare:test";
import { auditLogs, createIdentityDatabase, type IdentityDatabase } from "@u18/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DrizzleAuditLogger } from "../src/infrastructure/persistence/drizzle-audit-logger";
import { resetDatabase } from "./helpers";

/**
 * 監査ログの Port 実装（#12）。
 *
 * ここで確かめたいことは 2 つある。
 *
 * 1. `metadata` の JSON が往復すること。Drizzle の `mode: "json"` 越しに
 *    入れた値がそのままの型で戻らないと、監査ログを読む側が壊れる。
 * 2. **書き込みに失敗しても例外を投げないこと。** これは
 *    `AuditLogger.record()` の契約そのもので（docs/architecture.md §4.1）、
 *    ログが書けないことを理由にログインを拒否すると、可観測性の問題が
 *    そのまま認証停止になる。2 は実 DB では起こしにくいので、
 *    失敗する DB を差し込んで確かめる。
 */
describe("DrizzleAuditLogger", () => {
  let db: IdentityDatabase;

  beforeEach(async () => {
    await resetDatabase();
    db = createIdentityDatabase(env.IDENTITY_DB);
  });

  it("metadata の JSON が往復する", async () => {
    const metadata = {
      authMethod: "email_otp",
      sessionId: "ses_abc",
      attempts: 3,
      nested: { ok: true, list: [1, 2, 3] },
    };

    await new DrizzleAuditLogger(db).record({
      event: "session.issue",
      userId: "usr_1",
      outcome: "success",
      metadata,
    });

    const rows = await db.select().from(auditLogs).all();
    expect(rows).toHaveLength(1);
    // 文字列化されたまま返ってくると、読む側が毎回 JSON.parse する羽目になる。
    expect(rows[0]?.metadata).toEqual(metadata);
  });

  it("省略した項目は null として入る", async () => {
    await new DrizzleAuditLogger(db).record({ event: "otp.start", outcome: "failure" });

    const row = (await db.select().from(auditLogs).all())[0];
    expect(row?.userId).toBeNull();
    expect(row?.actor).toBeNull();
    expect(row?.reason).toBeNull();
    expect(row?.metadata).toBeNull();
    expect(row?.ipHash).toBeNull();
    expect(row?.userAgent).toBeNull();
  });

  it("書き込みに失敗しても例外を投げない", async () => {
    // 認証処理はこの戻り値を待つ。ここで throw されると、監査ログが
    // 書けないだけでログイン全体が 500 になる。
    const failing = {
      insert: () => {
        throw new Error("D1_ERROR: no such table: audit_logs");
      },
    } as unknown as IdentityDatabase;
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      new DrizzleAuditLogger(failing).record({ event: "session.issue", outcome: "success" }),
    ).resolves.toBeUndefined();

    // 握り潰すのではなく、Workers のログには残す。
    expect(errors).toHaveBeenCalledWith("audit log write failed", expect.anything());
    errors.mockRestore();
  });

  it("失敗したログに秘密を載せない", async () => {
    // console.error へ渡すのはイベント名と例外だけ。metadata をそのまま
    // 流すと、ログに出したくない値が失敗時だけ出てしまう。
    const failing = {
      insert: () => {
        throw new Error("boom");
      },
    } as unknown as IdentityDatabase;
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    await new DrizzleAuditLogger(failing).record({
      event: "otp.verify",
      outcome: "failure",
      metadata: { shouldNotLeak: "sensitive-value" },
    });

    const serialized = JSON.stringify(errors.mock.calls);
    expect(serialized).not.toContain("sensitive-value");
    errors.mockRestore();
  });
});

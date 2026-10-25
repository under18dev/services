import { env } from "cloudflare:test";
import { auditLogs, createIdentityDatabase, type IdentityDatabase } from "@u18/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AUDIT_WRITE_FAILED,
  DrizzleAuditLogger,
} from "../src/infrastructure/persistence/drizzle-audit-logger";
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
    expect(errors).toHaveBeenCalledTimes(1);
    errors.mockRestore();
  });

  it("失敗ログは 1 行の JSON で、アラートが引ける形になっている", async () => {
    // **この形がアラートの照合キーそのもの**（docs/runbook.md 3.3.4）。
    // 可読文字列の部分一致に頼ると、文言を少し直しただけで鳴らなくなり、
    // しかも「鳴らない」ことは鳴るべき事象が起きるまで誰も気づけない。
    const failing = {
      insert: () => {
        throw new TypeError("D1_ERROR: no such table: audit_logs");
      },
    } as unknown as IdentityDatabase;
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    await new DrizzleAuditLogger(failing).record({ event: "otp.verify", outcome: "failure" });

    expect(errors).toHaveBeenCalledTimes(1);
    const [line] = errors.mock.calls[0] as [string];
    // 引数 1 つの文字列であること。2 引数だと JSON として読めない。
    expect(typeof line).toBe("string");
    expect(JSON.parse(line)).toEqual({
      event: AUDIT_WRITE_FAILED,
      auditEvent: "otp.verify",
      reason: "TypeError",
    });
  });

  it("照合キーの値そのものを固定する", () => {
    // 変えるとアラートの条件が無言で外れる。変えたいなら Cloudflare 側の
    // 設定も同時に直すこと（runbook 3.3.4 / 12.6 のチェックリスト）。
    expect(AUDIT_WRITE_FAILED).toBe("audit_log.write_failed");
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
    // 例外のメッセージも載せない。D1 の例外は失敗したクエリを含むことがあり、
    // そこに値が乗りうる（`reason` は例外の種類だけ）。
    expect(serialized).not.toContain("boom");
    errors.mockRestore();
  });
});

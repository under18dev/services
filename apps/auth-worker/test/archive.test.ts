import { env } from "cloudflare:test";
import { FixedClock } from "@u18/testing";
import { beforeEach, describe, expect, it } from "vitest";
import {
  R2ArchiveSink,
  UnconfiguredArchiveSink,
} from "../src/infrastructure/archive/r2-archive-sink";

/**
 * 監査ログの退避先（#43 の残件）。
 *
 * **本物の R2 バインディング（miniflare のローカル実装）に対して走らせる。**
 * フェイクを相手にすると「書いたつもり」を検出できない —— この Port の
 * 存在理由がまさに「書けたことを確認してから消す」なので、書き込みの
 * 往復を確かめないとテストの意味が無い。
 */

const NOW = new Date("2026-10-24T12:34:56.789Z");

async function emptyBucket(): Promise<void> {
  const listed = await env.ARCHIVE.list();
  await Promise.all(listed.objects.map((object) => env.ARCHIVE.delete(object.key)));
}

describe("R2ArchiveSink", () => {
  let sink: R2ArchiveSink;

  beforeEach(async () => {
    await emptyBucket();
    sink = new R2ArchiveSink(env.ARCHIVE, new FixedClock(NOW));
  });

  const rows = [
    { id: "aud_1", event: "session.issue", ipHash: "abc", metadata: { authMethod: "passkey" } },
    { id: "aud_2", event: "otp.verify", ipHash: null, metadata: null },
  ];

  it("NDJSON で書き、そのまま読み戻せる", async () => {
    const receipt = await sink.put({ target: "audit_logs", rows });

    const stored = await env.ARCHIVE.get(receipt.key);
    expect(stored, "キーが返ってきたのにオブジェクトが無い").not.toBeNull();

    const text = await stored!.text();
    // 1 行 1 レコード。末尾の改行まで入れておくと、複数ファイルを
    // 連結しても行が溶けない。
    expect(text.endsWith("\n")).toBe(true);
    const parsed = text
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as unknown);
    expect(parsed).toEqual(rows);
  });

  it("キーは target と日付で切る", async () => {
    const receipt = await sink.put({ target: "audit_logs", rows });

    // 復元のとき「いつの分が要るか」でプレフィックス一覧できること。
    expect(receipt.key).toMatch(/^audit_logs\/2026\/10\/24\/.+\.ndjson$/);
    // `:` と `.` はファイルに落とすときに困るので落としてある。
    expect(receipt.key.split("/").pop()).not.toContain(":");
  });

  it("同じ時刻に 2 回書いても上書きしない", async () => {
    // キーが衝突すると R2 は黙って上書きする。持ち越しがあると同じ実行の
    // 中で複数回書くので、ミリ秒まで同じになりうる。
    const first = await sink.put({ target: "audit_logs", rows });
    const second = await sink.put({ target: "audit_logs", rows });

    expect(first.key).not.toBe(second.key);
    expect((await env.ARCHIVE.list()).objects).toHaveLength(2);
  });

  it("中身を開かずに棚卸しできる", async () => {
    const receipt = await sink.put({ target: "audit_logs", rows });

    const head = await env.ARCHIVE.head(receipt.key);
    expect(head?.customMetadata).toEqual({
      target: "audit_logs",
      rowCount: "2",
      archivedAt: NOW.toISOString(),
    });
    expect(head?.httpMetadata?.contentType).toBe("application/x-ndjson");
  });

  it("書き込みが欠けていたら失敗させる", async () => {
    // put が例外を投げなかったことは「書けた」と同義ではない。
    // 呼び出し側はこの戻り値を根拠に行を削除するので、サイズまで照合する。
    const truncating = {
      put: async (key: string) => ({ key, size: 1 }),
    } as unknown as R2Bucket;

    await expect(
      new R2ArchiveSink(truncating, new FixedClock(NOW)).put({ target: "audit_logs", rows }),
    ).rejects.toThrow(/incomplete/);
  });

  it("put が null を返したら失敗させる", async () => {
    const silent = { put: async () => null } as unknown as R2Bucket;

    await expect(
      new R2ArchiveSink(silent, new FixedClock(NOW)).put({ target: "audit_logs", rows }),
    ).rejects.toThrow(/put returned null/);
  });

  it("受領証の件数とバイト数が実体と一致する", async () => {
    const receipt = await sink.put({ target: "audit_logs", rows });

    const head = await env.ARCHIVE.head(receipt.key);
    expect(receipt.rowCount).toBe(rows.length);
    expect(receipt.bytes).toBe(head?.size);
  });
});

describe("UnconfiguredArchiveSink", () => {
  it("退避しようとした時点で失敗する", async () => {
    // 組み立てでは投げない（#53）。/health や認証は巻き添えにしない。
    const sink = new UnconfiguredArchiveSink("ARCHIVE bucket binding is missing");

    await expect(sink.put({ target: "audit_logs", rows: [] })).rejects.toThrow(/not configured/);
  });
});

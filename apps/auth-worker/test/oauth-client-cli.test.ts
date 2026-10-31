import { describe, expect, it } from "vitest";
import {
  checkRotationEligibility,
  generateClientSecret,
  hashClientSecret,
} from "../scripts/lib/client-secret";
import { Sha256TokenHasher } from "../src/infrastructure/crypto/web-crypto";

/**
 * `scripts/oauth-client.mjs` の `rotate` / `generate-secret`（#445）。
 *
 * CLI 本体は `node:child_process` を import するので workerd から読めない
 * （`admin-role-cli.test.ts` と同じ理由）。純粋な部分だけを
 * `scripts/lib/client-secret.ts` に出し、ここから直接呼ぶ。
 *
 * **`writeSecretFile` はここでは検査しない。** テスト本体は workerd の中で
 * 動くので `node:fs` の実ファイル操作が使えない（`vitest.config.ts` の
 * コメント参照）。手元で `node --input-type=module -e '...'` を使って
 * 改行の有無とパーミッション 600 を実測で確認した（PR 本文に記録）。
 */
describe("ハッシュ方式が Worker 側と一致する", () => {
  it("CLI が計算するハッシュと、verifySecret が使う Sha256TokenHasher が同じ値になる", async () => {
    // **ここが今夜の本体。** D1 のハッシュは正しく UPDATE されるのに
    // 検証だけ通らない、という不一致は「2 つの独立した実装が同じ入力から
    // 違う値を作る」形でしか起きない。2 つの実装を実際に突き合わせる。
    const hasher = new Sha256TokenHasher();
    const secret = "sample-client-secret-value";

    const fromCli = hashClientSecret(secret);
    const fromWorker = await hasher.hash(secret);

    expect(fromCli).toBe(fromWorker);
  });

  it("generateClientSecret が返す hash は、同じ secret から独立に計算した値と一致する", () => {
    const { secret, hash } = generateClientSecret();
    expect(hash).toBe(hashClientSecret(secret));
  });

  it("秘密はランダムで、2 回の呼び出しで一致しない", () => {
    const a = generateClientSecret();
    const b = generateClientSecret();
    expect(a.secret).not.toBe(b.secret);
  });
});

describe("checkRotationEligibility", () => {
  it("存在しない client_id を拒否する", () => {
    const result = checkRotationEligibility("missing", undefined);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("存在しない");
  });

  it("public クライアントを拒否する", () => {
    const result = checkRotationEligibility("u18-e2e-local", {
      client_type: "public",
      disabled_at: null,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("public");
  });

  it("失効済みクライアントを拒否する", () => {
    const result = checkRotationEligibility("u18-admin", {
      client_type: "confidential",
      disabled_at: 1_700_000_000_000,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("失効済み");
  });

  it("confidential かつ有効なら通す", () => {
    const result = checkRotationEligibility("u18-admin", {
      client_type: "confidential",
      disabled_at: null,
    });
    expect(result.ok).toBe(true);
  });
});

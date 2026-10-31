/**
 * OAuth クライアントの `client_secret` の生成・ハッシュ化・対象確認（#445）。
 *
 * ## なぜ切り出したか
 *
 * `oauth-client.mjs` は `node:child_process` を import するので、
 * Workers のテスト環境（workerd）からは読めない（`lib/wrangler-failure.ts`
 * と同じ理由）。ここは何も import しない純粋な関数だけにしてあり、
 * `test/oauth-client-cli.test.ts` が直接呼ぶ。
 *
 * ## ハッシュ方式を Worker 側と独立に固定する
 *
 * **ここでハッシュ方式がずれると、D1 は正しく更新されるのに
 * `verifySecret`（`infrastructure/persistence/drizzle-oauth-client.repository.ts`）
 * は常に false を返す。** CLI はログを見ず、D1 の UPDATE が成功したことしか
 * 確認できないので、**ずれに気づく手段が「実際にログインしてみる」しかない。**
 * 2026-10-31 の夜、まさにこの種の不一致を 1 時間かけて追った。
 *
 * `Sha256TokenHasher`（`src/infrastructure/crypto/web-crypto.ts`）は
 * pepper なしの SHA-256（Web Crypto 経由）。ここは `node:crypto` 経由で
 * 同じ計算をする——実装は別だが、`test/oauth-client-cli.test.ts` が
 * **2 つの独立した実装が同じ入力から同じ値を作ること**を固定している。
 */
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, writeFileSync } from "node:fs";

export function hashClientSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

export type GeneratedClientSecret = {
  readonly secret: string;
  readonly hash: string;
};

/**
 * `client_secret` を 1 度だけ表示する。
 *
 * DB に入れるのはハッシュだけ（仕様書 7.1）。平文はここでしか作られないので、
 * 取り損ねたら再発行するしかない。これは不便ではなく仕様で、
 * 「後から誰でも読み出せる平文」を作らないための形。
 */
export function generateClientSecret(): GeneratedClientSecret {
  const secret = randomBytes(32).toString("base64url");
  return { secret, hash: hashClientSecret(secret) };
}

/**
 * 新しい秘密をファイルへ書く。**改行を付けない。**
 *
 * `wrangler secret put <NAME> < file` で読ませたとき、末尾の改行まで
 * 秘密の一部として送ってしまうと、`rotate` が計算するハッシュ
 * （ファイルの中身をそのままハッシュ化する）と Worker が実際に送る値が
 * ずれる。ここで改行を付けなければ、同じファイルを 2 箇所が読んでも
 * 中身は常に同じバイト列になる。
 *
 * パーミッションは `writeFileSync` の `mode` だけでなく `chmodSync` でも
 * 明示する。前者は `umask` の影響を受けるため、意図どおり 600 になるとは
 * 限らない。
 */
export function writeSecretFile(path: string, secret: string): void {
  writeFileSync(path, secret, { mode: 0o600 });
  chmodSync(path, 0o600);
}

export type OAuthClientRow = {
  readonly client_type: string;
  readonly disabled_at: number | null;
};

export type RotationEligibility =
  { readonly ok: true } | { readonly ok: false; readonly reason: string };

/**
 * `rotate` が対象へ手を付けてよいかを判定する。
 *
 * **UPDATE の WHERE 句（`client_type = 'confidential' and disabled_at is null`）
 * と同じ条件を、先に人に伝わる形で判定する。** WHERE 句だけに任せると、
 * client_id の打ち間違いや public クライアントの指定が「0 行更新」という
 * 地味な結果にしかならず、見落とされる——`oauth-client.mjs` の `rotate` の
 * UPDATE 文と条件を揃えること。
 */
export function checkRotationEligibility(
  clientId: string,
  row: OAuthClientRow | undefined,
): RotationEligibility {
  if (row === undefined) {
    return { ok: false, reason: `client_id=${clientId} は存在しない` };
  }
  if (row.client_type !== "confidential") {
    return {
      ok: false,
      reason: `client_id=${clientId} は ${row.client_type}。secret を持たないクライアントは回せない`,
    };
  }
  if (row.disabled_at !== null) {
    return { ok: false, reason: `client_id=${clientId} は失効済み。回す前に意図を確認すること` };
  }
  return { ok: true };
}

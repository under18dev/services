#!/usr/bin/env node
/**
 * ID Token 署名鍵（ES256）の生成（#14 / 仕様書 5.4・7.1）。
 *
 * 独自の鍵生成コードは書かない。Node の `node:crypto` に P-256 鍵ペアを作らせ、
 * JWK として書き出すだけ（docs/runbook.md 2.4.1 と同じ手順を、
 * 取り違えが起きにくい形にまとめたもの）。
 *
 *   node scripts/signing-key.mjs generate              # 出力を見るだけ
 *   node scripts/signing-key.mjs generate --apply-local # ローカル D1 に公開鍵の行も入れる
 *
 * 出力は 3 つに分かれる。**この 3 つの行き先を取り違えないこと。**
 *
 * | 出力              | 行き先                               | 機密 |
 * | ----------------- | ------------------------------------ | ---- |
 * | `SIGNING_KEY_KID` | Workers Secret / .dev.vars           | No   |
 * | `SIGNING_KEY_JWK` | Workers Secret / .dev.vars（`d` 入り）| Yes  |
 * | `public_jwk`      | `signing_key_metadata` テーブル       | No   |
 *
 * `public_jwk` 列に `d` を含む方を入れると、**JWKS 経由で秘密鍵を世界へ配る**ことになる。
 * 実装は `d` を落とす作りにしてあるが（`src/infrastructure/crypto/jose-signing-key.ts`）、
 * 入れないに越したことはない。
 *
 * **本番の鍵をこのスクリプトから DB へ入れない。** `--apply-local` しか用意しないのは、
 * 本番の鍵投入が「先に JWKS へ公開してから署名を切り替える」という時間差のある
 * 手順だからで（docs/runbook.md 4.2）、1 コマンドで済ませてよい操作ではない。
 */

import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const WORKER_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const DATABASE_NAME = "u18-identity";

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    switch (argv[i]) {
      case "--kid":
        options.kid = argv[i + 1];
        i += 1;
        break;
      case "--apply-local":
        options.applyLocal = true;
        break;
      default:
        throw new Error(`未知のオプション: ${argv[i]}`);
    }
  }
  return options;
}

function generate(options) {
  // kid は日付入りにして、ローテーション時に既存の kid と衝突しないようにする。
  const kid = options.kid ?? `u18-${new Date().toISOString().slice(0, 10)}-1`;
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const meta = { alg: "ES256", use: "sig", kid };

  const privateJwk = { ...privateKey.export({ format: "jwk" }), ...meta };
  const publicJwk = { ...publicKey.export({ format: "jwk" }), ...meta };

  console.log("# .dev.vars に貼る（本番は wrangler secret put で入れる）");
  console.log(`SIGNING_KEY_KID=${kid}`);
  console.log(`SIGNING_KEY_JWK=${JSON.stringify(privateJwk)}`);
  console.log("");

  // `active_from` を過去にしておく。未来にすると「JWKS には出るが署名に使えない」
  // 先行公開の状態になり、ローカルで ID Token を発行できない（runbook 4.2 ステップ 2）。
  const sql = `insert into signing_key_metadata
     (kid, algorithm, public_jwk, active_from, active_until, retires_at, created_at)
   values ('${kid}', 'ES256', '${JSON.stringify(publicJwk).replaceAll("'", "''")}',
     unixepoch() * 1000, null, null, unixepoch() * 1000);`;

  console.log("# signing_key_metadata に入れる公開鍵（機密ではない）");
  console.log(sql);

  if (options.applyLocal === true) {
    const result = spawnSync(
      "npx",
      ["wrangler", "d1", "execute", DATABASE_NAME, "--local", "--command", sql],
      { cwd: WORKER_DIR, stdio: "inherit" },
    );
    if (result.status !== 0) {
      throw new Error(`wrangler d1 execute が失敗した (exit ${result.status})`);
    }
    console.log("");
    console.log(`ローカル D1 に ${kid} の公開鍵を入れた。`);
  }

  console.log("");
  console.log("この出力は端末のスクロールバッファとシェル履歴に残る。");
  console.log("設定が終わったら画面を消すこと（docs/runbook.md 2.4.1）。");
}

try {
  const [command, ...rest] = process.argv.slice(2);
  if (command !== "generate") {
    console.error("使い方: node scripts/signing-key.mjs generate [--kid <kid>] [--apply-local]");
    process.exitCode = 1;
  } else {
    generate(parseArgs(rest));
  }
} catch (error) {
  console.error(`エラー: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
}

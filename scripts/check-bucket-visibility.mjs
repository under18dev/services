#!/usr/bin/env node
/**
 * 退避先バケットが公開されていないことを確かめる（runbook §12.7 の残件）。
 *
 * ```
 * CLOUDFLARE_ACCOUNT_ID=… node scripts/check-bucket-visibility.mjs [bucket]
 * ```
 *
 * 3 経路（`r2.dev` の公開 URL / カスタムドメイン / CORS）を見て、**すべて
 * 閉じているときだけ 0 で終わる。** 1 つでも開いていれば、あるいは
 * **確かめられなければ**、非ゼロで終わる。
 *
 * ## なぜ要るか
 *
 * `u18-identity-archive` には `ip_hash` と `user_agent` を含む監査ログと、
 * 平文のメールアドレスを含む D1 のダンプが入っている。2026-10-24 に 3 経路を
 * 手で確認した（runbook §12.7）が、**公開はダッシュボードからの操作で起こり、
 * リポジトリ側に痕跡が残らない。** コードも設定ファイルも変わらないまま
 * バケットだけが公開になるので、`git log` を追っても分からない。
 *
 * **手で打つ手順書は、打たれなくなった日から何も守らない。** 脅威モデル
 * §4.4 に並べた #88 / #96 / #122 と同じ形である。
 *
 * ## まだ CI に繋いでいない
 *
 * 繋ぐには CI へ R2 の読み取り権限を渡すことになる。`deploy.yml` の
 * 認証情報の範囲を広げる判断で、**同じジョブ内の任意のステップがその
 * 認証情報を読める**（`.github/workflows/README.md`）。検査のために
 * 攻撃面を広げるかどうかは、ここで勝手に決めない。
 *
 * **秘密が無いときに静かに skip する作りにはしない。** それは「宣言は
 * あるが発動しない」をもう 1 つ増やすだけである。繋ぐと決めたら、
 * 秘密が無ければ落ちる形で繋ぐこと。
 */
import { spawnSync } from "node:child_process";

import {
  ROUTE_LABELS,
  classifyCors,
  classifyCustomDomains,
  classifyDevUrl,
  summarize,
} from "./lib/bucket-visibility.mjs";

const DEFAULT_BUCKET = "u18-identity-archive";

/**
 * `wrangler` を 1 回起動して stdout / stderr / 終了コードを集める。
 *
 * **`stdio: "inherit"` にしない。** 判定に出力が要る。終了コードは
 * 判定に使わないが、人が読むときの手がかりとして拾っておく。
 */
function run(args) {
  const result = spawnSync("npx", ["wrangler", ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) {
    // npx 自体が起動できなかった場合。stderr に寄せて unknown に落とす。
    return { stdout: "", stderr: String(result.error.message), status: null };
  }
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", status: result.status };
}

function main(argv) {
  const bucket = argv[0] ?? DEFAULT_BUCKET;

  if (!process.env.CLOUDFLARE_ACCOUNT_ID) {
    // 落とさない。アカウントが 1 つしか見えない環境では指定が要らない。
    // ただし複数見える環境では 3 つとも実行前に落ち、**「権限が無い」と
    // 読み違えやすい**（runbook §12.7）ので、先に断っておく。
    console.warn(
      "CLOUDFLARE_ACCOUNT_ID が無い。アカウントが複数見える環境では" +
        "「非対話モードで選べない」で 3 つとも落ちる（権限の問題ではない）。\n",
    );
  }

  const results = [
    classifyDevUrl(run(["r2", "bucket", "dev-url", "get", bucket])),
    classifyCustomDomains(run(["r2", "bucket", "domain", "list", bucket])),
    classifyCors(run(["r2", "bucket", "cors", "list", bucket])),
  ];

  const summary = summarize(results);
  const mark = { closed: "閉", open: "開", unknown: "？" };

  console.log(`バケット: ${bucket}\n`);
  for (const result of results) {
    console.log(`  [${mark[result.verdict]}] ${ROUTE_LABELS[result.route]} — ${result.detail}`);
  }
  console.log();

  if (summary.ok) {
    console.log("3 経路とも閉じている。");
    return 0;
  }
  if (summary.open.length > 0) {
    console.error(
      "**公開されている経路がある。** 退避先には監査ログと平文のメールアドレスが入る。",
    );
  }
  if (summary.unknown.length > 0) {
    console.error(
      "確かめられなかった経路がある。**これは「公開していない」ではない。** " +
        "認証、バケット名、アカウントの指定を見ること。",
    );
  }
  return 1;
}

process.exitCode = main(process.argv.slice(2));

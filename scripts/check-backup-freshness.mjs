#!/usr/bin/env node
/**
 * 日次バックアップが止まっていないかを、**バックアップとは別の経路**で見る
 * （#361）。
 *
 * ## なぜ `backup.yml` の中に置かないのか
 *
 * **同じ `schedule:` の中に置いた見張りは、自分が走っていないことを
 * 観測できない。** `backup.yml` が止まれば、その中の見張りも一緒に
 * 止まる —— **止まった場合にだけ沈黙する検査**になる（#368 / README の
 * 「緑の見分け方」）。だから**別のワークフロー・別の `schedule:`**にする
 * （`backup-monitor.yml`）。2 つが同時に止まる確率は、1 つが止まる確率
 * より低い。
 *
 * ## 何を見るか —— R2 を外から読む
 *
 * `wrangler` には R2 オブジェクトの一覧コマンドが無い
 * （`backup-d1.mjs` の `list` の節）。`list` は S3 互換 API を使うが、
 * `.env` のローカル認証情報が要るので CI には繋がっていない。
 *
 * **代わりに Cloudflare 自身の R2 API を直接叩く。** `wrangler deploy` や
 * D1 のマイグレーションで既に使っている `CLOUDFLARE_API_TOKEN` /
 * `CLOUDFLARE_ACCOUNT_ID` と同じものでよい —— 新しい秘密を増やさずに済む
 * （runbook 12.5 の「保管場所を増やさない」に沿う）。
 *
 *   GET /accounts/{account_id}/r2/buckets/{bucket}/objects?prefix=...
 *
 * ## DB ごとに見る。バケット全体の「何かあるか」では足りない
 *
 * `backup-d1.mjs` の `DATABASES` を読み、**それぞれの DB について
 * 一番新しいオブジェクトの `last_modified`** を見る。バケット全体の
 * 最新オブジェクトだけを見ると、**3 つのうち 1 つだけが止まっても
 * 気づけない**（他の 2 つが毎日更新されていれば、バケット全体としては
 * 新しいオブジェクトが常にある）。
 *
 * ## 閾値
 *
 * バックアップは 21:00 UTC（06:00 JST）、この見張りは 03:00 UTC
 * （12:00 JST、6 時間後）に走る。**正常なら、見る時点での最新バックアップは
 * 常に約 6 時間前。** RPO は 24 時間なので、`6h + 24h` を超えたら
 * 止まっている —— 閾値を **27 時間**にして、スケジュール遅延の余白を
 * 持たせてある（README の「GitHub の `schedule:` は遅れる」）。
 *
 * ## 0 件ガード
 *
 * `d1-backups/` 配下に 1 件もオブジェクトが無ければ別の理由で落とす。
 * 「どの DB も古い」と「そもそも何も無い」を区別できないと、鍵の
 * 置き場所が変わった（prefix を直し忘れた）ときにも「止まっている」と
 * 誤読する。
 */
import { DATABASES } from "./backup-d1.mjs";

const BUCKET = "u18-identity-archive";
const PREFIX = "d1-backups/";
const STALE_AFTER_HOURS = 27;

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`環境変数 ${name} が無い`);
  return value;
}

/** ページングしながら `prefix` 配下のオブジェクトを全部集める。 */
async function listAllObjects({ accountId, token, prefix }) {
  const objects = [];
  let cursor;

  for (;;) {
    const url = new URL(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/buckets/${BUCKET}/objects`,
    );
    url.searchParams.set("prefix", prefix);
    url.searchParams.set("per_page", "1000");
    if (cursor !== undefined) url.searchParams.set("cursor", cursor);

    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const body = await response.json();

    if (!response.ok || body.success !== true) {
      const detail = (body.errors ?? []).map((e) => `${e.code}: ${e.message}`).join(", ");
      throw new Error(
        `R2 の一覧取得に失敗した（HTTP ${response.status}）。${detail || "詳細は無い"}` +
          "。トークンに R2 の読み取り権限があるか確かめること（runbook 12.5）。",
      );
    }

    objects.push(...body.result);
    if (body.result_info?.is_truncated !== true) break;
    cursor = body.result_info.cursor;
    if (cursor === undefined) break; // 壊れた応答で無限ループしない。
  }

  return objects;
}

async function main() {
  const accountId = requireEnv("CLOUDFLARE_ACCOUNT_ID");
  const token = requireEnv("CLOUDFLARE_API_TOKEN");

  const objects = await listAllObjects({ accountId, token, prefix: PREFIX });

  if (objects.length === 0) {
    console.error(
      `::error::check-backup-freshness: r2://${BUCKET}/${PREFIX} に 1 件もオブジェクトが無い。` +
        " バックアップが一度も成功していないか、鍵の置き場所（PREFIX）が変わっている。" +
        " この検査自体の PREFIX と backup-d1.mjs の backupKey() を突き合わせること。",
    );
    process.exitCode = 1;
    return;
  }

  const now = Date.now();
  const staleMs = STALE_AFTER_HOURS * 60 * 60 * 1000;
  /** @type {string[]} */
  const problems = [];

  for (const database of Object.values(DATABASES)) {
    // ファイル名は `<name>-<ISO>.sql` か `<name>-<ISO>.sql.age`（運用では
    // 必ず暗号化されるが、平文のテスト実行も受け入れておく）。
    const prefix = `${database.name}-`;
    const matches = objects.filter((o) => {
      const basename = o.key.split("/").pop() ?? "";
      return basename.startsWith(prefix);
    });

    if (matches.length === 0) {
      problems.push(`[${database.name}] r2://${BUCKET}/${PREFIX} にこの DB のオブジェクトが無い`);
      continue;
    }

    const latest = matches.reduce((a, b) =>
      new Date(a.last_modified) > new Date(b.last_modified) ? a : b,
    );
    const ageMs = now - new Date(latest.last_modified).getTime();
    const ageHours = ageMs / (60 * 60 * 1000);

    if (ageMs > staleMs) {
      problems.push(
        `[${database.name}] 最新のバックアップが ${ageHours.toFixed(1)} 時間前` +
          `（${latest.key}）。${STALE_AFTER_HOURS} 時間を超えている —— 日次バックアップが止まっている。`,
      );
    } else {
      console.log(`[${database.name}] 最新: ${ageHours.toFixed(1)} 時間前（${latest.key}）`);
    }
  }

  if (problems.length > 0) {
    for (const problem of problems) console.error(`::error::check-backup-freshness: ${problem}`);
    console.error(
      "\n対応は runbook 12.11。`D1 token probe` と `Backup` を手で走らせて切り分けること。" +
        " `schedule:` 自体が止まっている可能性もある（.github/workflows/backup.yml を開き、" +
        " 最後に動いた日付を Actions タブで確認すること）。",
    );
    process.exitCode = 1;
    return;
  }

  console.log(
    `\ncheck-backup-freshness: ${Object.keys(DATABASES).length} 個の DB、全部 ${STALE_AFTER_HOURS} 時間以内。`,
  );
}

main().catch((error) => {
  console.error(`::error::check-backup-freshness: ${error.message}`);
  process.exitCode = 1;
});

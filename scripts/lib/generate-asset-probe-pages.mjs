// @ts-check

import { commonAssetPrefix } from "./asset-probe-pages.mjs";

/**
 * `scripts/smoke-asset-probe.sh` の `probe_pages_for()` を、
 * `route-inventory.ts` から生成する（#453）。
 *
 * ## なぜ要るのか
 *
 * 以前は `page:prefix` の組を `smoke-asset-probe.sh` に手で書いていた。
 * `page`（`PROBE_PAGES`）も `prefix`（`ASSET_ROUTES` の共通ディレクトリ、
 * `commonAssetPrefix` を参照）も、どちらも `route-inventory.ts` が既に
 * 持っている値なので、**手で合わせる field がそもそも無い。** Worker が
 * 増えるたびに同じ手作業が再現する、という issue 本体の指摘（#453）に
 * 対して、ここが「3 箇所」のうち 1 箇所を無くす部分にあたる。
 *
 * ## Worker の一覧は呼び出し側（`collect()`）に作らせる
 *
 * **ここでは対象 Worker をハードコードしない。** `apps/*` をファイル
 * システムから列挙するのは `scripts/lib/asset-probe-pages.mjs` の
 * `collect()` の仕事——ここで別の固定配列を持つと、5 つ目の Worker は
 * やはり手で足すことになり、issue 本体を素通りする。
 *
 * ## 空のまま緑にしない
 *
 * `ASSET_ROUTES` があるのに `PROBE_PAGES` が無い・空・prefix が 1 つに
 * 畳めない場合は、**空の case 枝を書かずに失敗として返す。** ダウンストリーム
 * の突き合わせ（`check-asset-probe-pages.mjs`）に気づかせるのではなく、
 * 生成の時点で空を作らせない。
 */

/**
 * @param {readonly {
 *   readonly name: string;
 *   readonly assets: readonly string[];
 *   readonly probePages: readonly string[] | null;
 *   readonly hasInventory: boolean;
 * }[]} workers
 * @param {Readonly<Record<string, string>>} unprobeable
 */
export function buildProbePagesScript(workers, unprobeable) {
  const errors = [];
  const notes = [];
  const arms = [];

  const sorted = [...workers].sort((a, b) => a.name.localeCompare(b.name));

  for (const worker of sorted) {
    if (!worker.hasInventory) {
      // **画面を持たない Worker は無視してよいが、黙ってはいけない。**
      // 「対象に入っていない」ことが出力から読めるようにする（3b の指摘、
      // #453 のレビュー——今日 3 回踏んだ「見るべきものが出てこないのを
      // 合格と読む」と同じ形を増やさないため）。
      notes.push(`${worker.name}: test/route-inventory.ts が無いので対象外。`);
      continue;
    }

    if (worker.assets.length === 0) continue;

    if (Object.prototype.hasOwnProperty.call(unprobeable, worker.name)) {
      notes.push(`${worker.name}: UNPROBEABLE 宣言により、case 枝を生成しない。`);
      continue;
    }

    if (worker.probePages === null) {
      errors.push(
        `${worker.name}: ASSET_ROUTES（${worker.assets.join(", ")}）があるのに ` +
          `route-inventory.ts に PROBE_PAGES の宣言がありません。` +
          `ページを足すか、外から確かめられないなら UNPROBEABLE に理由ごと書いてください。`,
      );
      continue;
    }

    if (worker.probePages.length === 0) {
      errors.push(
        `${worker.name}: ASSET_ROUTES（${worker.assets.join(", ")}）があるのに ` +
          `PROBE_PAGES が空です。ページを足すか、外から確かめられないなら ` +
          `UNPROBEABLE に理由ごと書いてください（空のまま case 枝を生成しません）。`,
      );
      continue;
    }

    const prefix = commonAssetPrefix(worker.assets);
    if (!prefix.ok) {
      const detail = prefix.groups
        .map((g) => `${g.prefix || "(ディレクトリ無し)"}: ${g.paths.join(", ")}`)
        .join(" / ");
      errors.push(
        `${worker.name}: ASSET_ROUTES が 1 つのディレクトリに畳めません（${detail}）。` +
          `1 つの Worker は 1 つの prefix の下にしかアセットを配らない前提が崩れています。`,
      );
      continue;
    }

    const pairs = worker.probePages.map((page) => `${page}:${prefix.prefix}`).join(" ");
    arms.push(`    ${worker.name}) echo "${pairs}" ;;`);
  }

  if (errors.length > 0) return { ok: false, errors, notes };

  const content = `#!/usr/bin/env bash
#
# 自動生成——手で編集しない（#453）。
# \`node scripts/generate-asset-probe-pages.mjs\` で作り直す。
#
# page は各 apps/<worker>/test/route-inventory.ts の \`PROBE_PAGES\`、
# prefix は同じファイルの \`ASSET_ROUTES\` の共通ディレクトリから機械的に
# 求めている。Worker ごとにそのページ・prefix を選んだ理由は、手で
# 合わせる field ではなくこの生成物にも存在しないので、route-inventory.ts
# 側の JSDoc を読むこと。

probe_pages_for() {
  case "\$1" in
${arms.join("\n")}
    *) echo "" ;;
  esac
}
`;

  return { ok: true, content, notes };
}

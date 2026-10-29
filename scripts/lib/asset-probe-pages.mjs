// @ts-check

/**
 * デプロイ後のアセット検査（`scripts/smoke-asset-probe.sh`）が、
 * **ハッシュ付きアセットを配る Worker を取りこぼしていないこと**を突き合わせる。
 *
 * ## なぜ要るのか
 *
 * 以前この検査は `/login` だけを見ていた。つまり **auth-worker の
 * ハッシュだけが本番で確かめられていて、dashboard-worker のほうは
 * 誰も見ていなかった。**
 *
 * 見落としやすいのは、**検査そのものは存在していて、緑だった**からである。
 * 「アセットの検査がある」と「全部のアセットが検査されている」の差は、
 * 検査の出力には出ない（`/login` の 2 件は実際に通る）。
 *
 * しかも**ハッシュはビルド時に決まる。** 生成が走らなければページの参照と
 * 配信パスがずれ、画面は描かれるので 500 にもならず外形監視にも出ない
 * （`smoke-asset-probe.sh` 冒頭）。この穴は Worker が 1 つ増えるたびに
 * 開き直せる。
 *
 * ## 何と何を突き合わせるか
 *
 * - **コード側**: 各 Worker の `test/route-inventory.ts` にある、パスに
 *   `/ui/` を含むルート。アセットを配っている Worker はここに必ず出る
 *   （一覧そのものは `route-inventory.test.ts` が実行時と突き合わせている）。
 * - **検査側**: `smoke-asset-probe.sh` の既定ページ一覧。
 *
 * 片方にしか無い Worker があれば落ちる。
 *
 * ## 確かめられない Worker は、確かめられないと宣言させる
 *
 * nfc-worker の `/account/nfc` は**未ログインで 302 を返す**ので、外から
 * 参照を読めない。ここを「アセットが無い Worker」と同じ扱いにすると、
 * **確かめていないことが一覧から消える。** だから `UNPROBEABLE` に理由ごと
 * 書かせ、理由が無ければ落とす。
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..");

/**
 * 外から確かめられない Worker と、その理由。
 *
 * **理由を空にできない。** 空で通ると「確かめられない」が「確かめなくてよい」に
 * すり替わる。
 */
export const UNPROBEABLE = {
  "nfc-worker":
    "カード画面 `/account/nfc` は未ログインで 302 を返すため、外から参照を読めない。" +
    "CSS 自体は公開されているが、**ページに書いてある URL と突き合わせる**のがこの検査の目的なので、" +
    "セッション無しでは成立しない。",
};

/** `smoke-asset-probe.sh` の既定ページ一覧を読む。 */
export function readProbePages(text) {
  // 既定を決めている 1 行だけを見る。散文は読まない。
  const match = /^\s*set -- (.+)$/m.exec(text);
  if (match === null) return null;
  return match[1].trim().split(/\s+/).filter(Boolean);
}

/** route-inventory からアセット（パスに `/ui/` を含むもの）を拾う。 */
export function readAssetRoutes(text) {
  return [...text.matchAll(/path:\s*"([^"]*\/ui\/[^"]*)"/g)].map((m) => m[1]);
}

/**
 * ページ一覧が、そのアセットを配る Worker をカバーしているか。
 *
 * **接頭辞で判定する。** `/account/ui/...` を配る Worker は `/account` か
 * その下のページで確かめられる。
 */
export function coversAsset(pages, assetPath) {
  const dir = assetPath.slice(0, assetPath.indexOf("/ui/")) || "/";
  return pages.some((page) => page === dir || page.startsWith(`${dir}/`) || dir === "/");
}

/**
 * @param unprobeable 既定は実物の `UNPROBEABLE`。**テストから差し替えられる
 *   ようにしてある** —— 引数の `workers` とモジュール定数を混ぜて見ると、
 *   組み立てた入力に実物が紛れ込む（テストで実際に踏んだ）。
 */
export function check({ probeText, workers, unprobeable = UNPROBEABLE }) {
  const problems = [];
  const pages = readProbePages(probeText);

  if (pages === null) {
    problems.push(
      "smoke-asset-probe.sh から既定のページ一覧を読めませんでした（`set -- ...` の行が見つからない）。" +
        "書き方を変えたなら readProbePages も直すこと。",
    );
    return { ok: false, problems, pages: [] };
  }

  for (const { name, assets } of workers) {
    if (assets.length === 0) continue;

    const reason = Object.prototype.hasOwnProperty.call(unprobeable, name)
      ? unprobeable[name]
      : undefined;

    if (reason !== undefined) {
      if (reason.trim() === "") {
        problems.push(`${name}: UNPROBEABLE に理由が書かれていません。`);
      }
      continue;
    }

    const uncovered = assets.filter((a) => !coversAsset(pages, a));
    if (uncovered.length > 0) {
      problems.push(
        `${name}: ハッシュ付きアセット（${uncovered.join(", ")}）を配っていますが、` +
          `smoke-asset-probe.sh の既定ページ（${pages.join(" ")}）がどれも触りません。` +
          `ページを足すか、外から確かめられないなら UNPROBEABLE に理由ごと書くこと。`,
      );
    }
  }

  // 逆向き: UNPROBEABLE に、もうアセットを配っていない Worker が残っていないか。
  const withAssets = new Set(workers.filter((w) => w.assets.length > 0).map((w) => w.name));
  for (const name of Object.keys(unprobeable)) {
    if (!withAssets.has(name)) {
      problems.push(
        `${name}: UNPROBEABLE に書かれていますが、アセットを配っていません。` +
          `消すこと —— 残すと「確かめられない Worker がある」と読み続けられます。`,
      );
    }
  }

  return { ok: problems.length === 0, problems, pages };
}

/** リポジトリを読んで `check` に渡す形にする。 */
export function collect(root = ROOT) {
  const probeText = readFileSync(join(root, "scripts/smoke-asset-probe.sh"), "utf8");
  const appsDir = join(root, "apps");
  const workers = readdirSync(appsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => {
      const inventory = join(appsDir, e.name, "test/route-inventory.ts");
      let text = "";
      try {
        text = readFileSync(inventory, "utf8");
      } catch {
        // route-inventory を持たない Worker。アセットの有無はここでは分からない。
        return { name: e.name, assets: [], hasInventory: false };
      }
      return { name: e.name, assets: readAssetRoutes(text), hasInventory: true };
    });
  return { probeText, workers };
}

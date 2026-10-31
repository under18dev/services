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
 * ## この検査が前提にしていること、前提が崩れたときの穴（#453）
 *
 * 上の突き合わせは全部、**`route-inventory.ts` に `ASSET_ROUTES` が
 * 書かれていること**を前提にしている。#447 では admin-worker にその
 * ルートを返す `app.get` 自体が無く、`ASSET_ROUTES` も空だった——
 * この検査から見ると「アセットを配っていない Worker」と区別が付かず、
 * `assets.length === 0` で早期に通り過ぎ、何も言わなかった。
 *
 * **実際に #447 を早期発見できたはずなのは `asset-coverage.test.ts` の
 * 最初のアサーション**（`EXPECTED_ASSETS.length > 0`）で、admin-worker
 * だけこのファイル自体が無かった。「新しい Worker を増やしたとき、
 * `route-inventory.ts` を書くところまでは進んだが `asset-coverage.test.ts`
 * を作り忘れる」という、もう 1 段手前の取りこぼしがある。
 *
 * そこで、**`ASSET_ROUTES` が 1 件でもある Worker には
 * `test/asset-coverage.test.ts` が存在すること**も、ここで突き合わせる
 * （`checkAssetCoverageTestExists`）。中身の正しさは問わない——
 * 存在すれば `pnpm -r test` がそのまま検証する。無いことだけがここの関心。
 *
 * ## 確かめられない Worker は、確かめられないと宣言させる
 *
 * nfc-worker の `/account/nfc` は**未ログインで 302 を返す**ので、外から
 * 参照を読めない。ここを「アセットが無い Worker」と同じ扱いにすると、
 * **確かめていないことが一覧から消える。** だから `UNPROBEABLE` に理由ごと
 * 書かせ、理由が無ければ落とす。
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
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

/**
 * `smoke-asset-probe.sh` の宣言（`probe_pages_for` の case）を読む。
 *
 * 返すのは `{ worker: [{ page, prefix }] }`。**Worker 名でキーを取る**ので、
 * 「アセットを配っているのに宣言が無い Worker」を接頭辞の一致ではなく
 * **名前の有無**で判定できる。
 *
 * 接頭辞が欠けている要素が 1 つでもあれば `null` を返す ——
 * **組になっていない宣言を部分的に受けない。** 受けると「接頭辞を書き
 * 忘れた Worker だけ借用の検査が無い」状態が、ここからは見えなくなる。
 */
export function readProbeDeclaration(text) {
  const body = /probe_pages_for\(\)\s*\{([\s\S]*?)\n\}/.exec(text);
  if (body === null) return null;

  const arms = [...body[1].matchAll(/^\s*([A-Za-z0-9_-]+)\)\s*echo "([^"]*)"/gm)];
  if (arms.length === 0) return null;

  /** @type {Record<string, {page: string, prefix: string}[]>} */
  const declared = {};
  for (const [, worker, specs] of arms) {
    const pairs = [];
    for (const spec of specs.trim().split(/\s+/).filter(Boolean)) {
      const at = spec.indexOf(":");
      if (at <= 0 || at === spec.length - 1) return null;
      pairs.push({ page: spec.slice(0, at), prefix: spec.slice(at + 1) });
    }
    if (pairs.length > 0) declared[worker] = pairs;
  }
  return declared;
}

/**
 * `deploy.yml` から、どのジョブがどの Worker ぶんを引いているかを読む。
 *
 * **宣言があることと、呼ばれることは別**である。`probe_pages_for` に
 * 書いただけでは 1 回も走らない —— そして走らない検査は、**書いた人には
 * 書いたように見える。** `pnpm check:asset-pages` が緑なのも変わらない。
 */
export function readDeployInvocations(text) {
  /** @type {Record<string, string>} ワーカー名 -> ジョブ名 */
  const byWorker = {};
  let job = "";
  for (const line of text.split("\n")) {
    const jobMatch = /^ {2}([a-z][a-z0-9-]*):\s*$/.exec(line);
    if (jobMatch !== null) job = jobMatch[1];
    const call = /smoke-asset-probe\.sh\s+\S+\s+([A-Za-z0-9_-]+)/.exec(line);
    if (call !== null) byWorker[call[1]] = job;
  }
  return byWorker;
}

/**
 * route-inventory の `PROBE_PAGES` を読む。
 *
 * **シェル側の一覧と一致していなければならない。** 参照の有無を
 * レンダリングで確かめられるのは Worker のテスト側だけで、そちらは
 * この `PROBE_PAGES` を見ている。ずれると**本番が引くページと、
 * 参照を確かめたページが別物になる。**
 *
 * 宣言が無ければ `null`（「空の一覧」と区別する）。
 */
export function readProbePagesDeclaration(text) {
  const match = /export const PROBE_PAGES[^=]*=\s*\[([^\]]*)\]/.exec(text);
  if (match === null) return null;
  return [...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

/** route-inventory からアセット（パスに `/ui/` を含むもの）を拾う。 */
export function readAssetRoutes(text) {
  return [...text.matchAll(/path:\s*"([^"]*\/ui\/[^"]*)"/g)].map((m) => m[1]);
}

/**
 * そのアセットを配る Worker が、宣言された接頭辞のどれかに収まっているか。
 *
 * **接頭辞は厳密に比べる。** `/account/nfc/ui/x.css` は `/account/` でも
 * 始まるので、緩く見ると dashboard が nfc のものを借りても通ってしまう
 * （`smoke-asset-probe.sh` に実測を書いた）。
 */
export function coveredByPrefix(pairs, assetPath) {
  return pairs.some(({ prefix }) => assetPath.startsWith(prefix));
}

/**
 * @param unprobeable 既定は実物の `UNPROBEABLE`。**テストから差し替えられる
 *   ようにしてある** —— 引数の `workers` とモジュール定数を混ぜて見ると、
 *   組み立てた入力に実物が紛れ込む（テストで実際に踏んだ）。
 */
export function check({ probeText, workers, unprobeable = UNPROBEABLE, deployText }) {
  const problems = [];
  const declared = readProbeDeclaration(probeText);

  if (declared === null) {
    problems.push(
      "smoke-asset-probe.sh の宣言を読めませんでした（`probe_pages_for` の case が無いか、" +
        "`ページ:接頭辞` の組になっていない要素がある）。書き方を変えたなら readProbeDeclaration も直すこと。",
    );
    return { ok: false, problems, declared: {} };
  }

  // **外から確かめられるかどうかに関係なく要る。**（#453）下のループは
  // UNPROBEABLE な Worker を素通りするが、`asset-coverage.test.ts` は
  // Worker 自身のテスト環境でレンダリングするので、外部から未認証で
  // 引けるかどうかは無関係——nfc-worker も持っている。
  for (const { name, assets, hasAssetCoverageTest } of workers) {
    if (assets.length === 0) continue;
    if (hasAssetCoverageTest) continue;
    problems.push(
      `${name}: ハッシュ付きアセット（${assets.join(", ")}）を route-inventory.ts に ` +
        `宣言していますが、test/asset-coverage.test.ts がありません。宣言した ASSET_ROUTES を ` +
        `実際にどこかのページが参照しているかは、この検査以外のどこも確かめていません。` +
        `他の Worker の asset-coverage.test.ts と同じ形で足すこと（#447 はこれが無かったために ` +
        `見つからなかった）。`,
    );
  }

  for (const { name, assets, probePages: inventoryPages } of workers) {
    if (assets.length === 0) continue;

    const reason = Object.prototype.hasOwnProperty.call(unprobeable, name)
      ? unprobeable[name]
      : undefined;

    if (reason !== undefined) {
      if (reason.trim() === "") {
        problems.push(`${name}: UNPROBEABLE に理由が書かれていません。`);
      }
      if (Object.prototype.hasOwnProperty.call(declared, name)) {
        problems.push(
          `${name}: UNPROBEABLE と probe_pages_for の両方に居ます。どちらか一方にすること ——` +
            ` 両方にあると「確かめている」と「確かめられない」が同時に成り立つように読めます。`,
        );
      }
      continue;
    }

    const pairs = declared[name];
    if (pairs === undefined) {
      problems.push(
        `${name}: ハッシュ付きアセット（${assets.join(", ")}）を配っていますが、` +
          `smoke-asset-probe.sh の probe_pages_for に宣言がありません。` +
          `ページと接頭辞を足すか、外から確かめられないなら UNPROBEABLE に理由ごと書くこと。`,
      );
      continue;
    }

    // **シェル側の一覧と `PROBE_PAGES` が一致しているか。**
    //
    // ずれると、本番が引くページと「参照を確かめたページ」が別物になる。
    // どちらも単体では緑のままなので、ここで突き合わせるしかない。
    const declaredPages = pairs.map((p) => p.page).sort();
    if (inventoryPages === null) {
      problems.push(
        `${name}: route-inventory.ts に PROBE_PAGES がありません。` +
          `smoke-asset-probe.sh と同じ一覧を置き、Worker 側のテストでレンダリングして確かめること。`,
      );
    } else {
      const fromInventory = [...inventoryPages].sort();
      if (JSON.stringify(declaredPages) !== JSON.stringify(fromInventory)) {
        problems.push(
          `${name}: smoke-asset-probe.sh（${declaredPages.join(" ")}）と ` +
            `route-inventory.ts の PROBE_PAGES（${fromInventory.join(" ")}）が一致しません。` +
            `本番が引くページと、参照を確かめたページが別物になります。`,
        );
      }
    }

    // **宣言した接頭辞が、その Worker の実際のアセットと噛み合っているか。**
    // 配信パスを変えたときにここが置き去りになると、借用の検査が
    // **全部の参照を弾く**ようになり、原因が「借用」と報告される。
    const uncovered = assets.filter((a) => !coveredByPrefix(pairs, a));
    if (uncovered.length > 0) {
      problems.push(
        `${name}: 宣言した接頭辞（${pairs.map((p) => p.prefix).join(", ")}）に、` +
          `配っているアセット（${uncovered.join(", ")}）が入りません。配信パスを変えたなら宣言も直すこと。`,
      );
    }
  }

  // **宣言した Worker が、デプロイから実際に呼ばれているか。**
  //
  // `deployText` が渡されたときだけ見る（単体テストでは省ける）。
  if (deployText !== undefined) {
    const invoked = readDeployInvocations(deployText);
    for (const name of Object.keys(declared)) {
      if (!Object.prototype.hasOwnProperty.call(invoked, name)) {
        problems.push(
          `${name}: probe_pages_for に宣言がありますが、deploy.yml のどのジョブからも呼ばれていません。` +
            `宣言しただけでは 1 回も走りません。`,
        );
      }
    }
    // **自分のジョブから呼ばれているか。** 隣のジョブから呼ぶと、
    // まだデプロイされていない Worker を引くことになる（#310 で実際に起きた）。
    for (const [name, job] of Object.entries(invoked)) {
      const expected = `deploy-${name}`;
      if (job !== expected) {
        problems.push(
          `${name} ぶんの検査が ${job} から呼ばれています（${expected} であるべき）。` +
            `隣のジョブから引くと、まだデプロイされていない Worker を見ることになります。`,
        );
      }
    }
  }

  // 逆向き: もうアセットを配っていない Worker が宣言に残っていないか。
  const withAssets = new Set(workers.filter((w) => w.assets.length > 0).map((w) => w.name));
  for (const name of Object.keys(declared)) {
    if (!withAssets.has(name)) {
      problems.push(
        `${name}: probe_pages_for に宣言がありますが、アセットを配っていません。消すこと。`,
      );
    }
  }
  for (const name of Object.keys(unprobeable)) {
    if (!withAssets.has(name)) {
      problems.push(
        `${name}: UNPROBEABLE に書かれていますが、アセットを配っていません。` +
          `消すこと —— 残すと「確かめられない Worker がある」と読み続けられます。`,
      );
    }
  }

  return { ok: problems.length === 0, problems, declared };
}

/** リポジトリを読んで `check` に渡す形にする。 */
export function collect(root = ROOT) {
  const probeText = readFileSync(join(root, "scripts/smoke-asset-probe.sh"), "utf8");
  const deployText = readFileSync(join(root, ".github/workflows/deploy.yml"), "utf8");
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
        return {
          name: e.name,
          assets: [],
          probePages: null,
          hasInventory: false,
          hasAssetCoverageTest: false,
        };
      }
      return {
        name: e.name,
        assets: readAssetRoutes(text),
        probePages: readProbePagesDeclaration(text),
        hasInventory: true,
        hasAssetCoverageTest: existsSync(join(appsDir, e.name, "test/asset-coverage.test.ts")),
      };
    });
  return { probeText, deployText, workers };
}

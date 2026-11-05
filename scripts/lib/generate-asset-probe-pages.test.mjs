import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { collect, UNPROBEABLE } from "./asset-probe-pages.mjs";
import { buildProbePagesScript } from "./generate-asset-probe-pages.mjs";

/**
 * `scripts/generate-asset-probe-pages.mjs`（#453）の生成ロジック。
 *
 * **対象 Worker をハードコードしていないことを確かめる。** 渡した
 * `workers` 配列をそのまま処理するだけなので、5 つ目の Worker を
 * 足しても呼び出し側のコードを直さずに済む——その前提が崩れていないか、
 * 見覚えの無い Worker 名を混ぜたテストで確認する。
 */

const AUTH = { name: "auth-worker", assets: ["/ui/u18.<hash>.css"], probePages: ["/login"] };
const DASHBOARD = {
  name: "dashboard-worker",
  assets: ["/account/ui/u18.<hash>.css", "/account/ui/account-island.<hash>.js"],
  probePages: ["/account"],
};

function worker(overrides) {
  return { hasInventory: true, ...overrides };
}

test("揃っていれば case 枝を 1 本ずつ生成する", () => {
  const result = buildProbePagesScript([worker(AUTH), worker(DASHBOARD)], {});
  assert.equal(result.ok, true);
  assert.match(result.content, /auth-worker\) echo "\/login:\/ui\/" ;;/);
  assert.match(result.content, /dashboard-worker\) echo "\/account:\/account\/ui\/" ;;/);
});

test("Worker 名をハードコードしていない——見覚えの無い名前でも生成する", () => {
  // issue 本体の指摘そのもの：「5 つ目の Worker」を想定したテスト。
  const result = buildProbePagesScript(
    [
      worker({
        name: "video-worker",
        assets: ["/video/ui/u18.<hash>.css"],
        probePages: ["/watch"],
      }),
    ],
    {},
  );
  assert.equal(result.ok, true);
  assert.match(result.content, /video-worker\) echo "\/watch:\/video\/ui\/" ;;/);
});

test("並び順は Worker 名のアルファベット順（決定的な出力）", () => {
  const result = buildProbePagesScript([worker(DASHBOARD), worker(AUTH)], {});
  assert.equal(result.ok, true);
  const authIndex = result.content.indexOf("auth-worker)");
  const dashboardIndex = result.content.indexOf("dashboard-worker)");
  assert.ok(authIndex < dashboardIndex, "auth-worker が先に出るべき");
});

test("複数ページがあれば、同じ prefix で並べる", () => {
  const result = buildProbePagesScript(
    [worker({ ...AUTH, probePages: ["/login", "/health"] })],
    {},
  );
  assert.equal(result.ok, true);
  assert.match(result.content, /auth-worker\) echo "\/login:\/ui\/ \/health:\/ui\/" ;;/);
});

test("アセットを配っていない Worker は無視する", () => {
  const result = buildProbePagesScript(
    [worker(AUTH), worker({ name: "plain", assets: [], probePages: [] })],
    {},
  );
  assert.equal(result.ok, true);
  assert.doesNotMatch(result.content, /plain\)/);
});

test("route-inventory.ts を持たない Worker は飛ばすが、名前を note に出す", () => {
  const result = buildProbePagesScript(
    [worker(AUTH), { name: "no-screen", assets: [], probePages: null, hasInventory: false }],
    {},
  );
  assert.equal(result.ok, true);
  assert.doesNotMatch(result.content, /no-screen\)/);
  assert.ok(
    result.notes.some((n) => n.includes("no-screen") && n.includes("route-inventory.ts")),
    "飛ばした Worker 名が note に出ていない",
  );
});

test("UNPROBEABLE な Worker は case 枝を生成しないが、note に出す", () => {
  const result = buildProbePagesScript(
    [worker(AUTH), worker({ name: "nfc-worker", assets: ["/x/ui/a.css"], probePages: [] })],
    { "nfc-worker": "理由" },
  );
  assert.equal(result.ok, true);
  assert.doesNotMatch(result.content, /nfc-worker\)/);
  assert.ok(
    result.notes.some((n) => n.includes("nfc-worker") && n.includes("UNPROBEABLE")),
    "UNPROBEABLE で飛ばした Worker 名が note に出ていない",
  );
});

test("ASSET_ROUTES があるのに PROBE_PAGES が無ければ失敗する（空の枝を作らない）", () => {
  const result = buildProbePagesScript(
    [worker({ name: "broken", assets: ["/x/ui/a.css"], probePages: null })],
    {},
  );
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /broken.*PROBE_PAGES の宣言がありません/s);
});

test("ASSET_ROUTES があるのに PROBE_PAGES が空配列でも失敗する", () => {
  // `null`（宣言そのものが無い）と `[]`（宣言はあるが空）を同じ失敗として扱う
  // ——`UNPROBEABLE` に書かれていない限り、アセットを配るなら最低 1 ページは要る。
  const result = buildProbePagesScript(
    [worker({ name: "broken", assets: ["/x/ui/a.css"], probePages: [] })],
    {},
  );
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /broken.*PROBE_PAGES が空です/s);
});

test("ASSET_ROUTES が 1 つのディレクトリに畳めなければ、食い違ったパスごと失敗する", () => {
  const result = buildProbePagesScript(
    [
      worker({
        name: "mixed",
        assets: ["/a/ui/x.css", "/b/ui/y.css"],
        probePages: ["/page"],
      }),
    ],
    {},
  );
  assert.equal(result.ok, false);
  const message = result.errors.join("\n");
  assert.match(message, /mixed/);
  assert.match(message, /\/a\/ui\/x\.css/);
  assert.match(message, /\/b\/ui\/y\.css/);
});

test("1 件でも失敗があれば、揃っている Worker の分も含めて content を返さない", () => {
  // 一部だけ生成すると、「このファイルは完全な一覧である」という前提
  // （check-asset-probe-pages.mjs が全文を読む）が崩れる。
  const result = buildProbePagesScript(
    [worker(AUTH), worker({ name: "broken", assets: ["/x/ui/a.css"], probePages: null })],
    {},
  );
  assert.equal(result.ok, false);
  assert.equal(result.content, undefined);
});

test("実物のリポジトリで生成した内容が、checked-in の生成物と一致する", () => {
  // **ここが本題。** `node scripts/generate-asset-probe-pages.mjs` を
  // 実行し忘れたまま commit されていないかを、テストの形でも見る
  // （CI の `--check` と同じことを、実物の `collect()` に対してやる）。
  const { workers } = collect();
  const result = buildProbePagesScript(workers, UNPROBEABLE);
  assert.equal(result.ok, true, result.errors?.join("\n"));

  const root = join(import.meta.dirname, "..", "..");
  const committed = readFileSync(join(root, "scripts/generated/asset-probe-pages.sh"), "utf8");
  assert.equal(
    result.content,
    committed,
    "scripts/generated/asset-probe-pages.sh が古い。" +
      "`node scripts/generate-asset-probe-pages.mjs` を実行してコミットすること。",
  );
});

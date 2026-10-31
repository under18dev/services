import assert from "node:assert/strict";
import test from "node:test";
import {
  UNPROBEABLE,
  check,
  collect,
  coveredByPrefix,
  readAssetRoutes,
  readDeployInvocations,
  readProbeDeclaration,
  readProbePagesDeclaration,
} from "./asset-probe-pages.mjs";

/**
 * アセット検査のカバレッジ照合（`check-asset-probe-pages.mjs`）。
 *
 * **実物のリポジトリに対しても 1 回走らせている**（最後のテスト）。
 * 組み立てた入力だけだと、読み取り（ファイル名・正規表現）が実物と
 * 合っているかを確かめられない。
 */

const PROBE = `
probe_pages_for() {
  case "$1" in
    auth-worker) echo "/login:/ui/" ;;
    dashboard-worker) echo "/account:/account/ui/" ;;
    *) echo "" ;;
  esac
}
`;

const DEPLOY = `
  deploy-auth-worker:
    steps:
          scripts/smoke-asset-probe.sh "\${PRODUCTION_URL%/}" auth-worker
  deploy-dashboard-worker:
    steps:
          scripts/smoke-asset-probe.sh "\${PRODUCTION_URL%/}" dashboard-worker
`;

const WORKERS = [
  {
    name: "auth-worker",
    assets: ["/ui/u18.<hash>.css"],
    probePages: ["/login"],
    hasInventory: true,
    hasAssetCoverageTest: true,
  },
  {
    name: "dashboard-worker",
    assets: ["/account/ui/u18.<hash>.css"],
    probePages: ["/account"],
    hasInventory: true,
    hasAssetCoverageTest: true,
  },
];

test("宣言を Worker 名でキーを取って読む", () => {
  assert.deepEqual(readProbeDeclaration(PROBE), {
    "auth-worker": [{ page: "/login", prefix: "/ui/" }],
    "dashboard-worker": [{ page: "/account", prefix: "/account/ui/" }],
  });
});

test("接頭辞の欠けた要素があれば null（部分的に受けない）", () => {
  // 受けると「接頭辞を書き忘れた Worker だけ借用の検査が無い」状態が、
  // 照合側から見えなくなる。
  assert.equal(readProbeDeclaration(PROBE.replace("/login:/ui/", "/login")), null);
  assert.equal(readProbeDeclaration(PROBE.replace("/login:/ui/", ":/ui/")), null);
  assert.equal(readProbeDeclaration(PROBE.replace("/login:/ui/", "/login:")), null);
});

test("`probe_pages_for` が無ければ null（黙って 0 件にしない）", () => {
  assert.equal(readProbeDeclaration('PAGES="/login:/ui/"'), null);
});

test("deploy.yml から ワーカー -> ジョブ を読む", () => {
  assert.deepEqual(readDeployInvocations(DEPLOY), {
    "auth-worker": "deploy-auth-worker",
    "dashboard-worker": "deploy-dashboard-worker",
  });
});

test("接頭辞は厳密に比べる", () => {
  const pairs = [{ page: "/account", prefix: "/account/ui/" }];
  assert.equal(coveredByPrefix(pairs, "/account/ui/u18.css"), true);
  // **ここが肝。** `/account/nfc/ui/...` は `/account/` でも始まるので、
  // 緩く見ると dashboard が nfc のものを借りても通ってしまう。
  assert.equal(coveredByPrefix(pairs, "/account/nfc/ui/u18.css"), false);
});

test("route-inventory からアセットだけ拾う", () => {
  const text = `
    { method: "GET", path: "/account" },
    { method: "GET", path: "/account/ui/u18.<hash>.css" },
    { method: "GET", path: "/account/api/me" },
  `;
  assert.deepEqual(readAssetRoutes(text), ["/account/ui/u18.<hash>.css"]);
});

test("揃っていれば通る", () => {
  const result = check({ probeText: PROBE, workers: WORKERS, unprobeable: {}, deployText: DEPLOY });
  assert.deepEqual(result.problems, []);
});

test("配っているのに宣言が無ければ落ちる", () => {
  const result = check({
    probeText: PROBE,
    workers: [
      ...WORKERS,
      {
        name: "nfc-worker",
        assets: ["/x/ui/a.css"],
        probePages: [],
        hasInventory: true,
        hasAssetCoverageTest: true,
      },
    ],
    unprobeable: {},
    deployText: DEPLOY,
  });
  assert.equal(result.ok, false);
  assert.match(result.problems.join("\n"), /nfc-worker: ハッシュ付きアセット.*宣言がありません/s);
});

test("asset-coverage.test.ts が無ければ落ちる（#453）", () => {
  // #447 の実際の穴——ASSET_ROUTES はあるのに、参照されているかを
  // 確かめるテストファイル自体が無かった。
  const result = check({
    probeText: PROBE,
    workers: [{ ...WORKERS[0], hasAssetCoverageTest: false }, WORKERS[1]],
    unprobeable: {},
    deployText: DEPLOY,
  });
  assert.equal(result.ok, false);
  assert.match(result.problems.join("\n"), /auth-worker.*asset-coverage\.test\.ts がありません/s);
});

test("asset-coverage.test.ts の有無は、外から確かめられるかどうかと無関係", () => {
  // UNPROBEABLE な Worker（外部から見えない）でも、Worker 自身の
  // レンダリングで確かめるテストは要る。
  const result = check({
    probeText: PROBE,
    workers: [WORKERS[0], { ...WORKERS[1], hasAssetCoverageTest: false }],
    unprobeable: { "dashboard-worker": "外から読めない理由がここに書いてある" },
    deployText: DEPLOY,
  });
  assert.equal(result.ok, false);
  assert.match(
    result.problems.join("\n"),
    /dashboard-worker.*asset-coverage\.test\.ts がありません/s,
  );
});

test("アセットを配っていない Worker は無視する", () => {
  const result = check({
    probeText: PROBE,
    workers: [...WORKERS, { name: "plain", assets: [], probePages: [], hasInventory: true }],
    unprobeable: {},
    deployText: DEPLOY,
  });
  assert.deepEqual(result.problems, []);
});

test("UNPROBEABLE の理由が空なら落ちる", () => {
  // 空で通すと「確かめられない」が「確かめなくてよい」にすり替わる。
  const result = check({
    probeText: PROBE,
    workers: [
      ...WORKERS,
      {
        name: "w",
        assets: ["/x/ui/a.css"],
        probePages: [],
        hasInventory: true,
        hasAssetCoverageTest: true,
      },
    ],
    unprobeable: { w: "   " },
    deployText: DEPLOY,
  });
  assert.equal(result.ok, false);
  assert.match(result.problems.join("\n"), /理由が書かれていません/);
});

test("宣言と UNPROBEABLE の両方に居たら落ちる", () => {
  // 「確かめている」と「確かめられない」が同時に成り立つように読める。
  const result = check({
    probeText: PROBE,
    workers: WORKERS,
    unprobeable: { "dashboard-worker": "外から読めない理由がここに書いてある" },
    deployText: DEPLOY,
  });
  assert.equal(result.ok, false);
  assert.match(result.problems.join("\n"), /両方に居ます/);
});

test("宣言した接頭辞が実物と噛み合わなければ落ちる", () => {
  const result = check({
    probeText: PROBE.replace("/account:/account/ui/", "/account:/account/assets/"),
    workers: WORKERS,
    unprobeable: {},
    deployText: DEPLOY,
  });
  assert.equal(result.ok, false);
  assert.match(result.problems.join("\n"), /配信パスを変えたなら宣言も直すこと/);
});

test("宣言しても deploy から呼ばれていなければ落ちる", () => {
  // **宣言があることと、呼ばれることは別。** 走らない検査は、書いた人には
  // 書いたように見える。
  const result = check({
    probeText: PROBE,
    workers: WORKERS,
    unprobeable: {},
    deployText: DEPLOY.replace(/.*dashboard-worker\n/, ""),
  });
  assert.equal(result.ok, false);
  assert.match(result.problems.join("\n"), /どのジョブからも呼ばれていません/);
});

test("隣のジョブから呼ばれていたら落ちる", () => {
  // まだデプロイされていない Worker を引くことになる（#310 で実際に起きた）。
  const result = check({
    probeText: PROBE,
    workers: WORKERS,
    unprobeable: {},
    deployText: DEPLOY.replace(
      "  deploy-dashboard-worker:\n    steps:\n",
      "  deploy-auth-worker:\n    steps:\n",
    ),
  });
  assert.equal(result.ok, false);
  assert.match(result.problems.join("\n"), /であるべき/);
});

test("もう配っていない Worker が宣言や UNPROBEABLE に残っていたら落ちる", () => {
  const result = check({
    probeText: PROBE,
    workers: [],
    unprobeable: { gone: "理由" },
    deployText: DEPLOY,
  });
  assert.equal(result.ok, false);
  assert.match(result.problems.join("\n"), /消すこと/);
});

test("実物の UNPROBEABLE には全部理由が書いてある", () => {
  for (const [name, reason] of Object.entries(UNPROBEABLE)) {
    assert.equal(typeof reason, "string", name);
    assert.ok(reason.trim().length > 20, `${name}: 理由が短すぎる`);
  }
});

test("実物のリポジトリで通る", () => {
  // **ここが本題。** 組み立てた入力だけだと、`collect` のファイル名や
  // 正規表現が実物とずれていても全部通る。
  const { probeText, deployText, workers } = collect();
  const result = check({ probeText, workers, deployText });
  assert.deepEqual(result.problems, []);

  // 読み取りが成立していること自体も見る。0 個なら、拾えていないだけかも
  // しれない —— 「問題なし」と区別が付かない。
  assert.ok(
    workers.filter((w) => w.assets.length > 0).length >= 2,
    "アセットを配る Worker が 2 個未満。route-inventory の読み取りが効いていない",
  );
  assert.ok(
    Object.keys(readProbeDeclaration(probeText) ?? {}).length >= 2,
    "宣言が 2 件未満。probe_pages_for の読み取りが効いていない",
  );
  assert.ok(
    Object.keys(readDeployInvocations(deployText)).length >= 2,
    "deploy.yml からの呼び出しが 2 件未満。読み取りが効いていない",
  );
});

test("PROBE_PAGES の宣言を読む", () => {
  const text = 'export const PROBE_PAGES: readonly string[] = ["/account/passkeys", "/x"];';
  assert.deepEqual(readProbePagesDeclaration(text), ["/account/passkeys", "/x"]);
});

test("PROBE_PAGES が空でも読める（宣言が無いのと区別する）", () => {
  // `[]` は「本番検査に載せない」という宣言。無いのとは意味が違う。
  assert.deepEqual(
    readProbePagesDeclaration("export const PROBE_PAGES: readonly string[] = [];"),
    [],
  );
  assert.equal(readProbePagesDeclaration("何も無い"), null);
});

test("シェルの一覧と PROBE_PAGES がずれたら落ちる", () => {
  // ずれると、本番が引くページと「参照を確かめたページ」が別物になる。
  // どちらも単体では緑のまま。
  const result = check({
    probeText: PROBE,
    workers: [
      { ...WORKERS[0] },
      { ...WORKERS[1], probePages: ["/account/passkeys"] }, // シェルは /account
    ],
    unprobeable: {},
    deployText: DEPLOY,
  });
  assert.equal(result.ok, false);
  assert.match(result.problems.join("\n"), /一致しません/);
});

test("PROBE_PAGES の宣言そのものが無ければ落ちる", () => {
  const result = check({
    probeText: PROBE,
    workers: [{ ...WORKERS[0] }, { ...WORKERS[1], probePages: null }],
    unprobeable: {},
    deployText: DEPLOY,
  });
  assert.equal(result.ok, false);
  assert.match(result.problems.join("\n"), /PROBE_PAGES がありません/);
});

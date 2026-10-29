import assert from "node:assert/strict";
import test from "node:test";
import {
  UNPROBEABLE,
  check,
  collect,
  coveredByPrefix,
  readAssetRoutes,
  readProbePages,
} from "./asset-probe-pages.mjs";

/**
 * アセット検査のカバレッジ照合（`check-asset-probe-pages.mjs`）。
 *
 * **実物のリポジトリに対しても 1 回走らせている**（最後のテスト）。
 * 単体で組み立てた入力だけだと、`collect` の読み取り（ファイル名、
 * 正規表現）が実物と合っているかを確かめられない。
 */

test("既定の一覧を ページ:接頭辞 の組として読む", () => {
  assert.deepEqual(readProbePages("x\n  set -- /login:/ui/ /account:/account/ui/\ny"), [
    { page: "/login", prefix: "/ui/" },
    { page: "/account", prefix: "/account/ui/" },
  ]);
});

test("接頭辞の欠けた要素があれば null（部分的に受けない）", () => {
  // 受けると「接頭辞を書き忘れたページだけ借用の検査が無い」状態が、
  // 照合側から見えなくなる。
  assert.equal(readProbePages("  set -- /login:/ui/ /account"), null);
  assert.equal(readProbePages("  set -- :/ui/"), null);
  assert.equal(readProbePages("  set -- /login:"), null);
});

test("`set --` の行が無ければ null（黙って 0 件にしない）", () => {
  // 0 件を返すと「ページが 1 つも無い」と区別が付かず、全 Worker が
  // 未カバー扱いになる。読めなかったことを別に伝える。
  assert.equal(readProbePages('PAGES="/login"; set -- $PAGES'), null);
});

test("route-inventory からアセットだけ拾う", () => {
  const text = `
    { method: "GET", path: "/account" },
    { method: "GET", path: "/account/ui/u18.<hash>.css" },
    { method: "GET", path: "/account/api/me" },
  `;
  assert.deepEqual(readAssetRoutes(text), ["/account/ui/u18.<hash>.css"]);
});

test("接頭辞は厳密に比べる", () => {
  const pairs = [
    { page: "/login", prefix: "/ui/" },
    { page: "/account", prefix: "/account/ui/" },
  ];
  assert.equal(coveredByPrefix(pairs, "/ui/u18.css"), true);
  assert.equal(coveredByPrefix(pairs, "/account/ui/u18.css"), true);

  // **ここが肝。** `/account/nfc/ui/...` は `/account/` でも始まるので、
  // 緩く見ると dashboard が nfc のものを借りても通ってしまう。
  assert.equal(coveredByPrefix(pairs, "/account/nfc/ui/u18.css"), false);
});

const PROBE = "  set -- /login:/ui/ /account:/account/ui/\n";

test("配っているのに触られない Worker があれば落ちる", () => {
  const result = check({
    probeText: "  set -- /login:/ui/\n",
    workers: [{ name: "dash", assets: ["/account/ui/u18.css"], hasInventory: true }],
  });
  assert.equal(result.ok, false);
  assert.match(result.problems[0], /dash/);
});

test("アセットを配っていない Worker は無視する", () => {
  // 接頭辞の逆向き検査が鳴らないよう、実在のアセットを 1 つ持つ Worker も渡す。
  const result = check({
    probeText: PROBE,
    workers: [
      { name: "plain", assets: [], hasInventory: true },
      { name: "a", assets: ["/ui/x.css"], hasInventory: true },
      { name: "d", assets: ["/account/ui/x.css"], hasInventory: true },
    ],
    unprobeable: {},
  });
  assert.deepEqual(result.problems, []);
});

test("UNPROBEABLE の理由が空なら落ちる", () => {
  // 空で通すと「確かめられない」が「確かめなくてよい」にすり替わる。
  const result = check({
    probeText: PROBE,
    workers: [{ name: "w", assets: ["/nowhere/ui/x.css"], hasInventory: true }],
    unprobeable: { w: "   " },
  });
  assert.equal(result.ok, false);
  assert.match(result.problems[0], /理由が書かれていません/);
});

test("理由が書いてあれば通す", () => {
  // 宣言された接頭辞に入るアセットを持つ Worker も渡す。**渡さないと
  // 「接頭辞に入るアセットが無い」のほうが鳴る** —— UNPROBEABLE の
  // Worker のアセットは、どの接頭辞にも入らないのが正常なので。
  const result = check({
    probeText: PROBE,
    workers: [
      { name: "w", assets: ["/nowhere/ui/x.css"], hasInventory: true },
      { name: "a", assets: ["/ui/x.css"], hasInventory: true },
      { name: "d", assets: ["/account/ui/x.css"], hasInventory: true },
    ],
    unprobeable: { w: "未ログインでは 302 を返すため、外から参照を読めない" },
  });
  assert.deepEqual(result.problems, []);
});

test("実物の UNPROBEABLE には全部理由が書いてある", () => {
  for (const [name, reason] of Object.entries(UNPROBEABLE)) {
    assert.equal(typeof reason, "string", name);
    assert.ok(reason.trim().length > 20, `${name}: 理由が短すぎる`);
  }
});

test("もうアセットを配っていない Worker が UNPROBEABLE に残っていたら落ちる", () => {
  const result = check({ probeText: PROBE, workers: [], unprobeable: { gone: "理由" } });
  assert.equal(result.ok, false);
  assert.match(result.problems.join("\n"), /消すこと/);
});

test("実物のリポジトリで通る", () => {
  // **ここが本題。** 組み立てた入力だけだと、`collect` のファイル名や
  // 正規表現が実物とずれていても全部通る。
  const { probeText, workers } = collect();
  const result = check({ probeText, workers });
  assert.deepEqual(result.problems, []);

  // 読み取りが成立していること自体も見る。0 個なら、拾えていないだけかも
  // しれない —— 「問題なし」と区別が付かない。
  assert.ok(
    workers.filter((w) => w.assets.length > 0).length >= 2,
    "アセットを配る Worker が 2 個未満。route-inventory の読み取りが効いていない可能性がある",
  );
  assert.ok(result.pages.length >= 2, "既定ページが 2 件未満");
});

test("どの Worker のアセットも入らない接頭辞が残っていたら落ちる", () => {
  // 配信パスを変えたときにここが置き去りになる。残ると借用の検査が
  // **全部の参照を弾く**ようになり、原因が「借用」と報告される。
  const result = check({
    probeText: "  set -- /login:/ui/ /account:/old-path/ui/\n",
    workers: [{ name: "a", assets: ["/ui/x.css"], hasInventory: true }],
    unprobeable: {},
  });
  assert.equal(result.ok, false);
  assert.match(result.problems.join("\n"), /\/old-path\/ui\/ の接頭辞に入るアセットが/);
});

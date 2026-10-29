import assert from "node:assert/strict";
import test from "node:test";
import {
  UNPROBEABLE,
  check,
  collect,
  coversAsset,
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

test("既定のページ一覧を読む", () => {
  assert.deepEqual(readProbePages("x\n  set -- /login /account\ny"), ["/login", "/account"]);
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

test("接頭辞でカバーを判定する", () => {
  assert.equal(coversAsset(["/account"], "/account/ui/u18.css"), true);
  assert.equal(coversAsset(["/account/sessions"], "/account/ui/u18.css"), true);
  assert.equal(coversAsset(["/login"], "/account/ui/u18.css"), false);
  // auth-worker は `/ui/...` を root で配る。`/login` で確かめられる。
  assert.equal(coversAsset(["/login"], "/ui/u18.css"), true);
});

const PROBE = "  set -- /login /account\n";

test("配っているのに触られない Worker があれば落ちる", () => {
  const result = check({
    probeText: "  set -- /login\n",
    workers: [{ name: "dash", assets: ["/account/ui/u18.css"], hasInventory: true }],
  });
  assert.equal(result.ok, false);
  assert.match(result.problems[0], /dash/);
});

test("アセットを配っていない Worker は無視する", () => {
  const result = check({
    probeText: PROBE,
    workers: [{ name: "plain", assets: [], hasInventory: true }],
    unprobeable: {},
  });
  assert.equal(result.ok, true);
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
  const result = check({
    probeText: PROBE,
    workers: [{ name: "w", assets: ["/nowhere/ui/x.css"], hasInventory: true }],
    unprobeable: { w: "未ログインでは 302 を返すため、外から参照を読めない" },
  });
  assert.equal(result.ok, true);
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

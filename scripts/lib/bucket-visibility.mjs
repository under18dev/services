/**
 * 退避先バケットが公開されていないことの検査（runbook §12.7 の残件）。
 *
 * `u18-identity-archive` には **`ip_hash` と `user_agent`** を含む監査ログと、
 * **平文のメールアドレス**を含む D1 のダンプが入る。バケットが読めると
 * それがそのまま読める。
 *
 * 2026-10-24 に 3 経路を手で確認した（runbook §12.7）。**問題は、その確認が
 * 一度しか成立しないこと**である。公開はダッシュボードからの操作で起こり、
 * コードも設定ファイルも変わらない。`git log` に痕跡が残らないので、
 * **次に誰かが 3 コマンドを打つまで誰も気づかない。**
 *
 * ここは判定だけを持つ。`wrangler` を起動するのは
 * `scripts/check-bucket-visibility.mjs` で、**この層には I/O を入れない** ——
 * 入れると、判定の検査に `wrangler` と実バケットが要るようになる。
 * 実際の出力文字列を食わせるテストが書けることのほうが大事である。
 *
 * ## 終了コードを見ない
 *
 * **`wrangler` の終了コードは「公開しているか」を表していない。**
 * `cors list` は設定が無いとき API の `10059` をそのまま投げ、非ゼロで終わる。
 * つまり**一番安全な状態が、終了コードの上では失敗に見える。**
 * 終了コードだけを見るスクリプトに繋ぐと、`10059` を「確認に失敗した」として
 * 扱うか、逆に「非ゼロ＝何か問題がある」として毎回落ちることになる。
 *
 * そこで**出力の内容で判定する。** 終了コードは参考情報として detail に残す。
 *
 * ## 「閉じている」は名指しでしか認めない
 *
 * 判定は 3 値で、**既知の「閉じている」印が出力にあるときだけ `closed`**
 * とする。印が無ければ `open` か `unknown` であって、`closed` には倒さない。
 *
 * **これは「認証が切れていた」「バケット名を間違えた」「wrangler の文面が
 * 変わった」を、すべて `unknown` 側に落とすためである。** 逆向き（印が
 * 無ければ閉じている扱い）にすると、`wrangler` が将来文面を変えた日から
 * 検査は何も見ずに緑を返し続ける。**それが #88 / #96 / #122 と同じ形**
 * （宣言はあるが発動しない）で、脅威モデル §4.4 に書いたもの。
 *
 * `unknown` は `open` と同じく異常として扱う（`summarize` を見ること）。
 * **「確かめられなかった」を「問題なし」と混ぜない。**
 */

import { stripVTControlCharacters } from "node:util";

/** @typedef {"closed" | "open" | "unknown"} Verdict */
/** @typedef {{ route: string, verdict: Verdict, detail: string }} RouteResult */

/**
 * `wrangler` の 1 回の起動の結果。
 * @typedef {{ stdout?: string, stderr?: string, status?: number | null }} Invocation
 */

/** 3 経路の表示名。レポートの見出しに使う。 */
export const ROUTE_LABELS = {
  devUrl: "r2.dev の公開 URL",
  customDomain: "カスタムドメイン",
  cors: "CORS",
};

/**
 * 判定に使う 1 本の文字列。stdout と stderr を繋ぐ。
 *
 * **色を落としてから渡す。** `wrangler` の表はラベルを `white()`、値を
 * `gray()` で包むので、色が有効だと `domain:` が
 * `\x1b[37mdomain:\x1b[39m` になって行頭の一致が外れる。パイプで受ければ
 * 既定では色は付かないが、CI は `FORCE_COLOR` を立てることがある。
 *
 * 外れたときの判定は `unknown`（＝異常）なので**安全側には倒れる**が、
 * 公開していないのに鳴る検査は、何度か鳴った後で無視される。
 */
function text({ stdout = "", stderr = "" }) {
  return stripVTControlCharacters(`${stdout}\n${stderr}`);
}

/**
 * `closed` とも `open` とも言えなかったときに、人へ見せる 1 行。
 *
 * **素直に最後の行を取ると、`wrangler` のログ出力先が出てくる** ——
 * `🪵  Logs were written to "/Users/…/wrangler-….log"` が必ず末尾に付くので、
 * 「バケットが存在しない」のような**肝心の行が押し出される。**
 * 役に立たない上に、ホームディレクトリのパス（利用者名を含む）が出る。
 *
 * そこで定型の行を落としてから、`[code: NNNNN]` の行を優先して拾う。
 * API が理由を言っているときは、それが一番短くて正確である。
 *
 * **`A request to the Cloudflare API (…) failed.` は落とさない。** 理由は
 * たいてい次の行（`[code:]` のほう）にあるので普段は選ばれないが、
 * **落としてしまうと、理由の行が無いときに何も残らない。** 残すほうを
 * 選んだ結果、この行が出ることはある —— だから下のアカウント ID の
 * 伏せ字が要る。
 *
 * **アカウント ID も落とす。** `wrangler` の API エラーは失敗した URL を
 * そのまま出すので `/accounts/<32 桁>/…` が入る。`CLOUDFLARE_ACCOUNT_ID` は
 * GitHub Secret として置いてあるものなので、こちらの出力経由で平文の
 * ログに出さない。GitHub Actions は Secret と一致する文字列を伏せるが、
 * **手元で走らせたときは誰も伏せない**し、ログを貼って相談するのは
 * 手元で走らせたときである。
 */
const NOISE = [
  /^⛅️?\s*wrangler\s/u, // バージョンのバナー
  /^─+$/u, // バナーの下の罫線
  /^🪵/u, // Logs were written to "…"（ホームのパスが出る）
  /^If you think this is a bug/u,
];

function explain(raw) {
  const lines = raw
    .split("\n")
    .map((line) => line.trim().replace(/^✘\s*\[ERROR\]\s*/u, ""))
    .filter((line) => line.length > 0 && !NOISE.some((pattern) => pattern.test(line)));

  const withCode = lines.find((line) => /\[code: \d+\]/u.test(line));
  const line = withCode ?? lines.at(-1) ?? "(出力が空)";
  return line.replace(/\b[0-9a-f]{32}\b/g, "<account-id>");
}

/**
 * `wrangler r2 bucket dev-url get <bucket>`
 *
 * - 閉: `Public access via the r2.dev URL is disabled.`
 * - 開: `Public access is enabled at 'https://pub-….r2.dev'.`
 *
 * @param {Invocation} invocation
 * @returns {RouteResult}
 */
export function classifyDevUrl(invocation) {
  const raw = text(invocation);
  if (raw.includes("Public access via the r2.dev URL is disabled")) {
    return { route: "devUrl", verdict: "closed", detail: "r2.dev の公開 URL は無効" };
  }
  // 文面に URL が入るので、そこだけ拾って見せる。
  const enabled = raw.match(/Public access (?:is )?enabled at '([^']+)'/);
  if (enabled) {
    return { route: "devUrl", verdict: "open", detail: `公開 URL が有効: ${enabled[1]}` };
  }
  return { route: "devUrl", verdict: "unknown", detail: explain(raw) };
}

/**
 * `wrangler r2 bucket domain list <bucket>`
 *
 * **先頭に必ず `Listing custom domains connected to bucket '…'...` が出る。**
 * この行は閉じているかどうかに関係なく出るので、判定に使わない。
 *
 * - 閉: `There are no custom domains connected to this bucket.`
 * - 開: ドメインごとの表
 *
 * @param {Invocation} invocation
 * @returns {RouteResult}
 */
export function classifyCustomDomains(invocation) {
  const raw = text(invocation);
  if (raw.includes("There are no custom domains connected to this bucket")) {
    return { route: "customDomain", verdict: "closed", detail: "接続されたカスタムドメインは無し" };
  }
  // 表の体裁は wrangler の都合で変わる。`domain:` の行があることだけを見る。
  const domains = [...raw.matchAll(/^\s*domain:\s*(\S+)/gm)].map((m) => m[1]);
  if (domains.length > 0) {
    return {
      route: "customDomain",
      verdict: "open",
      detail: `カスタムドメインが接続されている: ${domains.join(", ")}`,
    };
  }
  return { route: "customDomain", verdict: "unknown", detail: explain(raw) };
}

/**
 * `wrangler r2 bucket cors list <bucket>`
 *
 * **閉じている形が 2 つある。**
 *
 * 1. API が `10059` を返し、`wrangler` が**非ゼロで終わる**
 *    （`The CORS configuration does not exist. [code: 10059]`）。
 *    2026-10-24 の確認で実際に返ったのはこちら
 * 2. API が空の `rules` を返し、`wrangler` が
 *    `There is no CORS configuration defined for bucket '…'.` を出して **0 で終わる**
 *
 * **runbook §12.7 は 1 だけを記録していた**が、`wrangler` のコードには
 * 2 の分岐がある（`getCORSPolicy` は `10059` を捕まえないので、一度も
 * 設定していないバケットは 1、設定して空にしたバケットは 2 になる）。
 * **どちらも「CORS は無い」**なので両方 `closed` にする。
 *
 * 1 を `unknown` にしてしまうと、**正常な状態で検査が毎回鳴る。**
 * 鳴り続ける検査は 2 週間で無視されるので、それは検査が無いのと変わらない。
 *
 * @param {Invocation} invocation
 * @returns {RouteResult}
 */
export function classifyCors(invocation) {
  const raw = text(invocation);
  if (raw.includes("code: 10059")) {
    return { route: "cors", verdict: "closed", detail: "CORS 設定なし（10059）" };
  }
  if (raw.includes("There is no CORS configuration defined for bucket")) {
    return { route: "cors", verdict: "closed", detail: "CORS 設定なし（空の rules）" };
  }
  const origins = [...raw.matchAll(/^\s*allowed_origins:\s*(.+)$/gm)].map((m) => m[1].trim());
  if (origins.length > 0) {
    return {
      route: "cors",
      verdict: "open",
      detail: `CORS が設定されている: ${origins.join(" / ")}`,
    };
  }
  return { route: "cors", verdict: "unknown", detail: explain(raw) };
}

/**
 * 3 経路の結果をまとめる。
 *
 * **`unknown` を `open` と同じ扱いにする。** 「公開していた」と
 * 「確かめられなかった」は原因が違うが、**どちらも『公開していないことを
 * 確認した』とは言えない**という点で同じである。検査としては区別しない。
 *
 * 3 経路のうち 1 つでも閉じていないなら全体として駄目、とする。
 * **1 つ閉じていることは他の 2 つについて何も言わない**（runbook §12.7）。
 *
 * @param {RouteResult[]} results
 */
export function summarize(results) {
  const open = results.filter((r) => r.verdict === "open");
  const unknown = results.filter((r) => r.verdict === "unknown");
  return {
    ok: open.length === 0 && unknown.length === 0,
    open,
    unknown,
    results,
  };
}

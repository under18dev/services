/**
 * wrangler が失敗したときに、**何が起きたかを伝える**（#83 の CLI）。
 *
 * ## なぜ分けてあるか
 *
 * `admin-role.mjs` は `node:child_process` を import するので、
 * **Workers のテスト環境（workerd）からは読めない。** ここは何も import
 * しない純粋な関数だけにしてあり、`test/admin-role-cli.test.ts` が直接呼ぶ。
 *
 * **検査できない場所に判断を置かない。** 元の実装は
 * `throw new Error("wrangler が失敗した (exit " + status + ")")` の 1 行で、
 * **テストの書きようが無かった。**
 *
 * ## 何が起きていたか（実測）
 *
 * `--json` を付けた wrangler は、**エラーを stdout に JSON で書く。
 * stderr は空である。**
 *
 * ```console
 * $ node -e '...spawnSync("npx",["wrangler","d1","execute","does-not-exist-db",
 *            "--local","--json","--command","select 1"],
 *            {stdio:["inherit","pipe","inherit"]})'
 * status = 1
 * stdout = {"error":{"text":"Couldn't find a D1 DB with the name or binding ..."}}
 * stderr = （空）
 * ```
 *
 * CLI 側は `stdio: ["inherit", "pipe", "inherit"]` で **stdout を捕まえ、
 * 失敗したときはそれを捨てて終了コードだけを投げていた。**
 * **stderr は端末へ流れるので「出るはず」に見えるが、そこには何も無い。**
 *
 * 運用者の手元ではこう見えていた。
 *
 * ```console
 * 付与前の状態:
 * エラー: wrangler が失敗した (exit 1)
 * ```
 *
 * **握り潰しているのは終了コードではなく、原因そのものである。**
 */

/** `--json` の失敗応答から、人が読む 1 行を取り出す。読めなければ null。 */
function errorTextOf(stdout: string): string | null {
  const start = stdout.indexOf("{");
  if (start < 0) return null;
  try {
    const parsed = JSON.parse(stdout.slice(start));
    const text = parsed?.error?.text;
    return typeof text === "string" && text !== "" ? text : null;
  } catch {
    return null;
  }
}

/**
 * `--remote` で失敗したときに添える、よくある原因。
 *
 * **wrangler のメッセージに文字列一致していない。** 複数口座の状態を
 * こちらで再現できないので、**出る文言を推測して分岐を書かない** ——
 * 当たらなければ黙るだけで、外れていることに誰も気づけない。
 *
 * 代わりに **`--remote` のときは常に出す。** 外れていても読む人が
 * 「これではない」と判断でき、**当たっているときに確実に届く。**
 *
 * **原因そのものは実機で裏が取れている**（2026-10-30）。`wrangler whoami` に
 * 口座が 2 つ出る環境で、`CLOUDFLARE_ACCOUNT_ID` を前置しただけで付与が
 * 通った。**それでも文字列一致にしないのは、wrangler が将来別の文言を
 * 出しても助言が消えないようにするため。**
 */
const REMOTE_HINTS = [
  "Cloudflare の口座が複数あると、口座を指定しない wrangler は失敗する" +
    "（2026-10-30、複数口座の実機で確認。前置しただけで付与が通った）。",
  "  `npx wrangler whoami` で口座 ID を確かめ、こう渡す:",
  "    CLOUDFLARE_ACCOUNT_ID=<口座 ID> node scripts/admin-role.mjs ...",
  "API トークンの権限不足（D1 の読み書き）でも同じ形で落ちる。",
];

export type WranglerFailure = {
  /** 終了コード。シグナルで落ちたら null。 */
  readonly status: number | null;
  /** 捕まえた stdout。`--json` のときだけ中身がある。 */
  readonly stdout: string | undefined;
  /** `--remote` を付けた呼び出しか。 */
  readonly remote: boolean;
};

/** 失敗のメッセージを組み立てる。 */
export function describeWranglerFailure({ status, stdout, remote }: WranglerFailure): string {
  const lines = [`wrangler が失敗した (exit ${status ?? "signal"})`];
  const captured = (stdout ?? "").trim();

  if (captured === "") {
    // `stdio: "inherit"` の経路。**出力は端末へ直接流れている。**
    // ここで「出力が無い」と書くと、上に出ているものを見落とさせる。
    lines.push("", "wrangler の出力は上に出ている。");
  } else {
    const text = errorTextOf(captured);
    lines.push("", "wrangler の出力:");
    // 読める 1 行があれば先に出す。JSON をそのまま読ませない。
    if (text !== null) lines.push(`  ${text}`, "", "  （生の応答）");
    for (const line of captured.split("\n")) lines.push(`  ${line}`);
  }

  if (remote) {
    lines.push("", "--remote で失敗したときによくある原因:");
    for (const hint of REMOTE_HINTS) lines.push(`  - ${hint}`.replace("-   ", "    "));
  }

  return lines.join("\n");
}

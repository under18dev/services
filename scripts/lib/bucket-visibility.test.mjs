import assert from "node:assert/strict";
import { test } from "node:test";
import {
  classifyCors,
  classifyCustomDomains,
  classifyDevUrl,
  summarize,
} from "./bucket-visibility.mjs";

/**
 * 下の文字列は **2026-10-25 に `u18-identity-archive` へ実際に打って
 * 得たもの**（wrangler 4.152.0）。手で書き起こしたものではない。
 *
 * バナー（`⛅️ wrangler 4.152.0` と罫線）も落とさずに入れてある。
 * **判定が本物の出力に当たることを確かめたいので、整えない。**
 */
const BANNER = "\n ⛅️ wrangler 4.152.0\n────────────────────\n";

// --- r2.dev の公開 URL ------------------------------------------------------

test("dev-url: 無効なら closed", () => {
  const result = classifyDevUrl({
    stdout: `${BANNER}Public access via the r2.dev URL is disabled.\n`,
    status: 0,
  });
  assert.equal(result.verdict, "closed");
});

test("dev-url: 有効なら open。公開 URL を detail に出す", () => {
  const result = classifyDevUrl({
    stdout: `${BANNER}Public access is enabled at 'https://pub-0123456789abcdef.r2.dev'.\n`,
    status: 0,
  });
  assert.equal(result.verdict, "open");
  assert.match(result.detail, /pub-0123456789abcdef\.r2\.dev/);
});

// --- カスタムドメイン -------------------------------------------------------

test("domain list: 接続が無ければ closed", () => {
  const result = classifyCustomDomains({
    stdout:
      `${BANNER}Listing custom domains connected to bucket 'u18-identity-archive'...\n` +
      "There are no custom domains connected to this bucket.\n",
    status: 0,
  });
  assert.equal(result.verdict, "closed");
});

test("domain list: 先頭の Listing… 行だけでは closed にしない", () => {
  // この行は接続があってもなくても必ず出る。**判定に使えない。**
  // 「それらしい行が出ている」で closed にすると、表のほうを読み落とす。
  const result = classifyCustomDomains({
    stdout: `${BANNER}Listing custom domains connected to bucket 'u18-identity-archive'...\n`,
    status: 0,
  });
  assert.equal(result.verdict, "unknown");
});

test("domain list: 接続があれば open。ドメイン名を detail に出す", () => {
  const result = classifyCustomDomains({
    stdout:
      `${BANNER}Listing custom domains connected to bucket 'u18-identity-archive'...\n` +
      "domain:            archive.under18.dev\n" +
      "enabled:           Yes\n" +
      "ownership_status:  verified\n" +
      "ssl_status:        active\n" +
      "min_tls_version:   1.0\n" +
      "zone_id:           0123456789abcdef0123456789abcdef\n" +
      "zone_name:         under18.dev\n",
    status: 0,
  });
  assert.equal(result.verdict, "open");
  assert.match(result.detail, /archive\.under18\.dev/);
});

test("domain list: 色が付いていても読める", () => {
  // wrangler はラベルを white()、値を gray() で包む。CI が FORCE_COLOR を
  // 立てるとパイプでも色が付く。**付いた途端に判定が外れる**のでは困る。
  const result = classifyCustomDomains({
    stdout:
      `${BANNER}\u001b[37mdomain:\u001b[39m  \u001b[90marchive.under18.dev\u001b[39m\n` +
      "\u001b[37menabled:\u001b[39m  \u001b[90mYes\u001b[39m\n",
    status: 0,
  });
  assert.equal(result.verdict, "open");
  assert.match(result.detail, /archive\.under18\.dev/);
});

// --- CORS -------------------------------------------------------------------

test("cors list: 10059 は closed。非ゼロ終了だが一番安全な状態である", () => {
  // 2026-10-25 に実際に返ったもの。exit 1 で、stderr に 10059 が出る。
  // 終了コードだけを見ると「確認に失敗した」と取り違える。
  const result = classifyCors({
    stdout: `${BANNER}Listing CORS rules for bucket 'u18-identity-archive'...\n\n`,
    stderr:
      "\u001b[31m✘ \u001b[41;31m[\u001b[41;97mERROR\u001b[41;31m]\u001b[0m \u001b[1mA request to the Cloudflare API " +
      "(/accounts/0123456789abcdef0123456789abcdef/r2/buckets/u18-identity-archive/cors) failed.\u001b[0m\n\n" +
      "  The CORS configuration does not exist. [code: 10059]\n",
    status: 1,
  });
  assert.equal(result.verdict, "closed");
});

test("cors list: 空の rules も closed", () => {
  // 一度も設定していないバケットは 10059、設定してから空にしたバケットは
  // こちらになる（wrangler の `corsPolicy.length === 0` の分岐）。
  // **どちらも「CORS は無い」。** runbook §12.7 は前者だけを記録していた。
  const result = classifyCors({
    stdout:
      `${BANNER}Listing CORS rules for bucket 'u18-identity-archive'...\n` +
      "There is no CORS configuration defined for bucket 'u18-identity-archive'.\n",
    status: 0,
  });
  assert.equal(result.verdict, "closed");
});

test("cors list: 設定があれば open。許可された origin を detail に出す", () => {
  const result = classifyCors({
    stdout:
      `${BANNER}Listing CORS rules for bucket 'u18-identity-archive'...\n` +
      "allowed_origins:  https://example.com\n" +
      "allowed_methods:  GET\n" +
      "allowed_headers:  (no headers)\n",
    status: 0,
  });
  assert.equal(result.verdict, "open");
  assert.match(result.detail, /https:\/\/example\.com/);
});

// --- 確かめられなかったとき -------------------------------------------------

test("コマンド名を間違えると unknown。closed には倒さない", () => {
  // これも実際に踏んだもの。zsh は引用符の付いた変数を単語分割しないので、
  // `npx wrangler $args` が 1 つの引数として渡り、wrangler がヘルプを
  // 吐いて exit 1 で終わる。**「閉じている印が無い」だけで、出力は
  // バケットについて何も言っていない。**
  const invocation = {
    stdout: "\nwrangler\n\nCOMMANDS\n  wrangler docs [search..]\n",
    stderr:
      "✘ [ERROR] Unknown argument: r2 bucket dev-url get u18-identity-archive\n\n\n" +
      '🪵  Logs were written to "/Users/someone/Library/Preferences/.wrangler/logs/wrangler-2026-10-25_12-34-53_846.log"\n',
    status: 1,
  };
  for (const classify of [classifyDevUrl, classifyCustomDomains, classifyCors]) {
    const result = classify(invocation);
    assert.equal(result.verdict, "unknown");
    // **`[code:]` の行が無いときに footer を落とす側が効く。** 落とさないと
    // detail がログファイルのパスになり、理由が出ない（利用者名も出る）。
    assert.match(result.detail, /Unknown argument/);
    assert.doesNotMatch(result.detail, /Users\/someone/);
  }
});

test("認証が切れていても unknown", () => {
  const invocation = {
    stdout: "",
    stderr: "✘ [ERROR] Authentication error [code: 10000]\n",
    status: 1,
  };
  for (const classify of [classifyDevUrl, classifyCustomDomains, classifyCors]) {
    assert.equal(classify(invocation).verdict, "unknown");
  }
});

test("出力が空でも unknown。exit 0 を closed と読まない", () => {
  // **終了コードは判定に使っていない**ことの確認。wrangler が黙って
  // 0 で終わったら、それは「公開していない」ではなく「分からない」。
  for (const classify of [classifyDevUrl, classifyCustomDomains, classifyCors]) {
    assert.equal(classify({ stdout: "", stderr: "", status: 0 }).verdict, "unknown");
  }
});

test("unknown の detail は、末尾のログ出力先ではなく理由の行を出す", () => {
  // 2026-10-25 に `u18-does-not-exist` へ打って得たもの。**`🪵 Logs were
  // written to …` が必ず末尾に付く**ので、素直に最後の行を取ると
  // 「バケットが存在しない」が押し出され、代わりにホームディレクトリの
  // パス（利用者名を含む）が出る。
  const result = classifyDevUrl({
    stdout: BANNER,
    stderr:
      "✘ [ERROR] A request to the Cloudflare API " +
      "(/accounts/0123456789abcdef0123456789abcdef/r2/buckets/u18-does-not-exist/domains/managed) failed.\n\n" +
      "  The specified bucket does not exist. [code: 10006]\n  \n" +
      "  If you think this is a bug, please open an issue at: https://github.com/cloudflare/workers-sdk/issues/new/choose\n\n\n" +
      '🪵  Logs were written to "/Users/someone/Library/Preferences/.wrangler/logs/wrangler-2026-10-25_12-37-17_191.log"\n',
    status: 1,
  });
  assert.equal(result.verdict, "unknown");
  assert.equal(result.detail, "The specified bucket does not exist. [code: 10006]");
  assert.doesNotMatch(result.detail, /Users\/someone/);
});

test("定型の行が変わっても、[code:] の行を選べる", () => {
  // **この 1 件だけ実物ではなく組み立てたもの。** 上の 10006 の実物は、
  // 定型の行（`If you think this is a bug` と `🪵 Logs were written to`）を
  // 落とすと `[code:]` の行がちょうど最後に来るので、**「最後の行を取る」
  // 実装でも同じ答えになってしまい、何も確かめていない。**
  //
  // 定型の行の文面は wrangler の都合で変わる。変わった日に「最後の行」が
  // footer になる —— そのとき効くのが `[code:]` の優先である。
  // **落とす行を数え上げる側（脆い）と、要る行を名指しする側（強い）を
  // 両方持っている**ことを、ここで固定する。
  const result = classifyDevUrl({
    stdout: BANNER,
    stderr:
      "✘ [ERROR] A request to the Cloudflare API failed.\n\n" +
      "  The specified bucket does not exist. [code: 10006]\n" +
      "  Need help? Ask in the Cloudflare Developers Discord.\n",
    status: 1,
  });
  assert.equal(result.verdict, "unknown");
  assert.equal(result.detail, "The specified bucket does not exist. [code: 10006]");
});

test("detail にアカウント ID を残さない", () => {
  // 理由の行（`[code:]` のほう）が無いときは、失敗した URL の行が残る。
  // その URL には `/accounts/<32 桁>/` が入っている。
  // `CLOUDFLARE_ACCOUNT_ID` は GitHub Secret として置いてあるもの。
  const result = classifyDevUrl({
    stdout: "",
    stderr:
      "✘ [ERROR] A request to the Cloudflare API " +
      "(/accounts/0123456789abcdef0123456789abcdef/r2/buckets/u18-identity-archive/dev-url) failed.",
    status: 1,
  });
  assert.equal(result.verdict, "unknown");
  assert.doesNotMatch(result.detail, /0123456789abcdef0123456789abcdef/);
  assert.match(result.detail, /<account-id>/);
});

// --- まとめ -----------------------------------------------------------------

test("3 経路すべて closed のときだけ ok", () => {
  const closed = (route) => ({ route, verdict: "closed", detail: "" });
  assert.equal(summarize([closed("devUrl"), closed("customDomain"), closed("cors")]).ok, true);
});

test("1 つでも open なら ok ではない", () => {
  // 1 つ閉じていることは他の 2 つについて何も言わない（runbook §12.7）。
  const summary = summarize([
    { route: "devUrl", verdict: "closed", detail: "" },
    { route: "customDomain", verdict: "open", detail: "archive.under18.dev" },
    { route: "cors", verdict: "closed", detail: "" },
  ]);
  assert.equal(summary.ok, false);
  assert.equal(summary.open.length, 1);
});

test("unknown も ok ではない。「確かめられなかった」を「問題なし」と混ぜない", () => {
  const summary = summarize([
    { route: "devUrl", verdict: "closed", detail: "" },
    { route: "customDomain", verdict: "closed", detail: "" },
    { route: "cors", verdict: "unknown", detail: "Authentication error" },
  ]);
  assert.equal(summary.ok, false);
  assert.equal(summary.unknown.length, 1);
});

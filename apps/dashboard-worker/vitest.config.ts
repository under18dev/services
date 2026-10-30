import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

/**
 * dashboard-worker のテスト設定。
 *
 * wrangler.jsonc の `services` が auth-worker (`u18-auth`) を参照しているため、
 * そのままだと workerd が
 *   binding "IDENTITY" refers to a service "core:user:u18-auth",
 *   but no such service is defined
 * で**起動に失敗し、テストが 1 件も走らない**。dashboard-worker に長らく
 * テストが無かったのはこれが理由（#47）。
 *
 * ここでは `u18-auth` という名前のスタブ Worker を補助 Worker として定義し、
 * バインディングの解決だけを通す。テスト本体はこのスタブを呼ばない ——
 * `IdentityGateway` の fake を差した `Env` を `app.fetch()` へ直接渡して、
 * HTTP 層の責務（Cookie 名・Origin 検証・エラー翻訳）だけを検証する。
 *
 * 本物の auth-worker を立てて RPC 越しに繋ぐのは、この Worker 単体の
 * テストではなく統合テスト (`tests/e2e/`) の仕事。
 *
 * `wrangler.jsonc` を**文字列のまま**テストへ渡しているのは、本番 route と
 * `ACCOUNT_BASE_PATH` が一致していることを `test/route-config.test.ts` で
 * 照合するため（#106）。テスト本体は workerd の中で動くので node:fs を
 * 使えず、Node 側であるこのファイルから渡すしかない。JSONC なので
 * `JSON.parse` は通らず、`@u18/testing` の `parseJsonc()` で読む。
 */
/**
 * form POST が CSRF の判定を通っているかを走査する（仕様書 9 CSRF）。
 *
 * **この Worker には form POST がまだ 1 本も無い。** 守る対象が無いうちに
 * 仕組みだけ入れると、**1 本目を書く人が仕組みの存在を知らないまま
 * 素の form を置ける。** 文書に「CSRF を通すこと」と書く形は守られない
 * （`apps/auth-worker/test/helpers.ts` の #253）。走査で落ちる形にする。
 *
 * 見るのは 2 つ。
 *
 * - **form を描いているのに `name={CSRF_FIELD_NAME}` を描いていない**
 * - **本文を読んでいる（`parseBody` / `formData`）のに `isValidCsrf()` を
 *   同じファイルで呼んでいない**
 * - **`rotateCsrfToken()` を GET のハンドラで呼んでいる**（共有側の
 *   「誤用の形」を参照。第三者のページから `<img src>` ひとつで
 *   被害者の CSRF Cookie を回せる）
 *
 * **走ったファイル数も返す。** `src` 側の走査先を書き間違えると、見本側は
 * 緑のまま `src` が 0 件を返し続ける —— **この検査が手当てしたはずの
 * 「0 件で緑」が、守る側にだけ残る形**だった。`src` に `.ts` / `.tsx` が
 * 1 つも無いことは起こりえないので、件数を見れば落ちる。
 *
 * ファイル単位の粗い判定である。同じファイルに 2 つ form があって片方だけ
 * 守られている形は拾えない。**拾えるのは「いちばんありそうな形」までで、
 * それは『1 本目を素で置く』である。**
 *
 * **散文は数えない。** `collectAuditEventNames` と同じ理由で、JSDoc に
 * 例として書いた `<form method="post">` が違反として出てしまう。
 *
 * 走査は Node 側でしかできない（テスト本体は workerd の中で動く）。
 * 照合は `test/form-csrf.test.ts`。
 */
function collectFormCsrfSites(dir: string, root: string): FormCsrfScan {
  const sites: FormCsrfSite[] = [];
  let filesScanned = 0;

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = collectFormCsrfSites(path, root);
      sites.push(...nested.sites);
      filesScanned += nested.filesScanned;
      continue;
    }
    if (!entry.name.endsWith(".ts") && !entry.name.endsWith(".tsx")) continue;
    filesScanned += 1;

    const lines = readFileSync(path, "utf8")
      .split("\n")
      // 散文を除く。JSDoc に例として書いた `<form method="post">` が
      // 違反として出てしまう（`collectAuditEventNames` と同じ理由）。
      .filter((line) => !/^\s*\*/.test(line))
      .map((line) => line.split("//")[0] ?? "");
    const code = lines.join("\n");

    const file = relative(root, path);
    if (/<form[\s>]/.test(code)) {
      // **`CSRF_FIELD_NAME` が出てくるかではなく、描いているかを見る。**
      // import しただけ・別の用途に使っただけで「守られている」と読むと、
      // 検査が一番見つけたい形（hidden input を置き忘れた form）を見逃す。
      sites.push({ file, kind: "render", guarded: /name=\{CSRF_FIELD_NAME\}/.test(code) });
    }
    if (/\.(parseBody|formData)\(/.test(code)) {
      // 同じ理由で、`isValidCsrf` を import しただけでは通さない。
      sites.push({ file, kind: "read", guarded: /isValidCsrf\(/.test(code) });
    }

    // **`rotateCsrfToken` は、どのハンドラの中で呼ぶかで安全性が変わる。**
    // ファイル単位では見分けられないので、直前に現れた経路の動詞を覚えて
    // おく。`meRoutes.get("/me", async (c) => {` という書き方に合わせた
    // 粗い追跡で、**入れ子のコールバックまでは追わない。**
    let enclosing = "";
    for (const line of lines) {
      // **経路の登録だけを拾う。** `c.get("identity")` のような
      // Context の取り出しと区別が要る。
      //
      // **文字列リテラルだけを見ていた時期がある。** この Worker は
      // 経路を `*_ROUTE` の定数で登録しているので、**1 本も一致せず、
      // `enclosing` が空のままだった** —— つまり `rotate` の判定は
      // 「どの経路の中か分からない」＝常に unguarded で、**この Worker
      // には `rotateCsrfToken` の呼び出しが 1 つも無かったから緑だった。**
      // #333 で最初の 1 つが入って初めて分かった（`filesScanned` が
      // 0 件を捕まえるのと同じ形の穴が、ここにも残っていた）。
      //
      // 定数も拾う。`c.get(` と紛れないよう、**`_ROUTE` / `_PATH` で
      // 終わる大文字の識別子**に限る（このリポジトリの命名）。
      const route =
        /\.(get|post|put|patch|delete|all)\(\s*(?:["'`]\/|[A-Z][A-Z0-9_]*_(?:ROUTE|PATH)\b)/.exec(
          line,
        );
      if (route !== null) enclosing = route[1]!;
      // 定義そのものは呼び出しではない。
      if (/function rotateCsrfToken\(/.test(line)) continue;
      if (/rotateCsrfToken\(/.test(line)) {
        sites.push({ file, kind: "rotate", guarded: WRITE_METHODS.has(enclosing) });
      }
    }
  }
  return { sites, filesScanned };
}

/** `rotateCsrfToken` を呼んでよい経路。GET で呼べると CSRF Cookie を回せる。 */
const WRITE_METHODS = new Set(["post", "put", "patch", "delete"]);

type FormCsrfSite = { file: string; kind: "render" | "read" | "rotate"; guarded: boolean };
type FormCsrfScan = { sites: FormCsrfSite[]; filesScanned: number };

const workerRoot = import.meta.dirname;
const formCsrfScan = collectFormCsrfSites(join(workerRoot, "src"), workerRoot);
/**
 * **走査そのものが効いていることを確かめるための見本。**
 *
 * **#333 で `src` 側に form POST が入るまで 0 件だった。** 0 件のあいだは
 * **正規表現を壊しても 0 件のまま緑になる** —— 「違反が無い」と「何も
 * 見ていない」が同じ観測値になる形なので、わざと違反した見本を別に置いて、
 * そちらが拾えることを見る。**実物が入ったいまも見本は残す** ——
 * 実物が守られている限り、やはり違反 0 件だからである。
 */
const formCsrfFixtureScan = collectFormCsrfSites(
  join(workerRoot, "test/fixtures/csrf-scan"),
  workerRoot,
);

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          TEST_WRANGLER_JSONC: readFileSync(join(workerRoot, "wrangler.jsonc"), "utf8"),
          TEST_FORM_CSRF_SITES: formCsrfScan.sites,
          TEST_FORM_CSRF_FILES_SCANNED: formCsrfScan.filesScanned,
          TEST_FORM_CSRF_FIXTURE_SITES: formCsrfFixtureScan.sites,
        },
        workers: [
          {
            // 名前は既定 env の binding (`u18-auth`) に合わせてある。
            // `env.production` は `u18-auth-production` を指すので、production
            // 設定でこのテストを走らせると同じ起動エラーになる。その場合は
            // ここにもう 1 つスタブを足すこと。
            name: "u18-auth",
            modules: true,
            script:
              // 599 と明示的な本文にしてあるのは、テストが誤って fake ではなく
              // 本物の binding を叩いたときに気づけるようにするため。501 だと
              // 「未実装エンドポイント」と読めてしまい、配線ミスに見えない。
              "export default { fetch: () => new Response(" +
              "'stub worker - you meant to inject a fake IdentityRpcContract into app.fetch()'," +
              " { status: 599 }) };" +
              // RPC entrypoint 名も wrangler.jsonc に書かれているので形だけ用意する。
              // **wrangler.jsonc で束縛している Entrypoint は全部要る。**
              // 1 つでも欠けると workerd は "no such named entrypoint" で
              // 起動に失敗し、**テストが 1 件も走らない**（#47 と同じ形）。
              // 管理用は別 Entrypoint に分けてある（#308）。
              "export class IdentityRPC {}" +
              "export class IdentityAdminRPC {}",
          },
        ],
      },
    }),
  ],
  test: {
    // `.tsx` も拾う。JSX を使うテストを `.test.tsx` で置いたときに
    // **1 件も実行されないまま緑になる**のを防ぐ（実際に踏んだ）。
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
  },
});

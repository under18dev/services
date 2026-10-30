import { collectAssetRefs, normalizeAssetHash } from "@u18/web-ui";
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { newCardId } from "@u18/domain";
import { createApp } from "../src/presentation/http/app";
import { DOCS_PATH } from "../src/presentation/http/base-path";
import { DOCS_STYLESHEET_PATH } from "../src/presentation/http/ui/asset-paths";
import { DOCS_ROUTES } from "./route-inventory";
import { ORIGIN, executionContext, identityWith } from "./helpers";

/**
 * カードを受け取った人向けの案内（#358）。
 *
 * ## 何を見ているか
 *
 * **文面が正しいことは機械で言えない。** 「タップすると登録の画面が開く」が
 * 本当かは、`claim.form.test.ts` と `redirect.test.ts` が持っている。
 *
 * ここが見るのは**案内のページとして成立しているか**である ——
 * 認証を要求していないこと、自分のスタイルシートを参照していること、
 * アカウント側へのリンクが**絶対 URL**であること。
 *
 * ## 絶対 URL が効く理由
 *
 * このページは `go.under18.dev` に載っている。相対パスで `/account/nfc` と
 * 書くと**同じホストの中**を指し、`go.under18.dev/*` はホスト全体を受けるので
 * **実際に nfc-worker のカード画面へ届いてしまう。** ところが `__Host-` の
 * セッション Cookie はあちらのホストにしか送られないので、**永久に
 * ログイン画面へ戻る。** 500 にもならず、リンクは「押せるが進めない」になる。
 */

const identity = identityWith({});

async function openDocs(path: string = DOCS_PATH): Promise<Response> {
  return await createApp({ identity }).fetch(
    new Request(`${ORIGIN}${path}`),
    env,
    executionContext(),
  );
}

describe("案内のページ", () => {
  it("Cookie 無しで読める", async () => {
    const response = await openDocs();

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/html");
  });

  it("CSP が付いている", async () => {
    // `go.under18.dev` に HTML を置くのは #358 が初めてなので、
    // **このホストで CSP が効いているかを確かめる場所が他に無い。**
    const csp = (await openDocs()).headers.get("Content-Security-Policy");

    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("style-src 'self'");
  });

  it("JavaScript を読み込まない", async () => {
    // 読むだけのページ。カードの登録も JS 無しで通るので、
    // この案内を読んだ人が JS 無しで詰まる箇所は無い。
    expect(await (await openDocs()).text()).not.toContain("<script");
  });

  it("自分のスタイルシートを参照している", async () => {
    // **配信ルートだけが残った状態**を落とす（`asset-coverage.test.ts` の
    // 案内ページ版）。参照をやめても画面は描かれるので 500 にならない。
    const html = await (await openDocs()).text();
    const seen = new Set(collectAssetRefs(html));

    expect(seen.has(normalizeAssetHash(DOCS_STYLESHEET_PATH))).toBe(true);
  });

  it("カード画面のスタイルシートを借りていない", async () => {
    // **借りても 200 で通る** —— 中身が同じならハッシュも同じで、
    // `go.under18.dev/*` はホスト全体を受ける。#310 で踏んだ形なので、
    // 接頭辞を厳密に持っていることをここで固定する。
    const html = await (await openDocs()).text();

    expect(html).not.toContain("/account/nfc/ui/");
  });

  it("スタイルシートが Cookie 無しで配信される", async () => {
    const response = await openDocs(DOCS_STYLESHEET_PATH);

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/css");
    expect(response.headers.get("Cache-Control")).toContain("immutable");
  });

  it("一覧の DOCS_ROUTES が実パスと対応している", () => {
    // 上の検査は定数を直接使うので、**一覧側が間違っていても 200 になる。**
    expect(DOCS_ROUTES.map((route) => route.path)).toContain(
      normalizeAssetHash(DOCS_STYLESHEET_PATH),
    );
    expect(DOCS_ROUTES.map((route) => route.path)).toContain(DOCS_PATH);
  });

  it("アカウント側へのリンクが絶対 URL になっている", async () => {
    // 相対にすると `go.under18.dev/account/nfc` を指し、`__Host-` の
    // Cookie が届かないので永久にログインへ戻る。
    const html = await (await openDocs()).text();

    expect(html).toContain(`${env.ACCOUNT_ORIGIN}/account/nfc`);
    expect(html).not.toMatch(/href="\/account/);
  });

  it("実装の語を出さない", async () => {
    // 読み手は運営ではない。`claim` / `release` / `status` のような
    // 実装の語をそのまま出さない（#358 の運用者の判断）。
    const html = await (await openDocs()).text();

    for (const word of ["claim", "release", "issued", "disabled", "transferCount"]) {
      expect(html, `実装の語 "${word}" が案内に出ている`).not.toContain(word);
    }
  });

  it("配る側の手順を載せていない", async () => {
    // カードの発行のしかたを公開ページに載せると、叩き方が公開 URL に載る。
    // あちらは `docs/` 直下の Markdown にある。
    const html = await (await openDocs()).text();

    expect(html).not.toContain("/account/nfc/cards");
    expect(html).not.toContain("発行");
  });

  it("キャッシュしてよいが immutable ではない", async () => {
    // 中身は全員に同じで個人情報を含まないので `no-store` は要らない。
    // ただし URL に内容ハッシュが入らないので `immutable` にはしない。
    const cacheControl = (await openDocs()).headers.get("Cache-Control");

    expect(cacheControl).toContain("max-age");
    expect(cacheControl).not.toContain("immutable");
  });

  it("載せているカード ID の例が、本物と同じ形である", async () => {
    // **#382 の運用者の問い合わせ。** 設定する URL を聞かれて
    // `go.under18.dev/c/:cardId` と答えていたので、**`:cardId` をそのまま
    // 焼こうとしていた。** 置き換え後の例を載せたが、**例の形が間違って
    // いると、今度はその形が広まる** —— 実際 18 文字の例が会話に出ていた。
    //
    // **本物の生成器と同じ正規表現で見る。** 例を直すときに長さを
    // 間違えたら、ここが落ちる。
    const html = await (await openDocs()).text();
    const shape = /^nfc_[0-9abcdefghjkmnpqrstvwxyz]{20}$/;

    const examples = [...html.matchAll(/nfc_[0-9a-z]+/g)].map((m) => m[0]);

    // 0 件だと下の `every` が何も確かめずに通る。
    expect(examples.length, "カード ID の例が 1 つも載っていない").toBeGreaterThan(0);
    for (const example of examples) {
      expect(example, `${example} が本物の形と違う`).toMatch(shape);
    }
    // 生成器が実際にその形を作ることも併せて見る（片方だけ直せない形にする）。
    expect(newCardId()).toMatch(shape);
  });

  it("`:cardId` のまま載せていない", async () => {
    // **route の記法であって、焼く値ではない。** 公開ページに出すと、
    // 読んだ人がそのまま焼きうる。
    const html = await (await openDocs()).text();

    expect(html).not.toContain(":cardId");
  });

  it("焼く値そのものを、完成した URL として見せている", async () => {
    const html = await (await openDocs()).text();

    expect(html).toMatch(/https:\/\/go\.under18\.dev\/c\/nfc_[0-9abcdefghjkmnpqrstvwxyz]{20}/);
  });
});

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

/**
 * **form POST は必ず CSRF の判定を通る**（仕様書 9 CSRF）。
 *
 * ## いま守っているものは無い
 *
 * この Worker には form POST が 1 本も無い。**この検査はいま 0 件を見て
 * いる。** それでも入れてあるのは、`app.ts` の `Referrer-Policy` と同じ
 * 判断である —— あちらのコメントはこう書いてある。
 *
 * > **この Worker にはまだ form POST が無いので、いまは壊れていない。**
 * > それでも揃えるのは、無事である理由が「form がまだ無い」ことだけだから
 * > である。
 *
 * 1 本目を書く人が仕組みの存在を知らないまま素の form を置ける状態を
 * 残さない。**文書に「気をつけて」と書く形は守られない**（#253）。
 *
 * ## 0 件を見ている検査はいちばん壊れやすい
 *
 * 正規表現を壊しても 0 件のまま緑になる —— **「違反が無い」と「何も
 * 見ていない」が同じ観測値になる。** なので `test/fixtures/csrf-scan/` に
 * わざと違反した見本を置き、**そちらが拾えること**を先に確かめる。
 */

type FormCsrfSite = { readonly file: string; readonly kind: string; readonly guarded: boolean };

const testEnv = env as unknown as {
  TEST_FORM_CSRF_SITES: FormCsrfSite[];
  TEST_FORM_CSRF_FILES_SCANNED: number;
  TEST_FORM_CSRF_FIXTURE_SITES: FormCsrfSite[];
};

const sites = [...testEnv.TEST_FORM_CSRF_SITES];
const filesScanned = testEnv.TEST_FORM_CSRF_FILES_SCANNED;
const fixtures = [...testEnv.TEST_FORM_CSRF_FIXTURE_SITES];

const describeSite = (site: FormCsrfSite): string =>
  `${site.file} (${site.kind}) ${site.guarded ? "guarded" : "unguarded"}`;

describe("走査そのものが効いている", () => {
  it("見本を 1 件ずつ、守られているかまで見分ける", () => {
    expect(fixtures.map(describeSite).sort()).toEqual([
      "test/fixtures/csrf-scan/guarded-form.tsx (render) guarded",
      "test/fixtures/csrf-scan/import-only-reader.ts (read) unguarded",
      "test/fixtures/csrf-scan/rotate-in-get.ts (rotate) guarded",
      "test/fixtures/csrf-scan/rotate-in-get.ts (rotate) unguarded",
      "test/fixtures/csrf-scan/unguarded-form.tsx (render) unguarded",
      "test/fixtures/csrf-scan/unguarded-reader.ts (read) unguarded",
    ]);
  });
});

describe("src の form POST", () => {
  it("走査が実際にファイルを読んでいる", () => {
    // **見本が緑でも、`src` 側の走査先を書き間違えれば 0 件が返る。**
    // 見本と `src` は別の呼び出しなので、正規表現を直しても守る側には
    // 届かない —— この検査が手当てしたはずの「0 件で緑」が、守る側にだけ
    // 残っていた。`src` に `.ts` / `.tsx` が 1 つも無いことは起こりえない。
    expect(filesScanned, "src を 1 ファイルも読んでいない（走査先が違う）").toBeGreaterThan(0);
  });

  it("判定を通っていないものが無い", () => {
    const unguarded = sites
      .filter((site) => !site.guarded)
      .map(describeSite)
      .sort();

    // **件数そのものは固定しない。** form が増えること自体は正しい変化で、
    // 数を固定すると、増やした人がこのテストを「邪魔だから」直す。
    // 何を見たかは失敗したときに読めればよいので、メッセージに入れる。
    expect(
      unguarded,
      `CSRF の判定を通っていない form / 本文読み / rotate（該当 ${sites.length} 件 / 読んだファイル ${filesScanned} 件）`,
    ).toEqual([]);
  });
});

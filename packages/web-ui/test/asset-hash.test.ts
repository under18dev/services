import { describe, expect, it } from "vitest";
import {
  assetHash,
  collectAssetRefs,
  hashedFileName,
  IMMUTABLE_ASSET_CACHE_CONTROL,
  normalizeAssetHash,
} from "../src/asset-hash";

/**
 * アセットの内容ハッシュ（#211）。
 *
 * ここが守っているのは 1 つだけ —— **中身が変われば値が変わる。**
 * それが崩れると、`immutable` で配信しているアセットが**内容を変えても
 * 同じ URL のまま**になり、ブラウザが古いものを 1 年持ち続ける。
 * #211 で消したはずの窓が、5 分どころではない長さで戻る。
 */
describe("assetHash", () => {
  it("同じ内容からは同じ値", () => {
    expect(assetHash("body { color: red }")).toBe(assetHash("body { color: red }"));
  });

  it("1 文字違えば違う値", () => {
    expect(assetHash("body { color: red }")).not.toBe(assetHash("body { color: red; }"));
  });

  it("空文字でも値が出る", () => {
    // 生成が走らず空のバンドルになった場合でも落ちないこと。
    // **空であること自体は別の検査が見る**（dashboard の ui-island.test.ts）。
    expect(assetHash("")).toMatch(/^[0-9a-f]{16}$/);
  });

  it("長さだけが違う内容を区別する", () => {
    // FNV-1a は 1 本だと末尾の違いに弱い場面がある。2 本回している
    // 意味がここに出る。
    expect(assetHash("a")).not.toBe(assetHash("aa"));
    expect(assetHash("ab")).not.toBe(assetHash("ba"));
  });

  it("16 進 16 文字", () => {
    expect(assetHash("anything")).toMatch(/^[0-9a-f]{16}$/);
  });

  it("よく似た内容どうしでぶつからない", () => {
    // 実際のアセットは「1 行だけ違う」形で変わる。その範囲で衝突しない
    // ことを、総当たりで見ておく。
    const values = new Set<string>();
    for (let i = 0; i < 2000; i += 1) {
      values.add(assetHash(`.cls-${i} { color: #00000${i % 10} }`));
    }
    expect(values.size).toBe(2000);
  });
});

describe("hashedFileName", () => {
  it("拡張子の前に入れる", () => {
    // **末尾に付けない。** Content-Type を拡張子で決めている経路が
    // 別の型だと思う。
    expect(hashedFileName("u18.css", "x")).toMatch(/^u18\.[0-9a-f]{16}\.css$/);
  });

  it("中身が変われば名前が変わる", () => {
    expect(hashedFileName("u18.css", "a")).not.toBe(hashedFileName("u18.css", "b"));
  });

  it("名前が変われば名前が変わる", () => {
    expect(hashedFileName("a.js", "x")).not.toBe(hashedFileName("b.js", "x"));
  });

  it("拡張子が無ければ末尾に付ける", () => {
    expect(hashedFileName("LICENSE", "x")).toMatch(/^LICENSE\.[0-9a-f]{16}$/);
  });

  it("先頭のドットは拡張子として扱わない", () => {
    // `.htaccess` のような名前で `.<hash>htaccess` にしない。
    expect(hashedFileName(".htaccess", "x")).toMatch(/^\.htaccess\.[0-9a-f]{16}$/);
  });
});

describe("IMMUTABLE_ASSET_CACHE_CONTROL", () => {
  it("immutable が入っている", () => {
    // **これが落ちたら、再検証の往復が戻っている。** URL にハッシュが
    // 入っている以上、条件付き要求を飛ばす理由が無い。
    expect(IMMUTABLE_ASSET_CACHE_CONTROL).toContain("immutable");
    expect(IMMUTABLE_ASSET_CACHE_CONTROL).toContain("public");
  });
});

describe("normalizeAssetHash", () => {
  it("ハッシュの塊だけを伏せる", () => {
    expect(normalizeAssetHash("/account/ui/u18.592e97128030c640.css")).toBe(
      "/account/ui/u18.<hash>.css",
    );
  });

  it("接頭辞は消さない", () => {
    // **借用の検査（smoke-asset-probe.sh）がここを見ている。**
    // `/account/ui/` と `/ui/` が同じになると、隣から借りていても通る。
    expect(normalizeAssetHash("/ui/u18.592e97128030c640.css")).toBe("/ui/u18.<hash>.css");
    expect(normalizeAssetHash("/account/nfc/ui/u18.592e97128030c640.css")).toBe(
      "/account/nfc/ui/u18.<hash>.css",
    );
  });

  it("桁数が違うものは伏せない", () => {
    expect(normalizeAssetHash("/ui/u18.592e9712.css")).toBe("/ui/u18.592e9712.css");
  });

  it("実際に生成したハッシュを伏せられる", () => {
    // **桁数を直書きしていないことの確認。** `assetHash` を変えても、
    // このテストは直さなくても通り続ける。
    const name = hashedFileName("u18.css", "body { color: red }");
    expect(normalizeAssetHash(`/ui/${name}`)).toBe("/ui/u18.<hash>.css");
  });
});

describe("collectAssetRefs", () => {
  it("href と src の両方を拾い、重複を畳む", () => {
    const html =
      '<link rel="stylesheet" href="/account/ui/u18.592e97128030c640.css"/>' +
      '<script src="/account/ui/account-island.7905200446a6b1ba.js"></script>' +
      '<link href="/account/ui/u18.592e97128030c640.css"/>';
    expect(collectAssetRefs(html)).toEqual([
      "/account/ui/account-island.<hash>.js",
      "/account/ui/u18.<hash>.css",
    ]);
  });

  it("アセット以外のリンクは拾わない", () => {
    // 絞らないと「参照されている」が常に真になる。
    const html =
      '<a href="/login?return_to=%2Faccount">ログイン</a><a href="/account/sessions">端末</a>';
    expect(collectAssetRefs(html)).toEqual([]);
  });
});

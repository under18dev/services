import { describe, expect, it } from "vitest";
import { createApp } from "../src/presentation/http/app";
import { EXPECTED_ROUTES } from "./route-inventory";

/**
 * 登録されているルートが `route-inventory.ts` の一覧と一致すること。
 *
 * **これが落ちたら、まず一覧のほうを直す。** そのうえで
 * `client-type.test-d.ts` が落ちるなら、足したルートがチェーンに
 * 乗っていない（= `hono/client` から引けない）という意味である。
 * 意図の説明は `route-inventory.ts` を参照。
 */
describe("ルートの一覧", () => {
  // `ALL /*` はミドルウェア。ここで見たいのはエンドポイントだけ。
  //
  // **重複を畳んでから比べる。** Hono は `.get(path, middleware, handler)` の
  // ようにハンドラを複数渡すと `app.routes` へ同じ method+path を**ハンドラの
  // 数だけ**積む。画面のルートは CSP ミドルウェアを引数で渡しているので
  // 2 行ずつ出る（実測）。
  //
  // **以前ここに「同じルートを 2 回登録していない」という検査を置いていたが、
  // 消した。** `app.routes` からは「ハンドラ 2 つの 1 ルート」と「同じルートを
  // 2 回登録」が区別できず、正当な書き方を誤検出するだけだった。
  // 二重登録を捕まえたいなら、`app.routes` とは別の面が要る。
  /**
   * アセットの URL には内容ハッシュが入る（#211）。手で書けないので、
   * 一覧側は `<hash>` と書いてある。**16 進 16 文字の塊だけを伏せる**ので、
   * ハッシュが入らなくなればここで一致しなくなる。
   */
  const normalize = (path: string): string => path.replace(/\.[0-9a-f]{16}\./g, ".<hash>.");

  const actual = [
    ...new Set(
      createApp()
        .routes.filter((route) => route.method !== "ALL")
        .map((route) => `${route.method} ${normalize(route.path)}`),
    ),
  ];

  const expected = EXPECTED_ROUTES.map((route) => `${route.method} ${route.path}`);

  it("一覧に無いルートが登録されていない", () => {
    // 足したのに一覧へ書いていないと、ここで止まる。
    expect(actual.filter((route) => !expected.includes(route))).toEqual([]);
  });

  it("一覧にあるルートがすべて登録されている", () => {
    // 消したのに一覧へ残っていると、ここで止まる。
    expect(expected.filter((route) => !actual.includes(route))).toEqual([]);
  });
});

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/presentation/http/app";
import { ORIGIN, executionContext } from "./helpers";

/**
 * `AUTH_ORIGIN` binding が、本物の `fetcher` の代わりになることを
 * 確かめる（#439）。
 *
 * ## 他のテストとは違い、`fetcher` を上書きしない
 *
 * **`app.test.ts` を含む全テストは `ContainerOverrides.fetcher` に
 * `fake-idp.ts` の fake を差している。** それ自体は正しい（本物の
 * HTTP を叩かずにロジックを検査できる）が、**`createContainer()` が
 * 既定で使う経路（`AUTH_ORIGIN` binding）を 1 度も通らない**という
 * 意味でもある——本番障害（discovery が 522 で落ちた）は、まさに
 * その「既定の経路」で起きた。
 *
 * ここでは overrides を何も渡さず、`vitest.config.ts` が用意した
 * `u18-auth` スタブ（`.well-known/*` に本物に近い応答を返す）だけを
 * 頼りに `/login` を通す。**discovery と jwks は `DiscoveryCache.get()`
 * が 1 回の呼び出しでまとめて取りに行く**ので、`/login` が通れば
 * 両方とも binding 経由で取れたことになる。
 *
 * token 交換（`POST /oauth/token`）は同じ `fetcher` を通るが、
 * 実際のトークン発行までは検証しない——**POST がそのまま binding へ
 * 届くこと**だけを 2 本目のテストで直接見る（`GET` と `POST` で
 * binding の届き方が変わる理由は無いはずだが、起きたことを実測で
 * 固定する）。
 */
describe("AUTH_ORIGIN binding", () => {
  it("GET /login が、本物の fetch ではなく AUTH_ORIGIN 経由で discovery を取り、認可エンドポイントへ 302 する", async () => {
    const app = createApp();

    const response = await app.fetch(new Request(`${ORIGIN}/login`), env, executionContext());

    expect(response.status, "discovery の取得に失敗した（本文を参照）").toBe(302);
    const location = new URL(response.headers.get("Location") ?? "");
    expect(location.origin + location.pathname).toBe(
      env.TEST_AUTH_ORIGIN_DISCOVERY.authorization_endpoint,
    );
  });

  it("container.fetcher（既定、上書き無し）で POST しても、AUTH_ORIGIN の binding へ届く", async () => {
    // **`createContainer` を直接呼ぶ。** HTTP 層を経由せず、
    // 「既定の fetcher が実際に何に繋がっているか」だけを見る——
    // 本物の fetch のままなら本番と同じくネットワークへ出ようとして
    // 失敗するはずで、binding 経由なら必ず何らかの Response が返る。
    const { createContainer } = await import("../src/composition/container");
    const container = createContainer(env);

    const response = await container.fetcher(env.TEST_AUTH_ORIGIN_DISCOVERY.token_endpoint, {
      method: "POST",
      body: "grant_type=authorization_code",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });

    // スタブは `.well-known/*` 以外に 599 を返す（本物の fake を
    // 差し忘れたテストに気づけるようにするための値）。ここではその
    // 599 自体が欲しい——**例外にならず、HTTP 応答として戻ってきた**
    // ことが、POST も binding へ届いている証拠である。
    expect(response.status).toBe(599);
  });
});

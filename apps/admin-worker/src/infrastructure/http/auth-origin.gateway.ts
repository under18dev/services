/**
 * `AUTH_ORIGIN` binding（`entrypoint` 無しの Service Binding）を
 * `typeof fetch` として見る（#439）。
 *
 * **以前はここが本物の `fetch` だった。** `container.ts` の `fetcher` は
 * discovery / JWKS 取得（`oidc/discovery.ts`）と token 交換
 * （`oidc/token-exchange.ts`）の両方で使われており、`https://auth.under18.dev/...`
 * を直接叩いていた。本番でこれが 522 で落ちた——Cloudflare が、
 * 同一アカウント・同一ゾーンへの Worker 発サブリクエストをループ防止の
 * ため discard prefix（`100::`）へ流す挙動に当たったため。外から直接
 * 叩けば 200 だった——**壊れるのは Worker 発のサブリクエストだけ**。
 *
 * **Service Binding はゾーンのルーティングを経由しない**ので、この
 * 種の失敗が起こらない。`fetcher` の中身をこの binding 経由に差し替える
 * だけで、呼び出し側（`discovery.ts` / `token-exchange.ts`）は 1 行も
 * 変えずに済む——どちらも「`typeof fetch` を受け取る」という形で
 * 書いてあったのがここで効く。
 */
export function asFetcher(binding: Fetcher): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) =>
    binding.fetch(input as Parameters<Fetcher["fetch"]>[0], init)) as typeof fetch;
}

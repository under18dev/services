import { join } from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { exportJWK, generateKeyPair } from "jose";
import { defineConfig } from "vitest/config";

/**
 * admin-worker のテスト設定。
 *
 * **Service Binding のスタブが要る**（#382 / #390 決定 16 ③）。
 * `wrangler.jsonc` に `NFC_ADMIN_DELEGATED`（nfc-worker の
 * `NfcAdminDelegatedRPC`）・`IDENTITY_ADMIN_DELEGATED`（auth-worker の
 * `IdentityAdminDelegatedRPC`）・`AUTH_ORIGIN`（auth-worker の公開 HTTP、
 * `entrypoint` 無し、#439）の 3 本を持つ——**`IdentityRPC` /
 * `IdentityAdminRPC`（sessionToken 必須の dashboard-worker 向け契約）は
 * 依然として持たない**（運用者の判断、2026-10-30 夜）。テストでは本物の
 * nfc-worker / auth-worker を立てず、`ContainerOverrides.nfcCards` /
 * `ContainerOverrides.identityAdmin` に fake を差す
 * （`test/nfc.routes.test.ts` / `test/clients.routes.test.ts`）——
 * それでも `wrangler.jsonc` が宣言した Entrypoint 名が無いと workerd が起動に
 * 失敗する（#47 と同じ形）ので、スタブだけは要る。
 *
 * **`u18-auth` スタブの `fetch` ハンドラだけ、`.well-known/*` に本物に
 * 近い応答を返す**（#439）。他のテストは `ContainerOverrides.fetcher` に
 * `fake-idp.ts` の fake を差すので、この応答が使われることはない——
 * ただし `test/auth-origin.test.ts` だけは **何も上書きせず**、
 * `AUTH_ORIGIN` binding が実際に discovery を取ってこられることを
 * 確かめる。`.well-known/*` 以外は従来どおり 599 のままにしてあるので、
 * 他のテストが誤って本物の binding を叩いたときに気づける性質は失っていない。
 */
const migrations = await readD1Migrations(
  join(import.meta.dirname, "../../packages/admin-db/drizzle"),
);

/**
 * `u18-auth` スタブの `.well-known/*` に使う、本物と同じ形の鍵・応答。
 * Node 側（vitest.config.ts は Node で評価される）で 1 度だけ作り、
 * workerd 側のスタブスクリプトへは**静的な JSON として**埋め込む——
 * スタブ自身は何も署名しない、ただの固定応答である。
 */
const STUB_ISSUER = "http://localhost:8787";
const stubKeyPair = await generateKeyPair("ES256", { extractable: true });
const stubPublicJwk = await exportJWK(stubKeyPair.publicKey);
const STUB_KID = "test-auth-origin-key-1";
const stubDiscoveryDoc = {
  issuer: STUB_ISSUER,
  authorization_endpoint: `${STUB_ISSUER}/oauth/authorize`,
  token_endpoint: `${STUB_ISSUER}/oauth/token`,
  jwks_uri: `${STUB_ISSUER}/.well-known/jwks.json`,
};
const stubJwks = { keys: [{ ...stubPublicJwk, kid: STUB_KID, alg: "ES256", use: "sig" }] };

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        d1Databases: ["ADMIN_DB"],
        bindings: {
          TEST_MIGRATIONS: migrations,
          SESSION_SECRET: "test-session-secret-at-least-32-bytes!!",
          OIDC_CLIENT_SECRET: "test-client-secret",
          // `test/auth-origin.test.ts` だけが読む。`u18-auth` スタブが
          // 実際に返す値と同じものを、テスト側のアサーションに使う
          // ——2 箇所に書き写すと、どちらかだけ変えたときに検査が
          // 何も見ていない状態になる。
          TEST_AUTH_ORIGIN_DISCOVERY: stubDiscoveryDoc,
        },
        workers: [
          {
            // 名前は既定 env の binding（`u18-nfc`）に合わせてある。
            // `env.production` は `u18-nfc-production` を指すので、
            // production 設定でこのテストを走らせると同じ起動エラーに
            // なる。その場合はここにもう 1 つスタブを足すこと
            // （dashboard-worker の同名ファイルと同じ注意）。
            name: "u18-nfc",
            modules: true,
            script:
              // 599 にしているのは、テストが誤って fake ではなく本物の
              // binding を叩いたときに気づけるようにするため
              // （dashboard-worker の `u18-auth` スタブと同じ理由）。
              "export default { fetch: () => new Response(" +
              "'stub worker - you meant to inject a fake NfcAdminDelegatedRpcContract into createApp()'," +
              " { status: 599 }) };" +
              "export class NfcAdminDelegatedRPC {}",
          },
          {
            // 名前は既定 env の binding（`u18-auth`）に合わせてある。
            // `env.production` は `u18-auth-production` を指すので、
            // 上の `u18-nfc` と同じ注意が当てはまる。
            //
            // **`fetch` ハンドラは `AUTH_ORIGIN`（#439）が束縛する側**で、
            // `IdentityAdminDelegatedRPC` は別の binding
            // （`IDENTITY_ADMIN_DELEGATED`）が束縛する側——同じ Worker
            // 名を指しているだけで、呼び出し元から見える形はまったく別。
            name: "u18-auth",
            modules: true,
            script:
              `const DISCOVERY = ${JSON.stringify(stubDiscoveryDoc)};` +
              `const JWKS = ${JSON.stringify(stubJwks)};` +
              "export default { fetch: (request) => {" +
              "  const url = new URL(request.url);" +
              "  if (url.pathname === '/.well-known/openid-configuration') {" +
              "    return new Response(JSON.stringify(DISCOVERY), { status: 200 });" +
              "  }" +
              "  if (url.pathname === '/.well-known/jwks.json') {" +
              "    return new Response(JSON.stringify(JWKS), { status: 200 });" +
              "  }" +
              // 599 にしているのは、テストが誤って fake ではなく本物の
              // binding を叩いたときに気づけるようにするため。
              "  return new Response(" +
              "    'stub worker - you meant to inject a fake IdentityAdminDelegatedRpcContract into createApp()'," +
              "    { status: 599 }," +
              "  );" +
              "} };" +
              "export class IdentityAdminDelegatedRPC {}",
          },
        ],
      },
    }),
  ],
  test: {
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
    setupFiles: ["./test/setup.ts"],
  },
});

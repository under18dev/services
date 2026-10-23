import { createApp } from "./presentation/http/app";

export { IdentityRPC } from "./presentation/rpc/identity.entrypoint";

/**
 * auth-worker のエントリポイント。
 *
 * 公開 HTTP（OIDC + アカウント API）と、Service Binding 経由の内部 RPC
 * （`IdentityRPC` の named export）の 2 つの入口を持つ（仕様書 2.1）。
 */
const app = createApp();

export default app satisfies ExportedHandler<Env>;

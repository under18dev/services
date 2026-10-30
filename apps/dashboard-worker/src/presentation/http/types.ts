import type { IdentityAdminGateway, IdentityGateway } from "../../application/ports";

/**
 * Hono アプリの型パラメータ。
 *
 * `app.ts` ではなくここに置く。ルートやヘルパーが `app.ts` を import すると
 * `app.ts` -> routes -> `app.ts` の循環になるため（auth-worker と同じ理由）。
 */
export type AppBindings = {
  Bindings: Env;
  Variables: { identity: IdentityGateway; identityAdmin: IdentityAdminGateway };
};

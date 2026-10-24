import type { Container } from "../../composition/container";

/**
 * Hono アプリの型パラメータ。
 *
 * app.ts ではなくここに置く。ルートやヘルパーが app.ts を import すると
 * app.ts -> routes -> app.ts の循環になるため。
 */
export type AppBindings = {
  Bindings: Env;
  Variables: {
    container: Container;
  };
};

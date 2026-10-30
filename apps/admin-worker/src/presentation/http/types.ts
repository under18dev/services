import type { Container } from "../../composition/container";
import type { SessionPayload } from "../../oidc/session";

export type AppBindings = {
  Bindings: Env;
  Variables: {
    container: Container;
    /** セッションガード（`app.ts`）が検証済みのセッションを置く。保護対象の経路でだけ値が入る。 */
    session: SessionPayload;
  };
};

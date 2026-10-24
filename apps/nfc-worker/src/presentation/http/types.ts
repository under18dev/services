import type { Container } from "../../composition/container";

/**
 * Hono に渡す型。
 *
 * `container` はリクエストごとにミドルウェアが詰める。ルートハンドラが
 * `env` から直接具象実装を組み立てないようにするための置き場で、
 * これがあるおかげで「`Env` を読んでよいのは composition だけ」が守れる。
 */
export type AppBindings = {
  Bindings: Env;
  Variables: { container: Container };
};

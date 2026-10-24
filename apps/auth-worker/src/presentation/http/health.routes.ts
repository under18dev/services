import { Hono } from "hono";
import type { SigningKeyHealth } from "../../domain/services/signing-key-rotation";
import type { AppBindings } from "./types";

export const healthRoutes = new Hono<AppBindings>();

/**
 * 死活監視。
 *
 * D1 へ到達できるかまで確かめる。Worker が起動しているだけでは認証は
 * 成立しないため、バインディングの疎通を含めて 1 つの指標にする。
 * DB へのアクセスは Port 越しに行い、Presentation から Drizzle を触らない。
 *
 * ## ステータスを決めるのは `checks.database` だけ
 *
 * `checks` に項目を足しても、**HTTP ステータスの根拠は増やさない。**
 * 署名鍵の検査を足したのは「不一致に誰も気づかない」を埋めるためで
 * （docs/runbook.md 4.1 制約 3）、監視を鳴らすためではない。鍵の入れ替え中は
 * 一時的に `/health` から見て不揃いになるが、**それは監視が鳴ると一番困る
 * 瞬間**である。経緯と、この分離が無いと何が起きるかは runbook 4.4。
 *
 * 新しい検査を足すときも同じ。ステータスに効かせてよいのは
 * 「Worker が要求を処理できない」ことだけにする。
 */
healthRoutes.get("/health", async (c) => {
  const container = c.get("container");
  const startedAt = Date.now();

  // どちらの Port も「投げない」契約だが、/health が 500 を返したら
  // 死活監視として役に立たない。契約違反を値へ畳んでおく。
  const [database, signingKey] = await Promise.allSettled([
    container.services.databaseProbe.ping(),
    container.services.signingKeys.checkHealth(),
  ]);

  const reachable = database.status === "fulfilled" && database.value;
  const signingKeyState: SigningKeyHealth =
    signingKey.status === "fulfilled" ? signingKey.value : "unavailable";

  const body = {
    status: reachable ? ("ok" as const) : ("degraded" as const),
    service: "u18-auth",
    environment: c.env.ENVIRONMENT,
    issuer: c.env.ISSUER,
    checks: {
      database: reachable ? ("ok" as const) : ("unreachable" as const),
      // kid は出さない。外から鍵の識別子が見えて得られるものが無い。
      signingKey: signingKeyState,
    },
    latencyMs: Date.now() - startedAt,
    time: container.clock.now().toISOString(),
  };

  return c.json(body, reachable ? 200 : 503);
});

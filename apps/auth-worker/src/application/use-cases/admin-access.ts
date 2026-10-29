import type { Session } from "../../domain/entities/session";
import type { AuditEventName, AuditLogger } from "../ports/audit-log.port";
import type { GetSessionUseCase } from "./get-session.use-case";
import { settleSideEffects } from "./side-effects";
import { err, ok, type UseCaseResult } from "./types";

export type AdminSession = {
  readonly session: Session;
  readonly userId: string;
};

export type AdminAccessDeps = {
  readonly getSession: GetSessionUseCase;
  readonly audit: AuditLogger;
};

/**
 * 管理者のセッションであることを確かめる（#308 / 仕様書 §14.1 決定 8）。
 *
 * ## なぜ UseCase 側に置くか
 *
 * **Presentation 層のガードだけに頼らない。** auth-worker のアカウント API は
 * 入口が 2 つある（公開 HTTP と Service Binding 越しの RPC）。このリポジトリで
 * 繰り返している壊れ方は「実装は正しいが、その実装を呼ぶ経路が無い／
 * 迂回される」で、**最もありそうな次の形は「管理者判定が HTTP の
 * ミドルウェアにあって RPC が素通りする」**である（`test/rpc-parity.test.ts`）。
 * 判定を UseCase の中へ置けば、入口が増えても同じに効く。
 *
 * `isAdmin` は auth-worker が D1 を見て決めた値で、呼び出し元の申告ではない
 * （`caller` と違って認可の判断に使ってよい。仕様書 §14.1 決定 12）。
 *
 * ## 管理者でない場合は「存在しない」と答える
 *
 * `forbidden` を返すと、**管理機能が存在すること自体**を一般利用者に
 * 教える。「権限がありません」と「そんな機能はありません」を区別しないのは、
 * `RevokeSessionUseCase` が他人のセッションと存在しないセッションを
 * 同一視しているのと同じ判断である。
 *
 * ## 拒否は監査ログに残す
 *
 * 応答を畳む以上、**管理機能を叩こうとした事実はここにしか残らない。**
 * 画面にも呼び出し元 Worker にも痕跡が無いので、記録を落とすと
 * 「誰かが管理領域を探った」が完全に見えなくなる。
 *
 * @param event 拒否をどのイベント名で残すか。`null` を渡すと記録しない
 *   （読み取りだけの経路。`ListOAuthClientsUseCase` のコメントを参照）。
 */
export async function requireAdminSession(
  deps: AdminAccessDeps,
  sessionToken: string,
  event: AuditEventName | null,
): Promise<UseCaseResult<AdminSession>> {
  const auth = await deps.getSession.execute({ sessionToken });
  if (!auth.ok) return auth;
  if (auth.value === null) return err("unauthenticated", "session is not valid");

  if (!auth.value.isAdmin) {
    if (event !== null) {
      await settleSideEffects(
        event,
        deps.audit.record({
          event,
          userId: auth.value.userId,
          outcome: "failure",
          reason: "not_admin",
        }),
      );
    }
    return err("not_found", "no such resource");
  }

  return ok({ session: auth.value.session, userId: auth.value.userId });
}

import type { Session } from "../../domain/entities/session";
import type { AuditEventName } from "../ports/audit-log.port";
import type { UserRepository } from "../ports/user.repository";
import type { GetSessionUseCase } from "./get-session.use-case";
import { err, ok, type UseCaseResult } from "./types";

export type AdminSession = {
  readonly session: Session;
  readonly userId: string;
};

export type AdminAccessDeps = {
  readonly getSession: GetSessionUseCase;
};

/** 拒否のログに出す操作名。呼び出し側がリテラルで渡す（外から来た文字列を入れない）。 */
export type AdminOperation =
  | "listOAuthClients"
  | "createOAuthClient"
  | "disableOAuthClient"
  | "listUsers"
  | "suspendUser"
  | "reinstateUser"
  | "revokeUserSessions"
  | "listAuditLogs";

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
 * ## 拒否は `audit_logs` に書かず、Workers のログへ出す
 *
 * **ここで D1 へ INSERT すると、認証済みの相手が書き込みを誘発できる。**
 * RPC 経路にレート制限は 1 つも無いので、有効なセッションを持つ相手は
 * `createOAuthClient` を呼び続けるだけで `audit_logs` の行を好きなだけ
 * 増やせる。しかも区分は `security`（2 年）なので、掃除でも減らない。
 * これは `rate_limit.exceeded` と `csrf.rejected` を `audit_logs` に
 * 書かない理由（#21 / `presentation/http/rate-limit.ts`）とまったく同じ
 * 構図で、**弾くこと自体を攻撃者が D1 への書き込みに変換できる形**である。
 *
 * **記録そのものは落とさない。** 応答は `not_found` に畳むので、拒否は
 * 画面にも呼び出し元 Worker にも現れない —— どこにも残さないと
 * 「誰かが管理領域を探った」が完全に見えなくなる。observability へ
 * 構造化して出し、保持はそちらの期間に従う（ランブック §13.5）。
 * **「今まさに起きている」ことを見るための情報**で、半年後に遡る種類の
 * ものではない。
 *
 * **何を登録しようとしたか（`client_id` など）は出さない。** あれは
 * 呼び出し元が自由に決める文字列で、ログに入れると攻撃者がログの中身を
 * 決められる（監査ログの `metadata` に秘密を入れないのと同じ発想で、
 * **信用できない入力を記録へ流さない**）。残すのは「誰が」「どの操作を」
 * までで、調査にはそれで足りる。
 *
 * 一方、**管理者まで通った後の失敗（再認証切れ・不正な `redirect_uri`・
 * 重複）は `audit_logs` に残す。** あれを起こせるのは管理者だけなので、
 * 件数は管理者の数で頭打ちになる。
 */
export async function requireAdminSession(
  deps: AdminAccessDeps,
  sessionToken: string,
  operation: AdminOperation,
): Promise<UseCaseResult<AdminSession>> {
  const auth = await deps.getSession.execute({ sessionToken });
  if (!auth.ok) return auth;
  if (auth.value === null) return err("unauthenticated", "session is not valid");

  if (!auth.value.isAdmin) {
    console.warn(
      JSON.stringify({
        // 出力先は違うが名前空間は監査イベントと同じなので、登録簿で縛る。
        // 別に持つと片方だけ改名する事故が起きる（audit-log.port.ts）。
        event: "admin.denied" satisfies AuditEventName,
        operation,
        // 内部 ID。呼び出し元が決めた値ではないので、ログ注入にならない。
        userId: auth.value.userId,
      }),
    );
    return err("not_found", "no such resource");
  }

  return ok({ session: auth.value.session, userId: auth.value.userId });
}

/**
 * admin-worker から渡された `actorUserId` が実在することだけを確かめる
 * （#390 決定 16 ③、delegated RPC 用）。
 *
 * ## これは認可ではない
 *
 * **`requireAdminSession` の代わりではない。** delegated 系の入口に認可は
 * 無い —— 認可の境界は Service Binding そのもので、admin-worker が
 * 呼ぶ前に自分の承認リストで管理者性を確かめている
 * （`IdentityAdminDelegatedRpcContract` の冒頭）。ここで見るのは
 * 「`actorUserId` が存在しない ID ではないか」という、監査ログの質を
 * 保つためだけの確認である。
 *
 * **検証ではなく実在確認。** `actorUserId` が本当にその人によって
 * 操作されたことまでは確かめようがない（admin-worker 自身の承認リストの
 * 正しさに依存する）。確かめるのは「存在する `userId` である」ことだけで、
 * 存在しない ID を監査ログへそのまま書き込む事故を防ぐ。
 *
 * 一致しなければ `invalid_input` を返す。**`not_found` にしない** ——
 * `not_found` は `requireAdminSession` が「管理機能の存在を隠す」ために
 * 使っている値で、ここで同じ値を返すと 2 つの違う意味が混ざる。
 */
export async function requireExistingActor(
  deps: { readonly users: UserRepository },
  actorUserId: string,
): Promise<UseCaseResult<{ readonly userId: string }>> {
  const actor = await deps.users.findById(actorUserId);
  if (actor === null) return err("invalid_input", "actorUserId does not exist");

  return ok({ userId: actor.id });
}

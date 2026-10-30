import type { OAuthClient } from "../../domain/entities/oauth-client";
import type { OAuthClientRepository } from "../ports/oauth-client.repository";
import { requireAdminSession, type AdminAccessDeps } from "./admin-access";
import { ok, type UseCaseResult } from "./types";

export type ListOAuthClientsCommand = {
  readonly sessionToken: string;
};

export type ListOAuthClientsDeps = AdminAccessDeps & {
  readonly clients: OAuthClientRepository;
};

/**
 * 登録済み OAuth クライアントの一覧（#308）。**管理者のみ。**
 *
 * `ListPasskeysUseCase` と同じく、Entity をそのまま返して加工しない。
 * 何を応答に載せるか（`client_secret_hash` を外へ出さない）は契約の
 * `OAuthClientSummary` が型で決めており、この UseCase が選別しても
 * 二重になるだけである。**そもそも `OAuthClient` はハッシュを持たない**
 * ので、ここから先にハッシュが流れる経路は Domain の時点で切れている。
 *
 * ## 監査ログに行を作らない —— これは漏れではない
 *
 * **意図的である。** 足す前に `admin-access.ts` の該当段落を読むこと。
 *
 * 読み取りなので状態が変わらない、というだけではない。**拒否のたびに
 * 1 行書くと、有効なセッションを持つ相手が呼ぶだけで `audit_logs` を
 * 伸ばせる**（RPC 経路にレート制限は無い）。`rate_limit.exceeded` を
 * `audit_logs` に書かず Workers のログへ出すのと同じ構図で、**弾くこと
 * 自体を攻撃者が D1 への書き込みに変換できる形は作らない**（#21）。
 *
 * 拒否そのものは `admin.denied` として observability に出る
 * （`requireAdminSession`）ので、痕跡が消えるわけではない。
 *
 * **この UseCase は `AuditLogger` を依存に持たない。** コメントや
 * テストより先に、**書きようがない**形にしてある。
 */
export class ListOAuthClientsUseCase {
  constructor(private readonly deps: ListOAuthClientsDeps) {}

  async execute(command: ListOAuthClientsCommand): Promise<UseCaseResult<readonly OAuthClient[]>> {
    const admin = await requireAdminSession(this.deps, command.sessionToken, "listOAuthClients");
    if (!admin.ok) return admin;

    return ok(await this.deps.clients.listAll());
  }
}

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
 * ## 拒否を監査ログに残さない
 *
 * 登録・失効と違い、**こちらは読み取りで状態が変わらない。** 一方で
 * 「拒否のたびに 1 行書く」形にすると、有効なセッションを持つ相手が
 * 呼ぶだけで 2 年保持の行を増やせる —— `rate_limit.exceeded` を
 * `audit_logs` に書かない理由（#21）と同じ、書き込みの増幅である。
 * 管理機能を探る動きは、同じ相手がほぼ必ず叩く `createOAuthClient` /
 * `disableOAuthClient` の側に残る。
 */
export class ListOAuthClientsUseCase {
  constructor(private readonly deps: ListOAuthClientsDeps) {}

  async execute(command: ListOAuthClientsCommand): Promise<UseCaseResult<readonly OAuthClient[]>> {
    const admin = await requireAdminSession(this.deps, command.sessionToken, null);
    if (!admin.ok) return admin;

    return ok(await this.deps.clients.listAll());
  }
}

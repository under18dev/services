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
 * ## 拒否を監査ログに残さない —— これは漏れではない
 *
 * **意図的に記録していない。** 足す前にこの段落を読むこと。
 *
 * 登録・失効と違い、**こちらは読み取りで状態が変わらない。** 一方で
 * 「拒否のたびに 1 行書く」形にすると、**有効なセッションを持つ相手が
 * 呼ぶだけで、2 年保持（`security` 区分）の行を好きなだけ増やせる。**
 * `rate_limit.exceeded` を `audit_logs` に書かず Workers のログへ出す
 * のと同じ構図で（#21、`audit-log.port.ts` の当該コメント）、弾くこと
 * 自体を攻撃者が D1 への書き込みに変換できる形は作らない。
 *
 * 管理機能を探る動きが完全に消えるわけではない。**同じ相手はほぼ必ず
 * `createOAuthClient` / `disableOAuthClient` も叩く**ので、そちらに
 * `reason: "not_admin"` の行が残る（`admin-access.ts`）。一覧だけを
 * 叩いて帰る相手を取り逃がすのは承知のうえで、書き込みの増幅と引き換えに
 * している。
 */
export class ListOAuthClientsUseCase {
  constructor(private readonly deps: ListOAuthClientsDeps) {}

  async execute(command: ListOAuthClientsCommand): Promise<UseCaseResult<readonly OAuthClient[]>> {
    const admin = await requireAdminSession(this.deps, command.sessionToken, null);
    if (!admin.ok) return admin;

    return ok(await this.deps.clients.listAll());
  }
}

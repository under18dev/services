import type { OAuthClient } from "../../domain/entities/oauth-client";
import type { OAuthClientRepository } from "../ports/oauth-client.repository";
import { ok, type UseCaseResult } from "./types";

export type DelegatedListOAuthClientsDeps = {
  readonly clients: OAuthClientRepository;
};

/**
 * OAuth クライアントの一覧（admin-worker 経由、#390 決定 16 ③）。
 * `ListOAuthClientsUseCase` と対になる。違いは認可を持たないことだけ ——
 * `DelegatedListUsersUseCase` の JSDoc を参照。
 */
export class DelegatedListOAuthClientsUseCase {
  constructor(private readonly deps: DelegatedListOAuthClientsDeps) {}

  async execute(): Promise<UseCaseResult<readonly OAuthClient[]>> {
    return ok(await this.deps.clients.listAll());
  }
}

import type { OAuthClientRepository } from "../ports/oauth-client.repository";
import { ok, type UseCaseResult } from "./types";

export type DelegatedCountOAuthClientsDeps = {
  readonly clients: OAuthClientRepository;
};

/**
 * 登録済みの OAuth クライアント数（admin-worker のホーム用、#449）。
 * `DelegatedListOAuthClientsUseCase` と対だが、**`listAll` は呼ばない**
 * ——`OAuthClientRepository.count()` の冒頭を参照。
 */
export class DelegatedCountOAuthClientsUseCase {
  constructor(private readonly deps: DelegatedCountOAuthClientsDeps) {}

  async execute(): Promise<UseCaseResult<number>> {
    return ok(await this.deps.clients.count());
  }
}

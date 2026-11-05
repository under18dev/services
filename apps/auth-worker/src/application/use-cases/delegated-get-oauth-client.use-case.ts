import type { OAuthClient } from "../../domain/entities/oauth-client";
import type { OAuthClientRepository } from "../ports/oauth-client.repository";
import { err, ok, type UseCaseResult } from "./types";

export type DelegatedGetOAuthClientCommand = {
  readonly clientId: string;
};

export type DelegatedGetOAuthClientDeps = {
  readonly clients: OAuthClientRepository;
};

/**
 * OAuth クライアント 1 件を引く（admin-worker 経由、#473）。
 *
 * `DelegatedListOAuthClientsUseCase` の「1 件版」ではない——あちらは
 * `listAll()` を呼ぶが、こちらは `findByClientId()`。`DelegatedGetUserUseCase`
 * と同じ判断で、画面に出すのが常に 1 行なのに取得の重さだけが登録数に
 * 比例する形にしない。
 *
 * **認可を持たない。** 確かめるのは admin-worker 側
 * （`IdentityAdminDelegatedRpcContract` の冒頭）。
 *
 * **失効済みクライアントも返す。** `findByClientId` が `disabled_at` の
 * 立った行も返すのと同じ理由——詳細ページは「存在しない」と
 * 「失効している」を区別できる必要がある。
 */
export class DelegatedGetOAuthClientUseCase {
  constructor(private readonly deps: DelegatedGetOAuthClientDeps) {}

  async execute(command: DelegatedGetOAuthClientCommand): Promise<UseCaseResult<OAuthClient>> {
    const client = await this.deps.clients.findByClientId(command.clientId);
    if (client === null) return err("not_found", "no such client");

    return ok(client);
  }
}

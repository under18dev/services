import type { OAuthGrantRepository, UserGrantSummary } from "../ports/oauth-grant.repository";
import { ok, type UseCaseResult } from "./types";
import type { GetSessionUseCase } from "./get-session.use-case";

export type ListGrantsCommand = {
  readonly sessionToken: string;
};

export type ListGrantsDeps = {
  readonly getSession: GetSessionUseCase;
  readonly grants: OAuthGrantRepository;
};

/**
 * 自分が同意したアプリの一覧を返す（#18）。
 *
 * `ListSessionsUseCase` と同じ形をしている。userId は引数で受け取らず、
 * 必ずセッションから導く（仕様書 4.2 の注意書き）。同意一覧は
 * 「この人がどのサービスを使っているか」そのもので、セッション一覧と
 * 同じだけ機微である。
 *
 * 戻り値が `null` のときは「セッションが使えない」。`ListSessionsUseCase` と
 * 揃えてあり、`IdentityRPC` が `unauthenticated` へ翻訳する。
 *
 * 取り消し済みの同意は一覧から外す。セッション一覧が失効済みを出さないのと
 * 同じ理由で、UI 上で「取り消す」対象にできないものを並べても操作できる
 * ことが無く、「取り消したのにまだ残っている」と読めてしまう。
 */
export class ListGrantsUseCase {
  constructor(private readonly deps: ListGrantsDeps) {}

  async execute(
    command: ListGrantsCommand,
  ): Promise<UseCaseResult<readonly UserGrantSummary[] | null>> {
    const auth = await this.deps.getSession.execute({ sessionToken: command.sessionToken });
    if (!auth.ok) return auth;
    if (auth.value === null) return ok(null);

    const all = await this.deps.grants.listByUser(auth.value.userId);
    return ok(all.filter(({ grant }) => !grant.isRevoked));
  }
}

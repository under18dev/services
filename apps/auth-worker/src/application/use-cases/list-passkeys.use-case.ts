import type { Passkey } from "../../domain/entities/passkey";
import type { PasskeyRepository } from "../ports/passkey.repository";
import { ok, type UseCaseResult } from "./types";
import type { GetSessionUseCase } from "./get-session.use-case";

export type ListPasskeysCommand = {
  readonly sessionToken: string;
};

export type ListPasskeysDeps = {
  readonly getSession: GetSessionUseCase;
  readonly passkeys: PasskeyRepository;
};

/**
 * 自分が登録した認証器の一覧（仕様書 6.1 / 8.1、issue #75）。
 *
 * 削除の前段として要る。どの認証器があるのか見えないと、利用者は
 * 「紛失した端末の 1 本」を選べず、結果として外せない。
 *
 * ListSessionsUseCase と同じく userId は引数で受け取らずセッションから導く。
 * 何を返すか（公開鍵や Credential ID を外へ出さない）の判断は
 * Presentation 側にあるが、この UseCase も Entity をそのまま返すだけで
 * 加工しないので、応答に載せる項目は 1 か所で決まる。
 */
export class ListPasskeysUseCase {
  constructor(private readonly deps: ListPasskeysDeps) {}

  async execute(command: ListPasskeysCommand): Promise<UseCaseResult<readonly Passkey[] | null>> {
    const auth = await this.deps.getSession.execute({ sessionToken: command.sessionToken });
    if (!auth.ok) return auth;
    if (auth.value === null) return ok(null);

    return ok(await this.deps.passkeys.listByUserId(auth.value.userId));
  }
}

import type { Session } from "../../domain/entities/session";
import type { Clock } from "../ports/clock.port";
import type { SessionRepository } from "../ports/session.repository";
import { ok, type UseCaseResult } from "./types";
import type { GetSessionUseCase } from "./get-session.use-case";

export type ListSessionsCommand = {
  readonly sessionToken: string;
};

export type ListSessionsItem = {
  readonly session: Session;
  /** この一覧を要求したセッション自身かどうか。 */
  readonly current: boolean;
};

export type ListSessionsDeps = {
  readonly getSession: GetSessionUseCase;
  readonly sessions: SessionRepository;
  readonly clock: Clock;
};

/**
 * 自分のセッション一覧を返す。
 *
 * userId は引数で受け取らず、必ずセッションから導く。userId を受け取る設計は
 * 「他人の一覧を読む」入口になる（仕様書 4.2 の注意書き）。
 */
export class ListSessionsUseCase {
  constructor(private readonly deps: ListSessionsDeps) {}

  async execute(
    command: ListSessionsCommand,
  ): Promise<UseCaseResult<readonly ListSessionsItem[] | null>> {
    const result = await this.deps.getSession.execute({ sessionToken: command.sessionToken });
    if (!result.ok) return result;
    if (result.value === null) return ok(null);

    const { session: current, userId } = result.value;
    const now = this.deps.clock.now();
    const all = await this.deps.sessions.listByUserId(userId);

    // すでに使えないセッションは一覧に出さない。UI 上で「失効させる」対象にしても意味がない。
    return ok(
      all
        .filter((s) => s.isUsableAt(now))
        .map((s) => ({ session: s, current: s.id === current.id })),
    );
  }
}

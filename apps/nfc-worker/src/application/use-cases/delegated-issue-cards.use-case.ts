import { newCardId } from "@u18/domain";
import type { CardEventRecorder, CardRepository, Clock, IssuedCard, NfcOutcome } from "../ports";
import { outcomeErr, outcomeOk } from "../ports";
import { MAX_ISSUE_COUNT } from "./issue-cards.use-case";

export type DelegatedIssueCardsInput = {
  /** admin-worker が確認済みの userId。検証しない（宣言は `DelegatedDisableCardUseCase` と同じ）。 */
  readonly actorUserId: string;
  readonly count: number;
  readonly batch: string | null;
};

/**
 * 運営（admin-worker 経由）がカードを発行する（#382 / #390 決定 16 ③）。
 *
 * **`IssueCardsUseCase` との違いは、認可を持たないことだけ。** 理由は
 * `DelegatedDisableCardUseCase` の冒頭を参照。枚数の上限
 * （`MAX_ISSUE_COUNT`）と直列に回す判断（途中で失敗したときに「何枚
 * 入ったか」が分からなくならないようにする）は、セッション版と共有する。
 */
export class DelegatedIssueCardsUseCase {
  constructor(
    private readonly cards: CardRepository,
    private readonly events: CardEventRecorder,
    private readonly clock: Clock,
  ) {}

  async execute(input: DelegatedIssueCardsInput): Promise<NfcOutcome<readonly IssuedCard[]>> {
    if (!Number.isInteger(input.count) || input.count < 1 || input.count > MAX_ISSUE_COUNT) {
      return outcomeErr({ kind: "claim_rejected" });
    }

    const now = this.clock.now();
    const issued: IssuedCard[] = [];

    for (let i = 0; i < input.count; i += 1) {
      const cardId = newCardId();

      await this.cards.issue({ id: cardId, batch: input.batch }, now);
      await this.events.record({
        cardId,
        event: "card.issued",
        actorUserId: input.actorUserId,
        ...(input.batch === null ? {} : { metadata: { batch: input.batch } }),
      });

      issued.push({ cardId });
    }

    return outcomeOk(issued);
  }
}

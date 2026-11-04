import { newCardId } from "@u18/domain";
import type { CardEventRecorder, CardRepository, Clock, IssuedCard, NfcOutcome } from "../ports";
import { outcomeErr, outcomeOk } from "../ports";

/**
 * 1 回に発行できる枚数の上限。
 *
 * 文化祭のロット単位（数百枚）を 1 回で捌ける必要は無く、**取り消せない
 * 操作の 1 回あたりの影響を小さく保つ**ほうを採る。**#358 以降、発行した
 * カードは ID を知っている人がタップすれば誰のものにもなる**ので、
 * 誤って 10,000 枚出すと、その全部が「配布済み・未紐づけ」の窓に並ぶ。
 *
 * **ここにあるのは #433 以降である。** 以前は `issue-cards.use-case.ts`
 * （セッション Cookie で管理者を確かめる版）が持ち、こちらが借りていた。
 * `/account/nfc` 側の発行を消したので、残ったこちらへ移した。
 */
export const MAX_ISSUE_COUNT = 200;

export type DelegatedIssueCardsInput = {
  /** admin-worker が確認済みの userId。検証しない（宣言は `DelegatedDisableCardUseCase` と同じ）。 */
  readonly actorUserId: string;
  readonly count: number;
  readonly batch: string | null;
};

/**
 * 運営（admin-worker 経由）がカードを発行する（#382 / #390 決定 16 ③）。
 *
 * **認可は持たない。** 呼べるのは `NfcAdminDelegatedRPC` を束縛している
 * admin-worker だけで、「管理者か」の確認はあちらで済んでいる（理由は
 * `DelegatedDisableCardUseCase` の冒頭）。
 *
 * **#433 以降、発行の口はこれ 1 本である。** セッション Cookie で
 * `isAdmin` を確かめる `IssueCardsUseCase` があったが、`/account/nfc` 側の
 * 運営機能を消したときに一緒に消えた。**ここに `sessionToken` を受け取る
 * 兄弟を戻さないこと** —— 戻した時点で、発行の入口が 2 つになる。
 *
 * **直列に回す。** 並列にすると、途中で失敗したときに「何枚入ったか」が
 * 分からなくなる。発行は急がない操作で、上限も 200 枚しかない。
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

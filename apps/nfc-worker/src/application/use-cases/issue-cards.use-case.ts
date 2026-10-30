import { newCardId } from "@u18/domain";
import type {
  CardEventRecorder,
  CardRepository,
  Clock,
  IdentityGateway,
  IssueCardsInput,
  IssuedCard,
  NfcOutcome,
} from "../ports";
import { outcomeErr, outcomeOk } from "../ports";
import { requireAdminUserId } from "./authenticate";

/**
 * 1 回に発行できる枚数の上限。
 *
 * 文化祭のロット単位（数百枚）を 1 回で捌ける必要は無く、**取り消せない
 * 操作の 1 回あたりの影響を小さく保つ**ほうを採る。**#358 以降、発行した
 * カードは ID を知っている人がタップすれば誰のものにもなる**ので、
 * 誤って 10,000 枚出すと、その全部が「配布済み・未紐づけ」の窓に並ぶ。
 */
export const MAX_ISSUE_COUNT = 200;

/**
 * 運営がカードを発行する（#187、仕様書 §10 / §12）。
 *
 * ## 管理者だけ
 *
 * 判定は `requireAdminUserId` —— `getSession` が返す `isAdmin` を見る。
 * **nfc-worker は Identity D1 を持たないので自分では決められない**し、
 * 決めさせない（`authenticate.ts` の冒頭）。
 *
 * ## #358 以降、発行で出るのは秘密ではない
 *
 * 以前はここで紐づけコードを作り、**この応答にしか存在しない**値として
 * 返していた。廃止したので、出るのは**タグに書く値そのもの**（カード ID）
 * だけである。取りこぼしても一覧から引き直せる。
 *
 * **ただし「秘密ではない」は「見せてよい」ではない。** 未紐づけのカードは
 * **ID を知っている人がタップすれば、その人のものになる**（#358）。
 * 発行から手渡しまでの間、ID の一覧は配布物そのものと同じ扱いにすること
 * （`docs/runbook.md`）。
 *
 * ## ID の長さは `newCardId()` が持つ
 *
 * **ここで `newId("nfc")` と書かない。** 既定の 16 バイト（80 ビット）に
 * なり、スキーマと脅威モデルが言う 100 ビットから静かにずれる ——
 * **実際ずれていた**（#358 で発覚）。長さを決める場所は 1 つにする。
 */
export class IssueCardsUseCase {
  constructor(
    private readonly identity: IdentityGateway,
    private readonly cards: CardRepository,
    private readonly events: CardEventRecorder,
    private readonly clock: Clock,
  ) {}

  async execute(
    sessionToken: string | undefined,
    input: IssueCardsInput,
  ): Promise<NfcOutcome<readonly IssuedCard[]>> {
    const actor = await requireAdminUserId(this.identity, sessionToken);
    if (!actor.ok) return actor;

    if (!Number.isInteger(input.count) || input.count < 1 || input.count > MAX_ISSUE_COUNT) {
      return outcomeErr({ kind: "claim_rejected" });
    }

    const now = this.clock.now();
    const issued: IssuedCard[] = [];

    // **直列に回す。** 並列にすると、途中で失敗したときに「何枚入ったか」が
    // 分からなくなる。発行は急がない操作で、上限も 200 枚しかない。
    for (let i = 0; i < input.count; i += 1) {
      const cardId = newCardId();

      await this.cards.issue({ id: cardId, batch: input.batch }, now);
      await this.events.record({
        cardId,
        event: "card.issued",
        actorUserId: actor.value,
        ...(input.batch === null ? {} : { metadata: { batch: input.batch } }),
      });

      issued.push({ cardId });
    }

    return outcomeOk(issued);
  }
}

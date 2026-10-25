import { newId } from "@u18/domain";
import type {
  CardEventRecorder,
  CardRepository,
  ClaimCodeService,
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
 * 操作の 1 回あたりの影響を小さく保つ**ほうを採る。発行したカードは
 * 回収しない限り claim されうるので、誤って 10,000 枚出すと
 * 全部に紐づけコードが生えた状態になる。
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
 * ## 紐づけコードは返り値にしか存在しない
 *
 * DB にはハッシュしか入らない（`nfc_cards.claim_code_hash`）。
 * **この応答を取りこぼすと、そのカードは配れない** —— 再発行するしかない。
 * 呼び出し側（運営の画面）はここで受けた値を印刷まで持っていくこと。
 *
 * ## ID は乱数、コードは別の乱数
 *
 * カード ID はタグに書かれて誰でも読める。**紐づけの根拠にしない**ので、
 * 別の秘密（80bit）を添える（脅威モデル §3.7 N-2）。
 */
export class IssueCardsUseCase {
  constructor(
    private readonly identity: IdentityGateway,
    private readonly cards: CardRepository,
    private readonly events: CardEventRecorder,
    private readonly claimCodes: ClaimCodeService,
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
      const cardId = newId("nfc");
      const claimCode = this.claimCodes.generate();

      await this.cards.issue(
        { id: cardId, claimCodeHash: await this.claimCodes.hash(claimCode), batch: input.batch },
        now,
      );
      // **紐づけコードは metadata に書かない**（`nfc_card_events` の
      // コメントのとおり）。ここに書くと、ハッシュ保存の意味が消える。
      await this.events.record({
        cardId,
        event: "card.issued",
        actorUserId: actor.value,
        ...(input.batch === null ? {} : { metadata: { batch: input.batch } }),
      });

      issued.push({ cardId, claimCode });
    }

    return outcomeOk(issued);
  }
}

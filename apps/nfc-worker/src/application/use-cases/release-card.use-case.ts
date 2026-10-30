import type {
  CardEventRecorder,
  CardRepository,
  CardView,
  Clock,
  IdentityGateway,
  NfcOutcome,
} from "../ports";
import { outcomeErr, outcomeOk } from "../ports";
import { requireUserId } from "./authenticate";
import { toCardView } from "./card-view";

export type ReleaseCardInput = {
  readonly sessionToken: string | undefined;
  readonly cardId: string;
};

/**
 * 所有権を手放す（仕様書 10「所有権移転手順」の前半）。
 *
 * ## なぜ「相手を指定して渡す」にしないのか
 *
 * 移転 API の素直な形は `transfer(cardId, toUserId)` だが、採らない。
 *
 * - nfc-worker は Identity を検索できない。ユーザー名から userId を引く
 *   RPC を足せば書けるが、それは **Binding を持つ Worker から任意の
 *   ユーザーを検索できる入口**になる（仕様書 4.2 の注意書き）。
 *   カード 1 枚の移転のために、Identity の列挙面を広げる取引は割に合わない。
 * - 宛先を指定する形は誤送信が取り返しのつかない操作になる。
 *
 * 代わりに「現所有者が手放す → カードが未紐づけへ戻る → 受け取った人が
 * タップして紐づける」の 2 段にする。渡す相手は u18 の外（手渡し）で
 * 決まるので、Identity に何も要らない。受け取る側は自分のセッションで
 * 紐づけるので、「誰のものになったか」は Identity が保証したままになる。
 *
 * ## #358 で「1 回しか返らない文字列」が無くなった
 *
 * 以前はここで新しい紐づけコードを生成し、**この応答でしか返らない**値として
 * 返していた。紐づけコードを廃止したので、**手放したカードは `issued` へ戻り、
 * 次にタップした人のものになる。**
 *
 * **その結果、手放してから手渡すまでの間が無防備になった。** 以前は
 * コードを渡すまで誰も紐づけられなかったが、いまは ID を知っている人なら
 * 誰でも先に取れる。**手放すのは相手に渡す直前にする**ことが運用上の前提で、
 * 画面の案内がそう言う。取られた場合は管理者が付け替えられる。
 *
 * ## 手放すと同時に遷移先を消す
 *
 * 前の所有者が設定した URL を、次の所有者に引き継がせない。
 * 引き継ぐと、カードを譲られた人のカードが、本人の知らない URL を
 * 配信している状態から始まる。
 *
 * ## 紛失した場合はこちらではなく無効化を使う
 *
 * release は「手元にカードがあり、人に渡す」操作。紛失時にこれを使うと、
 * カードが claim 可能な状態（`issued`）へ戻り、新しいコードを知らなくても
 * 拾った人が次の配布ロットのコードを試せる余地を残す。
 * 紛失は `DisableCardUseCase`。
 */
export class ReleaseCardUseCase {
  constructor(
    private readonly identity: IdentityGateway,
    private readonly cards: CardRepository,
    private readonly events: CardEventRecorder,
    private readonly clock: Clock,
  ) {}

  async execute(input: ReleaseCardInput): Promise<NfcOutcome<CardView>> {
    const actor = await requireUserId(this.identity, input.sessionToken);
    if (!actor.ok) return actor;

    const released = await this.cards.release(input.cardId, actor.value, this.clock.now());
    if (!released) return outcomeErr({ kind: "card_not_found" });

    await this.events.record({
      cardId: input.cardId,
      event: "card.released",
      actorUserId: actor.value,
    });

    const fresh = await this.cards.findById(input.cardId);
    if (fresh === null) return outcomeErr({ kind: "card_not_found" });
    return outcomeOk(toCardView(fresh));
  }
}

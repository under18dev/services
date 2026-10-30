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

export type ClaimCardInput = {
  readonly sessionToken: string | undefined;
  readonly cardId: string;
};

/**
 * カードを自分のアカウントへ紐づける（#358）。
 *
 * ## 文書化された決定を 1 つ撤回している
 *
 * このファイルには以前、こう書いてあった。
 *
 * > 仕様書 10 の「NFC タグ自体はログイン資格情報にしない」は、「タグを
 * > 持っていてもログインできない」だけを指していない。**タグを読めることが
 * > 所有の証明になってはならない**、も含む。
 *
 * **後半を撤回した**（#358、運用者の判断 2026-10-30）。
 * **前半は撤回していない** —— タグは依然としてログインの資格情報ではなく、
 * この経路は必ずセッションを要求する。変わったのは「**所有の主張**」に
 * 何が要るかだけである。
 *
 * ## 撤回の理由は運用である
 *
 * 以前は「タグに書かれていない紐づけコード」を封緘・スクラッチで添えていた。
 * ノベルティとして配る前提でこれを持つと、**封緘・スクラッチ・紛失時の
 * 再発行が配布物の印刷に乗ってくる。** 守っていたのは「配布済み・未紐づけ」の
 * 窓だけで、しかもその窓は管理者が付け替えられる（`ReleaseCardUseCase`）。
 *
 * **取り返しのつく危険に、取り返しのつかないコスト（印刷）を払っていた。**
 *
 * ## いま紐づけに要るもの
 *
 * 1. **u18 Identity のセッション** —— 誰のアカウントに結ぶかを決める。
 *    auth-worker が検証したものしか受け取らない（`requireUserId`）。
 * 2. **カード ID を知っていること** —— どのカードを結ぶかを決める。
 *    タップすれば読める値なので、**実質「カードを持っていること」である。**
 *
 * 2 が秘密として成り立つ前提は `newCardId()` の 100 ビットにある。
 * 詳しくは `domain/services/disclosure.ts`。
 *
 * ## 失敗の理由を区別しない
 *
 * カードが無い・既に誰かのもの・無効化済みをすべて `claim_rejected` にする。
 * 区別すると、総当たりしている相手に「カード ID は当たっている」と教える。
 *
 * **`issued` だけは外から区別が付く**（タップした人を紐づけ画面へ送るため）が、
 * **その判断はこの UseCase には無い。** `domain/services/disclosure.ts` が
 * 1 箇所で決めており、ここは「紐づけが通ったか」しか言わない。
 *
 * ## 残余リスク: 配布前のカード
 *
 * **ID を知っていれば誰でも自分のものにできる。** したがって
 * 「配布済み・未紐づけ」の窓にあるカードは、**ID が漏れた時点で奪われる。**
 * レート制限は無いが、総当たりは 100 ビットに阻まれる（`disclosure.ts`）。
 * 現実的な脅威は**総当たりではなく、配布前の束を見られること**なので、
 * 手当ては運用側にある（`docs/runbook.md`）。奪われた場合は、管理者が
 * `release` で付け替えられる。
 */
export class ClaimCardUseCase {
  constructor(
    private readonly identity: IdentityGateway,
    private readonly cards: CardRepository,
    private readonly events: CardEventRecorder,
    private readonly clock: Clock,
  ) {}

  async execute(input: ClaimCardInput): Promise<NfcOutcome<CardView>> {
    const actor = await requireUserId(this.identity, input.sessionToken);
    if (!actor.ok) return actor;

    // **状態の確認はしない。** `findById` して `isClaimable()` を見てから
    // UPDATE すると、同じカードを同時にタップした 2 人が両方成功する。
    // 前提は全部 WHERE 句にある（`CardRepository.claim`）。
    const claimed = await this.cards.claim(input.cardId, actor.value, this.clock.now());
    if (!claimed) return outcomeErr({ kind: "claim_rejected" });

    await this.events.record({
      cardId: input.cardId,
      event: "card.claimed",
      actorUserId: actor.value,
    });

    const fresh = await this.cards.findById(input.cardId);
    if (fresh === null) return outcomeErr({ kind: "claim_rejected" });
    return outcomeOk(toCardView(fresh));
  }
}

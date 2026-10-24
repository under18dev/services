import { validateTargetUrl } from "../../domain/services/target-url";
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

export type UpdateCardTargetInput = {
  readonly sessionToken: string | undefined;
  readonly cardId: string;
  readonly targetUrl: string;
};

/**
 * カードの遷移先を変更する（Phase 4 の完了条件「カードを書き換えずに
 * 遷移先を変更可能」そのもの）。
 *
 * ## 認可の二重化
 *
 * 1. セッションから得た userId が所有者かを Entity で確かめる
 * 2. 同じ条件を `updateTarget` の WHERE 句にも入れる
 *
 * 1 だけだと、確認と書き込みの間に所有者が変わった場合（同時に release が
 * 走った場合）に、元の所有者の書き込みが新しい所有者のカードへ着地する。
 * 2 だけでも正しく落ちるが、1 を残すのは「所有者でない」と
 * 「存在しない」を同じ `card_not_found` に畳む判断をここで明示するため。
 */
export class UpdateCardTargetUseCase {
  constructor(
    private readonly identity: IdentityGateway,
    private readonly cards: CardRepository,
    private readonly events: CardEventRecorder,
    private readonly clock: Clock,
    /**
     * 遷移先にできないオリジン。IdP 自身の issuer を渡す。
     * Domain は `Env` を読めないので、composition からここへ流す。
     */
    private readonly blockedOrigins: readonly string[],
  ) {}

  async execute(input: UpdateCardTargetInput): Promise<NfcOutcome<CardView>> {
    const actor = await requireUserId(this.identity, input.sessionToken);
    if (!actor.ok) return actor;

    const card = await this.cards.findById(input.cardId);
    // 無効化済みのカードは所有者でも書き換えられない。紛失したカードの
    // 遷移先を、拾った人間が所有者のアカウントを乗っ取って差し替える、
    // という連鎖を「無効化された時点で止まる」ようにする。
    if (card === null || !card.isOwnedBy(actor.value) || card.isDisabled) {
      return outcomeErr({ kind: "card_not_found" });
    }

    // URL の検証は**認可の後**に行う。先に検証すると、他人のカード ID に
    // 対して「URL は妥当だがカードが無い」と「URL が不正」の応答差が出て、
    // カードの実在を測る物差しになる。
    const validated = validateTargetUrl(input.targetUrl, this.blockedOrigins);
    if (!validated.ok) {
      return outcomeErr({ kind: "invalid_target_url", reason: validated.reason });
    }

    const now = this.clock.now();
    const updated = await this.cards.updateTarget(input.cardId, actor.value, validated.url, now);
    if (!updated) return outcomeErr({ kind: "card_not_found" });

    await this.events.record({
      cardId: input.cardId,
      event: "card.target_updated",
      actorUserId: actor.value,
      // 所有者自身が設定した公開 URL なので記録してよい。
      // 前の値は残さない —— 監査に要らず、消したはずの遷移先が
      // ログの中で生き続けることになるため。
      metadata: { targetUrl: validated.url },
    });

    const fresh = await this.cards.findById(input.cardId);
    if (fresh === null) return outcomeErr({ kind: "card_not_found" });
    return outcomeOk(toCardView(fresh));
  }
}

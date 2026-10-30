import type {
  CardEventRecorder,
  CardRepository,
  Clock,
  IdentityGateway,
  NfcOutcome,
} from "../ports";
import { outcomeErr, outcomeOk } from "../ports";
import { requireAdminUserId } from "./authenticate";

export type AdminDisableCardInput = {
  readonly sessionToken: string | undefined;
  readonly cardId: string;
};

/**
 * 運営が、他人のカードを無効化する（#382「他人のカードへの操作」）。
 *
 * **運用者から緊急の要望が来た。**「一人やばそうな用途をしそうな人がいる」
 * ので、不正利用が疑われるカードを**所有者本人を介さずに**止める必要が
 * ある。遷移先の書き換えより先に無効化を入れるのは、**止めれば遷移先が
 * 何であっても到達しないから**である（遷移先の書き換えは「止めるほどでは
 * ないが直したい」場合の手段で、優先度が一段下がる）。
 *
 * ## `DisableCardUseCase` とは別の use-case にした
 *
 * **所有者判定の有無で 1 本を分岐させない。** `cards.routes.ts` が
 * 発行ハンドラで書いている方針と同じ —— 判定をルートや 1 本の use-case の
 * 中の if 分岐に埋めると、**経路が増えたときに素通りする形を作る。**
 * `ListAllCardsUseCase` が所有者向けの `ListMyCardsUseCase` と別になって
 * いるのと同じ形にした。
 *
 * ## 監査: 誰が運営として止めたかを区別できるようにする
 *
 * イベント名は既存の `card.disabled` を使う（保持区分・掃除の対象は
 * 名前で決まるので、増やすとそちらも増える）。**区別は `metadata` で
 * 持つ** —— `actingAsAdmin: true` を記録する。`actorUserId` は運営の
 * userId で、カードの所有者とは別人であることが行から読める。
 *
 * ## 冪等
 *
 * `DisableCardUseCase` と同じ判断。既に無効化済みのカードへもう一度
 * 無効化を叩いても失敗にしない —— 二重に押された操作で「止まらなかった」
 * と誤解させないため。
 */
export class AdminDisableCardUseCase {
  constructor(
    private readonly identity: IdentityGateway,
    private readonly cards: CardRepository,
    private readonly events: CardEventRecorder,
    private readonly clock: Clock,
  ) {}

  async execute(input: AdminDisableCardInput): Promise<NfcOutcome<null>> {
    const actor = await requireAdminUserId(this.identity, input.sessionToken);
    if (!actor.ok) return actor;

    const card = await this.cards.findById(input.cardId);
    if (card === null) return outcomeErr({ kind: "card_not_found" });

    if (!card.isDisabled) {
      const now = this.clock.now();
      const disabled = await this.cards.disableAsAdmin(input.cardId, "admin_action", now);
      if (!disabled) return outcomeErr({ kind: "card_not_found" });

      await this.events.record({
        cardId: input.cardId,
        event: "card.disabled",
        actorUserId: actor.value,
        metadata: { reason: "admin_action", actingAsAdmin: true },
      });
    }

    return outcomeOk(null);
  }
}

import type { AdminCardView, CardRepository, NfcOutcome } from "../ports";
import { outcomeOk } from "../ports";
import type { Card } from "../../domain/entities/card";

/**
 * 所有者ごとの一覧に出す 1 枚。**`AdminCardView` から `tapCount` を
 * 落としてある。**
 *
 * `Omit` で書いているのは、**列が増えたときに自動で追従させるため**で、
 * 落としている 1 つだけを目立たせたいからでもある。`nfc_card_taps` は
 * 「誰が使ったか」を持たない設計で（#394、`packages/nfc-db/src/schema/taps.ts`）、
 * **所有者で引いたカードに回数を添えると「この人が何回使ったか」になる。**
 * #454 と同じ線引きで、ユーザー単位のタップ集計は作らない。
 *
 * **値を 0 で埋める形にしない。** `toAdminView` は呼び出し側が渡した数を
 * そのまま詰めるだけなので、0 を渡すと**黙って嘘の値**が画面に出る
 * （`DelegatedListAllCardsUseCase` が `cardTaps` を省けない理由と同じ罠）。
 * 項目ごと無くしておけば、次に誰かが「ここに回数を出したい」と思ったとき
 * 型が止める。
 */
export type OwnedCardView = Omit<AdminCardView, "tapCount">;

/**
 * 1 人が持っているカードの一覧（admin-worker のユーザー詳細ページ用、#455）。
 *
 * **認可は持たない。** `DelegatedListAllCardsUseCase` と同じ理由で、
 * 呼べるのは admin-worker だけである。読み取りだけなので監査イベントも
 * 残さず、`actorUserId` も受け取らない。
 *
 * ## `DelegatedListAllCardsUseCase` で代えられない
 *
 * あちらは `MAX_ADMIN_LIST`（500 枚）で打ち切るので、**古いカードを
 * 持っている人の行は、絞り込んだ結果 1 枚も残らないことがある。**
 * 「持っていない」と「上限の外に居た」が画面から区別できなくなる。
 *
 * ## 上限を置いていない
 *
 * `listByOwner` は WHERE が `owner_user_id` 1 人ぶんなので、**件数は
 * その人が持っている枚数で頭打ちになる**——全カードの一覧のように
 * 「増え続けるものを全部描く」形にはならない。打ち切りが起こらない以上、
 * `truncated` に当たる値も持たない（契約側に無い）。
 *
 * ## 無効化済みのカードも返す
 *
 * 運用者がこの画面を開くのは、たいてい止めたあとの確認である
 * （`listByOwner` が所有者本人にも無効化済みを見せているのと同じ理由）。
 */
export class DelegatedListCardsByOwnerUseCase {
  constructor(private readonly cards: CardRepository) {}

  async execute(command: {
    readonly ownerUserId: string;
  }): Promise<NfcOutcome<{ readonly cards: readonly OwnedCardView[] }>> {
    const rows = await this.cards.listByOwner(command.ownerUserId);
    return outcomeOk({ cards: rows.map(toOwnedView) });
  }
}

/**
 * Domain のカードを運営向けの表示用に落とす。
 *
 * **`toAdminView`（`delegated-list-all-cards.use-case.ts`）と別にしてある。**
 * あちらは `tapCount` を受け取る形で、ここでは渡せる値が無い——
 * 引数を 0 で埋めて共有すると、嘘の回数を画面へ運ぶ経路ができる。
 */
function toOwnedView(card: Card): OwnedCardView {
  return {
    cardId: card.id,
    status: card.status,
    ownerUserId: card.ownerUserId,
    targetUrl: card.targetUrl,
    batch: card.batch,
    issuedAt: card.createdAt.toISOString(),
    claimedAt: card.claimedAt?.toISOString() ?? null,
    disabledAt: card.disabledAt?.toISOString() ?? null,
  };
}

import type { CardEventRecorder, CardRepository, Clock, NfcOutcome } from "../ports";
import { outcomeErr, outcomeOk } from "../ports";

export type DelegatedReleaseCardInput = {
  /**
   * admin-worker が確認済みの、操作者（運営）の userId。
   *
   * **ここでは検証しない。** `delegated-disable-card.use-case.ts` と
   * 同じ理由——ここへ辿り着けること自体が Service Binding で保証されている。
   */
  readonly actorUserId: string;
  readonly cardId: string;
};

/**
 * 運営（admin-worker 経由）が、他人のカードの所有権を剥奪する
 * （#422「所有者が付け替えられない」/ #390 決定 16 ③）。
 *
 * ## 「付け替え」ではなく「手放させる」を選んだ
 *
 * 運営が直接別の利用者へ付け替える口は作らない。カードを `issued`
 * （未紐づけ）へ戻すだけにする——**`ReleaseCardUseCase`（本人の release）
 * と同じ結果**で、次にタップした人のものになる。
 *
 * **NFC カードのセキュリティモデルは「タップ＝物理的占有の証明」である。**
 * 直接付け替えだと、admin-worker が物理的なタップを経由せず任意の利用者へ
 * カードを束縛できることになる。issue が挙げた 2 つの困りごと
 * （連絡が取れない・誤って別人に紐づいた）は、どちらも「`issued` へ戻す」
 * だけで解決する——次の正しい持ち主は結局タップして受け取る必要があるので、
 * 直接付け替えは実務上の能力を増やさず、**admin-worker 側の権限が悪用・
 * 侵害されたときに「誰のカードでも別人のものにできる」という攻撃面だけを
 * 増やす。**
 *
 * ## 冪等
 *
 * 既に `issued` のカードへもう一度叩いても失敗にしない（`AdminDisableCardUseCase`
 * と同じ判断）。`disabled` のカードは対象外——`releaseAsAdmin` の WHERE 句
 * （`active` のみ）がそれを守る。
 *
 * ## 監査: イベント名は増やさない
 *
 * `card.released` を使い回す。`AdminDisableCardUseCase` が `card.disabled`
 * を使い回して `metadata.actingAsAdmin` で区別しているのと同じ判断——
 * 「同じ操作を誰が行ったか」であって「別の操作」ではないので、保持区分・
 * 掃除の対象が event 名で決まる仕組みに新しい名前を増やす理由が無い。
 *
 * ## 本人への連絡は機械で保証しない
 *
 * 止める（disable）と違い、手放させるのは**本人の画面からカードが消える**
 * 操作で、本人には「無効化された」とも「自分で手放した」とも見えない
 * 説明の付かない消え方をする。運用者が実行前に本人へ連絡する前提であることを
 * `docs/nfc-cards-operations.md` に明記する——ここでは機械的に守れない。
 */
export class DelegatedReleaseCardUseCase {
  constructor(
    private readonly cards: CardRepository,
    private readonly events: CardEventRecorder,
    private readonly clock: Clock,
  ) {}

  async execute(input: DelegatedReleaseCardInput): Promise<NfcOutcome<null>> {
    const card = await this.cards.findById(input.cardId);
    if (card === null) return outcomeErr({ kind: "card_not_found" });

    if (card.status !== "issued") {
      const now = this.clock.now();
      const released = await this.cards.releaseAsAdmin(input.cardId, now);
      if (!released) return outcomeErr({ kind: "card_not_found" });

      await this.events.record({
        cardId: input.cardId,
        event: "card.released",
        actorUserId: input.actorUserId,
        metadata: { actingAsAdmin: true },
      });
    }

    return outcomeOk(null);
  }
}

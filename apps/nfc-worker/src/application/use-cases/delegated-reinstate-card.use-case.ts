import type { CardEventRecorder, CardRepository, Clock, NfcOutcome } from "../ports";
import { outcomeErr, outcomeOk } from "../ports";

export type DelegatedReinstateCardInput = {
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
 * 運営（admin-worker 経由）が、無効化されたカードを `active` へ戻す
 * （#427、`go.under18.dev/docs` の「止めたカードは、自分では元に戻せません。
 * 戻したいときは運営に連絡してください。」に対応する口）。
 *
 * ## これまで口が無かった
 *
 * `packages/nfc-db/src/schema/cards.ts` の `status` 列は「復帰は運用側
 * （運営）の操作にする」と明記していたが、disableCard の逆（reinstate）
 * は #365 の数え上げ（#427）まで実装されていなかった。公開文書が利用者へ
 * 「運営に連絡してください」と案内していたのに、連絡を受けた運営には
 * D1 を直接叩く以外の手段が無かった。
 *
 * ## `active` へ戻すだけで、`issued`（手放す）とはまとめない
 *
 * **`DelegatedReleaseCardUseCase` と対になるが、同じ操作ではない。**
 * 「戻したい」（本人がまだ持っている）と「渡したい」（本人と連絡が
 * 取れない・別の人に渡したい）は運営側の判断が違う場面で、1 操作に
 * まとめると復帰のつもりが次の拾得者へ渡る事故を作れる。渡したい場合は、
 * 復帰させたあとであらためて `releaseCard` を呼ぶ——弱い操作を 2 つ
 * 並べるほうが、強い操作を 1 つ作るより安全（#422 が「付け替え」では
 * なく「手放させる」を選んだのと同じ判断）。
 *
 * ## 所有者・遷移先はそのまま戻る
 *
 * `disable` / `disableAsAdmin` は `ownerUserId` / `targetUrl` を変えない
 * ので、復帰すると元の所有者・元の遷移先がそのまま有効になる——新しく
 * 決める値は無い。
 *
 * ## 冪等
 *
 * 既に `active` のカードへもう一度叩いても失敗にしない
 * （`DelegatedReleaseCardUseCase` と同じ判断）。`issued`（未紐づけ、
 * 一度も無効化されていない）のカードは対象外——`reinstateAsAdmin` の
 * WHERE 句（`disabled` のみ）がそれを守る。
 *
 * ## 監査: 新しい名前が要る
 *
 * `card.disabled` の逆向きの遷移を記録したこれまでのイベントは無いので、
 * `card.released` を使い回した `DelegatedReleaseCardUseCase` とは違い、
 * `card.reinstated` を新設する（`domain/services/retention-policy.ts`）。
 */
export class DelegatedReinstateCardUseCase {
  constructor(
    private readonly cards: CardRepository,
    private readonly events: CardEventRecorder,
    private readonly clock: Clock,
  ) {}

  async execute(input: DelegatedReinstateCardInput): Promise<NfcOutcome<null>> {
    const card = await this.cards.findById(input.cardId);
    if (card === null) return outcomeErr({ kind: "card_not_found" });

    if (card.status !== "active") {
      const now = this.clock.now();
      const reinstated = await this.cards.reinstateAsAdmin(input.cardId, now);
      if (!reinstated) return outcomeErr({ kind: "card_not_found" });

      await this.events.record({
        cardId: input.cardId,
        event: "card.reinstated",
        actorUserId: input.actorUserId,
        metadata: { actingAsAdmin: true },
      });
    }

    return outcomeOk(null);
  }
}

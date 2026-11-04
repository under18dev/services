import type {
  AdminCardList,
  AdminCardView,
  CardRepository,
  CardTapRecorder,
  NfcOutcome,
} from "../ports";
import { outcomeOk } from "../ports";
import type { Card } from "../../domain/entities/card";

/**
 * 1 画面に出す上限（#338 Step 3）。
 *
 * **運営の画面なので件数で守っているのではない。** ここが守っているのは
 * **応答の大きさ**で、カードが数千枚になったときに 1 枚の HTML へ全部
 * 描くと、Worker の CPU 時間と本文の大きさが先に当たる。
 *
 * **上限で切ったことは画面に出す**（`AdminCardList.truncated`）。
 * 黙って切ると、運営は**全部を見たつもりで一部を見る。**
 */
export const MAX_ADMIN_LIST = 500;

/**
 * 全カードの一覧（admin-worker 経由の delegated RPC、#382 / #390 決定 16 ③）。
 *
 * **認可は持たない。** 呼べるのは admin-worker だけで、理由は
 * `DelegatedDisableCardUseCase` の冒頭。読み取りだけなので監査イベントは
 * 残さない。
 *
 * **#433 以降、全件の一覧はこれ 1 本である。** セッション Cookie で
 * `isAdmin` を確かめる `ListAllCardsUseCase`（`/account/nfc/admin` が
 * 使っていた）は、あの画面ごと消えた。上限（`MAX_ADMIN_LIST`）と写し方
 * （`toAdminView`）はあちらから移してある。
 *
 * ## これは「未紐づけカードの鍵束」である
 *
 * **#358 以降、`issued` のカードは ID を知っている人がタップすれば
 * その人のものになる。** つまりこの一覧は、**未紐づけの行については
 * 配布物そのものと同じ扱い**にしなければならない（`docs/runbook.md`）。
 * **危ないのは `issued` の行で、それがまさに出さなければならない行である。**
 *
 * ## 所有者は userId までしか出さない
 *
 * **表示名もメールアドレスも引かない。** nfc-worker は Identity D1 を
 * 持たず、`IdentityGateway` も `getSession` しか置いていない
 * （`ports.ts` の冒頭）。**名前を出すために `getUserProfile` を足すと、
 * NFC 側が侵害されたときに漏れる範囲がメールアドレスまで広がる。**
 * 誰のものかを人間が知りたい場面は、監査ログ側で突き合わせること。
 *
 * **タップ回数（#394）も一括で引く。** ここで `cardTaps` を省くと、
 * 一覧の `tapCount` が常に 0 になる——`toAdminView` は呼び出し側が渡した
 * 値をそのまま詰めるだけなので、黙って嘘の値になる。
 */
export class DelegatedListAllCardsUseCase {
  constructor(
    private readonly cards: CardRepository,
    private readonly cardTaps: CardTapRecorder,
  ) {}

  async execute(): Promise<NfcOutcome<AdminCardList>> {
    const rows = await this.cards.listAll(MAX_ADMIN_LIST);
    const truncated = rows.length > MAX_ADMIN_LIST;
    const page = rows.slice(0, MAX_ADMIN_LIST);

    const totals = await this.cardTaps.totalsFor(page.map((card) => card.id));

    return outcomeOk({
      cards: page.map((card) => toAdminView(card, totals.get(card.id) ?? 0)),
      truncated,
    });
  }
}

/**
 * Domain のカードを運営向けの表示用に落とす。
 *
 * **`card-view.ts` の `toCardView` と別にしてある。** あちらは所有者向けで
 * `ownerUserId` を落とすことに意味がある（`AdminCardView` の宣言を参照）。
 */
export function toAdminView(card: Card, tapCount: number): AdminCardView {
  return {
    cardId: card.id,
    status: card.status,
    ownerUserId: card.ownerUserId,
    targetUrl: card.targetUrl,
    batch: card.batch,
    issuedAt: card.createdAt.toISOString(),
    claimedAt: card.claimedAt?.toISOString() ?? null,
    disabledAt: card.disabledAt?.toISOString() ?? null,
    tapCount,
  };
}

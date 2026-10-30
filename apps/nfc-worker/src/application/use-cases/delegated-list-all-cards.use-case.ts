import type { AdminCardList, CardRepository, CardTapRecorder, NfcOutcome } from "../ports";
import { outcomeOk } from "../ports";
import { MAX_ADMIN_LIST, toAdminView } from "./list-all-cards.use-case";

/**
 * 全カードの一覧（admin-worker 経由の delegated RPC、#382 / #390 決定 16 ③）。
 *
 * **`ListAllCardsUseCase` との違いは、認可を持たないことだけ。** 理由は
 * `DelegatedDisableCardUseCase` の冒頭を参照。こちらは読み取りだけなので
 * 監査イベントは残さない（既存の `ListAllCardsUseCase` も残していない）。
 *
 * **上限（`MAX_ADMIN_LIST`）と写し方（`toAdminView`）はセッション版と
 * 共有する。** どちらも「誰が呼んだか」で変わる理由が無く、2 箇所に
 * 書くと片方だけ変えられる形を作る。
 *
 * **タップ回数（#394）も一括で引く。** ここで `cardTaps` を省くと、
 * admin-worker 経由の一覧だけ `tapCount` が常に 0 になる——`toAdminView`
 * は呼び出し側が渡した値をそのまま詰めるだけなので、黙って嘘の値になる。
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

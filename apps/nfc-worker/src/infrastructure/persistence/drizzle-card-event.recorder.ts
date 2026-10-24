import { newId } from "@u18/domain";
import { type NfcDatabase, nfcCardEvents } from "@u18/nfc-db";
import type { CardEventRecorder } from "../../application/ports";

/**
 * カード操作の記録（仕様書 9 の監査ログ）。
 *
 * 書き込みに失敗してもリクエスト自体は失敗させない。記録が取れないことと、
 * 利用者が自分のカードを操作できないことを天秤にかけると、前者を受け入れる
 * ——というのは一般には危うい判断なので、理由を書いておく。
 *
 * ここに残すのは「誰がいつ何をしたか」であって、認可の判断材料ではない。
 * 認可は `nfc_cards` の行そのもの（条件付き UPDATE）で閉じており、
 * イベント表が空でも他人のカードは触れない。一方、記録の失敗で
 * 遷移先の変更が落ちると、利用者から見れば「カードが壊れた」になる。
 *
 * 逆に、**認可に使う情報をこの表へ移してはならない**。移した瞬間に
 * この fail-open が穴になる。
 */
export class DrizzleCardEventRecorder implements CardEventRecorder {
  constructor(private readonly db: NfcDatabase) {}

  async record(event: {
    readonly cardId: string;
    readonly event: string;
    readonly actorUserId: string | null;
    readonly metadata?: Record<string, unknown>;
  }): Promise<void> {
    try {
      await this.db
        .insert(nfcCardEvents)
        .values({
          id: newId("nev"),
          cardId: event.cardId,
          event: event.event,
          actorUserId: event.actorUserId,
          ...(event.metadata === undefined ? {} : { metadata: event.metadata }),
        })
        .run();
    } catch (cause) {
      // 失敗の事実だけを残す。cardId / userId はログにも出さない
      // （仕様書 4.4「機密情報をトレース・ログへ記録しない」）。
      console.error("failed to record nfc card event", cause);
    }
  }
}

import { CLAIM_CODE_TTL_MS } from "../../domain/entities/card";
import type {
  CardEventRecorder,
  CardRepository,
  CardView,
  ClaimCodeService,
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
  /** カードに同梱された紐づけコード。タグには書かれていない。 */
  readonly claimCode: string;
};

/**
 * カードを自分のアカウントへ紐づける（初回紐づけ・移転の後半）。
 *
 * ## NFC タグをログイン資格情報にしないということ
 *
 * 仕様書 10 の「NFCタグ自体はログイン資格情報にしない」は、
 * 「タグを持っていてもログインできない」だけを指していない。
 * **タグを読めることが所有の証明になってはならない**、も含む。
 * 一般的な URL タグは誰でもかざせるし、URL は複製できる。
 *
 * したがって紐づけに必要なものは 2 つある。
 *
 * 1. **u18 Identity のセッション** — 誰のアカウントに結ぶかを決める。
 *    これは auth-worker が検証したものしか受け取らない。
 * 2. **タグに書かれていない紐づけコード** — どのカードを結ぶかを決める。
 *    配布時に封緘・スクラッチで渡し、ハッシュだけを保存する。
 *
 * この 2 つを分けることで、「カード読み取り」と「アカウント認証」の責務が
 * 分かれる（仕様書 10 の最後の項目）。片方だけでは何も起きない。
 *
 * ## 失敗の理由を区別しない
 *
 * カードが無い・既に誰かのもの・コードが違う・期限切れをすべて
 * `claim_rejected` にする。区別すると、総当たりしている相手に
 * 「カード ID は当たっている」と教えることになる。
 *
 * ## 残余リスク: 紐づけコードの総当たり
 *
 * ここにはレート制限が無い。#21 で auth-worker の `/api/auth/email/*` と
 * `/api/auth/passkeys/login/verify` には入ったが、**nfc-worker はどの経路にも
 * かかっていない**（binding も持っていない）。コード自体が十分長い乱数なので
 * 現実的な脅威は小さいが、試行回数の制限は別途必要。残件として #31 に残す。
 *
 * 入れるときは auth-worker の `RateLimitPolicy` と同じ形（`wrangler.jsonc` の
 * `ratelimits` + ポリシー定数 + 設定照合テスト）に揃えること。binding の
 * `period` が 10 / 60 秒しか取れないので、持続的な総当たりには別の層が要る。
 */
export class ClaimCardUseCase {
  constructor(
    private readonly identity: IdentityGateway,
    private readonly cards: CardRepository,
    private readonly events: CardEventRecorder,
    private readonly claimCodes: ClaimCodeService,
    private readonly clock: Clock,
  ) {}

  async execute(input: ClaimCardInput): Promise<NfcOutcome<CardView>> {
    const actor = await requireUserId(this.identity, input.sessionToken);
    if (!actor.ok) return actor;

    if (input.claimCode === "") return outcomeErr({ kind: "claim_rejected" });

    const now = this.clock.now();
    const claimableSince = new Date(now.getTime() - CLAIM_CODE_TTL_MS);
    const codeHash = await this.claimCodes.hash(input.claimCode);

    // 状態・ハッシュ一致・期限をすべて WHERE 句で判定する。
    // アプリ側で確かめてから UPDATE すると、同じコードを同時に出した
    // 2 人が両方成功しうる（仕様書 7.3 の単回消費と同じ問題）。
    const claimed = await this.cards.claim(
      input.cardId,
      codeHash,
      actor.value,
      claimableSince,
      now,
    );
    if (!claimed) return outcomeErr({ kind: "claim_rejected" });

    await this.events.record({
      cardId: input.cardId,
      event: "card.claimed",
      actorUserId: actor.value,
      // 紐づけコードは metadata にも書かない。
    });

    const fresh = await this.cards.findById(input.cardId);
    if (fresh === null) return outcomeErr({ kind: "claim_rejected" });
    return outcomeOk(toCardView(fresh));
  }
}

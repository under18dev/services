import { discloseCard, isConcealedForClaim } from "../../domain/services/disclosure";
import type { CardRepository, IdentityGateway, NfcOutcome } from "../ports";
import { outcomeOk } from "../ports";
import { requireUserId } from "./authenticate";

export type ViewClaimInput = {
  readonly sessionToken: string | undefined;
  readonly cardId: string;
};

export type ViewClaimOutput = {
  /** 押せる状態か。false なら画面は「利用できません」1 枚に畳む。 */
  readonly claimable: boolean;
};

/**
 * 紐づけ画面に何を出すかを決める（#358）。
 *
 * ## セッションの確認が先にある
 *
 * **カードを引く前にログインを要求する。** 順序が逆だと、ログイン画面への
 * リダイレクトと紐づけ画面の出し分けが**未認証の相手にも見えて**、
 * 「この ID は紐づけられる」が漏れる。
 *
 * 失敗をそのまま返すのは、呼び出し側が `unauthenticated` だけを
 * ログイン導線へ送るためである（`identity_unavailable` を混ぜると、
 * auth-worker が落ちている間、利用者が延々とログインし直す）。
 *
 * ## 「誰が見ているか」を使っていない
 *
 * `claimable` の判定に `userId` は要らない —— 未紐づけのカードは**誰でも**
 * 紐づけられるからである。それでもセッションを要求するのは、
 * **タグがログインの資格情報になっていないことを保つ**ため
 * （`ClaimCardUseCase` の冒頭。#358 で撤回していない側）。
 *
 * ## 畳み方は `disclosure.ts` が決める
 *
 * **`resolvable`（他人のもの）も畳む。** 「他人のカードだ」と
 * 「そんなカードは無い」の差が出ると、カード ID の総当たりに意味が出る。
 */
export class ViewClaimUseCase {
  constructor(
    private readonly identity: IdentityGateway,
    private readonly cards: CardRepository,
  ) {}

  async execute(input: ViewClaimInput): Promise<NfcOutcome<ViewClaimOutput>> {
    const actor = await requireUserId(this.identity, input.sessionToken);
    if (!actor.ok) return actor;

    const disclosure = discloseCard(await this.cards.findById(input.cardId));
    return outcomeOk({ claimable: !isConcealedForClaim(disclosure) });
  }
}

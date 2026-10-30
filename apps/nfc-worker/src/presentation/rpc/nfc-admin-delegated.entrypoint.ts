import {
  disableCardDelegatedInputSchema,
  rpcErr,
  rpcOk,
  updateCardTargetDelegatedInputSchema,
  type DisableCardDelegatedInput,
  type DisableCardDelegatedResult,
  type NfcAdminDelegatedRpcContract,
  type RpcErrorCode,
  type UpdateCardTargetDelegatedInput,
  type UpdateCardTargetDelegatedResult,
} from "@u18/contracts";
import { WorkerEntrypoint } from "cloudflare:workers";
import { createContainer } from "../../composition/container";
import type { NfcFailure } from "../../domain/errors";

/**
 * `NfcFailure` を RPC 契約のエラーコードへ翻訳する。
 *
 * **delegated の経路は `unauthenticated` / `forbidden` を返さない**
 * （認可を持たないので、そもそも UseCase がその種類を作らない）。
 * それでも網羅的に書くのは、UseCase 側に将来その種類が増えたときに
 * `default` へ落ちて `internal` になる —— 気づけないよりはよい。
 */
function toRpcCode(kind: NfcFailure["kind"]): RpcErrorCode {
  switch (kind) {
    case "card_not_found":
      return "not_found";
    case "invalid_target_url":
    case "claim_rejected":
      return "invalid_input";
    case "identity_unavailable":
      return "internal";
    case "unauthenticated":
    case "forbidden":
      // ここには来ないはずの種類。network 越しの応答としては internal に畳む。
      return "internal";
  }
}

/**
 * admin-worker から nfc-worker のカード管理を呼ぶ内部 RPC
 * （#382「他人のカードへの操作」/ #390 決定 16 ③）。
 *
 * ## `IdentityAdminDelegatedRPC`（auth-worker）と対になる
 *
 * admin-worker は OIDC で admin-worker 自身にログインし、admin-worker
 * 独自の承認リストで管理者性を確認済み。auth-worker のセッション Cookie
 * を持たないので、**既存の `sessionToken` 必須な経路（`cards.routes.ts`
 * の JSON API、`cards-ui.routes.tsx` の画面）をそのまま呼べない。**
 *
 * ## trust boundary は Service Binding そのものである
 *
 * **ここでは `actorUserId` を検証しない。** `NfcAdminDelegatedRpcContract`
 * の冒頭に理由がある —— この Entrypoint へ辿り着けること自体が
 * Service Binding で保証されており、admin-worker は呼ぶ前に自分の
 * 承認リストで管理者性を確かめている。二重に確かめる理由が無い。
 *
 * **この Entrypoint を束縛してよいのは admin-worker だけである。**
 * ただし**いまはまだ検査されていない** —— `scripts/check-service-bindings.mjs`
 * の allow-list は、admin-worker の `wrangler.jsonc` に実際の束縛が
 * 増えたとき（binding の PR）に足すこと。それまでは「束縛する相手が
 * 1 つも無い」状態で、検査対象にすら入っていない。
 *
 * ## `IdentityRPC` / `IdentityAdminRPC` とは別の仕組みである
 *
 * nfc-worker はこれまで Identity への**消費者**（`RpcIdentityGateway`）
 * でしかなかった。**この Entrypoint が、nfc-worker が初めて公開する
 * RPC である**（`index.ts` の「RPC Entrypoint を公開しない」という
 * 記述を更新すること）。
 */
export class NfcAdminDelegatedRPC
  extends WorkerEntrypoint<Env>
  implements NfcAdminDelegatedRpcContract
{
  /**
   * 他人のカードを無効化する（#382）。
   *
   * 認可は admin-worker 側で完結している。ここは入力検証と
   * `DelegatedDisableCardUseCase` への橋渡しだけを行う。
   */
  async disableCard(input: DisableCardDelegatedInput): Promise<DisableCardDelegatedResult> {
    const parsed = disableCardDelegatedInputSchema.safeParse(input);
    if (!parsed.success) return rpcErr("invalid_input", "actorUserId or cardId is malformed");

    const container = createContainer(this.env);
    const result = await container.useCases.delegatedDisableCard.execute({
      actorUserId: parsed.data.actorUserId,
      cardId: parsed.data.cardId,
    });
    if (!result.ok) return rpcErr(toRpcCode(result.failure.kind), result.failure.kind);

    return rpcOk(null);
  }

  /**
   * 他人のカードの遷移先を書き換える（#382）。
   *
   * **URL の不正だけ、理由を応答へ出す。** `validateTargetUrl` の
   * `reason` は閉じた集合（`too_long` / `not_https` など）で、
   * 自由文を含まない。admin-worker 側の画面がこれを人間向けの文言へ
   * 訳す（`cards-page.tsx` が所有者向けにやっているのと同じ形）。
   */
  async updateCardTarget(
    input: UpdateCardTargetDelegatedInput,
  ): Promise<UpdateCardTargetDelegatedResult> {
    const parsed = updateCardTargetDelegatedInputSchema.safeParse(input);
    if (!parsed.success) {
      return rpcErr("invalid_input", "actorUserId, cardId or targetUrl is malformed");
    }

    const container = createContainer(this.env);
    const result = await container.useCases.delegatedUpdateCardTarget.execute({
      actorUserId: parsed.data.actorUserId,
      cardId: parsed.data.cardId,
      targetUrl: parsed.data.targetUrl,
    });
    if (!result.ok) {
      const detail =
        result.failure.kind === "invalid_target_url" ? result.failure.reason : result.failure.kind;
      return rpcErr(toRpcCode(result.failure.kind), detail);
    }

    return rpcOk(null);
  }
}

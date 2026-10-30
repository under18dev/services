import { z } from "zod";
import type { RpcResult } from "./errors";

/**
 * nfc-worker の **`NfcAdminDelegatedRPC`** が公開する DTO（#382「他人の
 * カードへの操作」、#390 決定 16 ③）。
 *
 * ## なぜ `IdentityAdminDelegatedRPC` と同じ「delegated」系なのか
 *
 * admin-worker は OIDC で admin-worker 自身にログインし、admin-worker
 * 独自の承認リストで管理者性を確認している。auth-worker のセッション
 * Cookie を持たないので、**既存の管理 API（`sessionToken` 必須）を
 * そのまま呼べない。** d5 が auth-worker 側に設計した
 * `IdentityAdminDelegatedRPC` と同じ形を nfc-worker にも用意する。
 *
 * ## trust boundary は Service Binding そのものである
 *
 * **ここに届く `actorUserId` を検証しない。** 検証しなくてよい理由は、
 * この Entrypoint へ辿り着けること自体が Service Binding で保証されて
 * いるから —— admin-worker だけがこの Entrypoint を束縛でき、
 * admin-worker は呼ぶ前に自分の承認リストで管理者性を確かめている。
 * 二重に確かめる理由が無い（運用者の判断：権限判定は admin-worker 側へ
 * 全面移行）。
 *
 * **`actorUserId` は admin-worker が申告する ID Token の `sub`。**
 * nfc-worker はこの値を検証していない —— **admin-worker 自身の承認
 * リストの正しさに依存する。** `docs/threat-model.md` N-10 に同じ注記がある。
 *
 * ## セッション Cookie 経由の既存契約とは別にしてある
 *
 * `cards.routes.ts` / `cards-ui.routes.tsx` が使う JSON API・画面は
 * 一切変えていない。**この契約は admin-worker からの Service Binding
 * 経由の呼び出し専用**で、HTTP 経路は持たない。
 */

export const disableCardDelegatedInputSchema = z.object({
  /** admin-worker が確認済みの、操作者（運営）の userId。検証しない。 */
  actorUserId: z.string().min(1),
  cardId: z.string().min(1),
});

export type DisableCardDelegatedInput = z.infer<typeof disableCardDelegatedInputSchema>;
export type DisableCardDelegatedResult = RpcResult<null>;

export const updateCardTargetDelegatedInputSchema = z.object({
  actorUserId: z.string().min(1),
  cardId: z.string().min(1),
  targetUrl: z.string().min(1),
});

export type UpdateCardTargetDelegatedInput = z.infer<typeof updateCardTargetDelegatedInputSchema>;
export type UpdateCardTargetDelegatedResult = RpcResult<null>;

/**
 * `NfcAdminDelegatedRPC` の契約。
 *
 * **メソッドが増えるたびに、ここと Entrypoint の両方を変えること。**
 * Service Binding はメソッド単位で絞れないので、この Entrypoint を
 * 束縛した Worker は定義した全メソッドを呼べる —— 束縛先は admin-worker
 * だけにすること（`scripts/check-service-bindings.mjs`）。
 */
export interface NfcAdminDelegatedRpcContract {
  disableCard(input: DisableCardDelegatedInput): Promise<DisableCardDelegatedResult>;
  updateCardTarget(input: UpdateCardTargetDelegatedInput): Promise<UpdateCardTargetDelegatedResult>;
}

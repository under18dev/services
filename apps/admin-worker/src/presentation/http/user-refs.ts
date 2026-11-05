import type { IdentityAdminDelegatedRpcContract, UserRefAdmin } from "@u18/contracts";

/**
 * `getUsersByIdsDelegatedInputSchema` の上限と揃える。超えた分は複数回に
 * 分けて呼ぶ——1 画面に出す行数がこの先増えても、呼び出し側を直さずに
 * 済む。
 */
const MAX_IDS_PER_CALL = 100;

function chunk<T>(items: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < items.length; i += size) result.push(items.slice(i, i + size));
  return result;
}

/**
 * カードの所有者・監査ログの actor を名前で出すための、まとめ名前解決
 * （#471）。
 *
 * **ここで `null` と重複を落とす。** `getUsersByIdsDelegatedInputSchema`
 * 側は検証しない（契約の JSDoc を参照）——呼ぶ側がここで 1 回だけ落とす
 * ことにして、重複した仕事をしない。
 *
 * **解決できなかった ID は、返す `Map` に入らない。** 呼び出し側
 * （`ui/user-ref.tsx`）は、`Map` に無いことを「名前が引けなかった」と
 * 解釈する——「行が存在しない」との区別は、ここでは付けない（契約の
 * `GetUsersByIdsDelegatedResult` と同じ判断。見つからなかった理由まで
 * 運ぶ必要はなく、運用者が見るのは結局 ID そのものである）。
 *
 * **RPC が落ちても例外を投げず、空の `Map` を返す。** 名前が出ないだけで
 * 一覧そのものは出る——`app.tsx` のホームが `Promise.allSettled` で
 * 「取れた塊だけ出す」のと同じ判断。1 回の呼び出しが落ちても、他の
 * チャンクで取れた分は生かす。
 */
export async function resolveUserRefs(
  identityAdmin: IdentityAdminDelegatedRpcContract,
  actorUserId: string,
  userIds: readonly (string | null)[],
): Promise<ReadonlyMap<string, UserRefAdmin>> {
  const unique = [...new Set(userIds.filter((id): id is string => id !== null && id !== ""))];
  if (unique.length === 0) return new Map();

  const settled = await Promise.allSettled(
    chunk(unique, MAX_IDS_PER_CALL).map((batch) =>
      identityAdmin.getUsersByIds({ actorUserId, userIds: batch }),
    ),
  );

  const refs = new Map<string, UserRefAdmin>();
  for (const result of settled) {
    if (result.status !== "fulfilled" || !result.value.ok) continue;
    for (const ref of result.value.value) refs.set(ref.id, ref);
  }
  return refs;
}

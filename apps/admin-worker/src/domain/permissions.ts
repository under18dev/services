/**
 * admin.under18.dev の操作ごとの権限（#190）。
 *
 * ## ビットは BigInt
 *
 * JavaScript のビット演算子（`&` `|` `<<`）はオペランドを 32 ビット
 * 符号付き整数に落とす。`number` で持つと 32 本目のビットから静かに
 * 壊れる——「いまは 8 個しか無いから大丈夫」という判断は、増やした日に
 * 壊れる。BigInt のビット演算は任意精度なので、**この壁が構造的に
 * 存在しない。** 31 本で打ち止めにする案より、こちらを選んだ。
 *
 * D1（SQLite）に BigInt 用の列型は無いので、永続化層（`admin_approvals.
 * permissions`）は 10 進文字列の TEXT で持つ。ここより外（SQL・CLI の
 * 表示・RPC）へ出すときは、必ずこのファイルの関数を経由すること。
 *
 * ## `isSuperApprover` はビットの集合ではない
 *
 * 最高権限は「全ビットを持っている状態」ではなく、**権限チェックそのものを
 * 無条件にバイパスする状態**として扱う。ビットを 1 つ足した日、
 * 「全ビット」の定義が動く——もし super を「保存された全ビット」から
 * 判定すると、新しいビットを足した瞬間に既存の super 行が「それを
 * 持っていない」ことになり、バイパスで実際には通るのに画面には
 * 「持っていない」と出る、という矛盾した表示になる。
 *
 * 移行時・監査のため、super な行には「いま定義されている全ビット」も
 * 実際に立てる（`0002_backfill_existing_approvals_permissions.sql`）が、
 * それは記録の都合であって、判定にも表示にも使わない——
 * **判定にも表示にも、常に `effectivePermissions()` を経由すること。**
 */

export const PERMISSION_BITS = {
  NFC_READ: 1n << 0n,
  NFC_WRITE: 1n << 1n,
  USER_READ: 1n << 2n,
  USER_SUSPEND: 1n << 3n,
  CLIENT_READ: 1n << 4n,
  CLIENT_WRITE: 1n << 5n,
  AUDIT_READ: 1n << 6n,
  /**
   * 他人の権限ビット・`isSuperApprover` を付与・剥奪してよい。
   *
   * **`isSuperApprover`（root）より弱い、委譲可能な権限。** これを持つ人は
   * 権限管理を任せられるが、`isSuperApprover` が持つ「全チェックの
   * 無条件バイパス」までは持たない。
   */
  APPROVAL_GRANT: 1n << 7n,
  /**
   * 利用者の行を物理的に削除してよい（運用者判断、2026-11-08）。
   *
   * **`USER_SUSPEND` を再利用しない。** 凍結は可逆（`reinstateUser` で
   * 戻せる）だが、物理削除は戻せない——決定 7（凍結で表現し、物理削除
   * しない）を運用者が明示的に覆してまで作る操作である。同じビットに
   * 載せると、「凍結だけ任せたつもり」の相手に削除まで渡ることになる。
   */
  USER_DELETE: 1n << 8n,
} as const satisfies Record<string, bigint>;

export type PermissionBitName = keyof typeof PERMISSION_BITS;

/** いま定義されている全ビット。移行の既定値（255）と一致することをテストで固定する。 */
export const ALL_DEFINED_PERMISSIONS: bigint = Object.values(PERMISSION_BITS).reduce(
  (acc, bit) => acc | bit,
  0n,
);

/**
 * D1（TEXT の 10 進文字列）からビット集合を読む。
 *
 * 空文字列や壊れた値を `0n` に丸めない——読めない値を権限ゼロとして
 * 通すと、データが壊れていることに誰も気づけない。呼び出し側に
 * 例外として伝える。
 */
export function parsePermissions(raw: string): bigint {
  return BigInt(raw);
}

/** D1 へ書き戻す形（10 進文字列）にする。 */
export function formatPermissions(bits: bigint): string {
  return bits.toString(10);
}

export type ApprovalRow = {
  readonly isSuperApprover: boolean;
  readonly permissions: bigint;
};

export type EffectivePermissions =
  { readonly kind: "super" } | { readonly kind: "bits"; readonly bits: bigint };

/**
 * 判定にも表示にも使う、唯一の入口。
 *
 * super は「チェックをバイパスする状態」そのもので、`bits` の中身は
 * 無視する——保存された値が何であっても関係ない。
 */
export function effectivePermissions(row: ApprovalRow): EffectivePermissions {
  return row.isSuperApprover ? { kind: "super" } : { kind: "bits", bits: row.permissions };
}

/** そのビットを持つか。super は常に true。 */
export function hasPermission(effective: EffectivePermissions, bit: bigint): boolean {
  return effective.kind === "super" || (effective.bits & bit) !== 0n;
}

/**
 * 表示用の内訳。
 *
 * **super は `"ALL"` を返し、ビットを列挙しない。** 保存された全ビットを
 * 読んで列挙すると、新しいビットを足した日に super の表示だけ古いままに
 * なる（上のファイル冒頭コメントを参照）。
 */
export function permissionNames(
  effective: EffectivePermissions,
): "ALL" | readonly PermissionBitName[] {
  if (effective.kind === "super") return "ALL";
  const names = Object.keys(PERMISSION_BITS) as readonly PermissionBitName[];
  return names.filter((name) => (effective.bits & PERMISSION_BITS[name]) !== 0n);
}

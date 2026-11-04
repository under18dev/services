/**
 * 自分で自分を締め出せないようにする（#190、要件⑤）。
 *
 * CLI（`scripts/admin-approval.mjs`）と、将来の `/approvals` 画面の
 * どちらも、承認・権限を変える前に**ここだけ**を通す。判定を 2 か所に
 * 書くと、片方だけ直す事故が起きる（`route-permissions.ts` の
 * 「判定は 1 箇所」と同じ考え方）。
 *
 * ここは D1 を読まない。呼び出し側が先に現在の状態（対象が super か、
 * super approver が何人いるか）を調べて渡す——このファイルは純粋な
 * 判定だけに留め、クエリの組み立てを混ぜない。
 *
 * **`./permissions.ts` を import しない。** CLI（`admin-approval.mjs`）は
 * このファイルを `node:child_process` を経由せず直接 `import()` するが、
 * Node の ESM ローダーは拡張子無しの相対 import（`./permissions`）を
 * `.ts` へ自動解決しない——かといって `.ts` を付けると今度は tsc が
 * `allowImportingTsExtensions` 無しでは受け付けない（実測、どちらの形も
 * 試して確かめた）。ビット値そのものではなく `isApprovalGrantBit`
 * （真偽値）を呼び出し側に判定させて渡すことで、この相対 import 自体を
 * 無くした。
 */
export type LockoutCheck = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/**
 * `is_super_approver` を変える操作（降格のときだけ意味を持つ）。
 *
 * **自分自身の降格は、他に super approver が何人いても拒否する。**
 * 「最後の 1 人を落とせない」だけでは、自分で自分の最高権限を落として
 * 他の super approver に頼らざるを得なくなる形（意図した操作ではあるが
 * 取り消せない）を止められない——要件⑤の「自分の付与権限を自分で
 * 落とせない」はこれを指す。
 */
export function checkSuperApproverChange(input: {
  readonly actorSub: string;
  readonly targetSub: string;
  readonly targetIsCurrentlySuperApprover: boolean;
  readonly newIsSuperApprover: boolean;
  readonly totalSuperApproverCount: number;
}): LockoutCheck {
  const isDemotion = input.targetIsCurrentlySuperApprover && !input.newIsSuperApprover;
  if (!isDemotion) return { ok: true };

  if (input.actorSub === input.targetSub) {
    return {
      ok: false,
      reason: "自分自身の super approver を自分で落とせない。他の super approver に頼むこと。",
    };
  }
  if (input.totalSuperApproverCount <= 1) {
    return {
      ok: false,
      reason: "最後の super approver を降格できない。復旧の手段が CLI にも無くなる。",
    };
  }
  return { ok: true };
}

/**
 * 承認そのものを剥奪する（行を削除する）操作。
 *
 * 対象が super approver でなければ常に通る——「承認されているが
 * super ではない」人を自分自身で剥奪することは、締め出しではなく
 * 本人の離脱として扱ってよい。
 */
export function checkApprovalRevocation(input: {
  readonly actorSub: string;
  readonly targetSub: string;
  readonly targetIsCurrentlySuperApprover: boolean;
  readonly totalSuperApproverCount: number;
}): LockoutCheck {
  if (!input.targetIsCurrentlySuperApprover) return { ok: true };

  if (input.actorSub === input.targetSub) {
    return {
      ok: false,
      reason: "自分自身の承認を剥奪できない（super approver）。他の super approver に頼むこと。",
    };
  }
  if (input.totalSuperApproverCount <= 1) {
    return {
      ok: false,
      reason: "最後の super approver の承認を剥奪できない。復旧の手段が CLI にも無くなる。",
    };
  }
  return { ok: true };
}

/**
 * 個別の権限ビットを剥奪する操作。
 *
 * **`APPROVAL_GRANT` の自己剥奪だけを拒否する。** 他のビットは、
 * 自分自身から剥奪しても締め出しにはならない（また付与できる人が
 * 他に居るか、CLI から戻せる）。`APPROVAL_GRANT` を自分で落とすと、
 * それを戻せるのは他の `APPROVAL_GRANT` 保持者か super approver だけに
 * なる——事故で自分の権限管理能力だけを失う経路を塞ぐ。
 */
export function checkPermissionRevocation(input: {
  readonly actorSub: string;
  readonly targetSub: string;
  /** 剥奪しようとしているビットが `PERMISSION_BITS.APPROVAL_GRANT` か。 */
  readonly isApprovalGrantBit: boolean;
}): LockoutCheck {
  if (input.actorSub === input.targetSub && input.isApprovalGrantBit) {
    return {
      ok: false,
      reason: "自分自身の APPROVAL_GRANT を自分で落とせない。他の権限管理者に頼むこと。",
    };
  }
  return { ok: true };
}

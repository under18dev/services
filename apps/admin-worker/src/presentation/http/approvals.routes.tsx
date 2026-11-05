import type { Context, Hono } from "hono";
import {
  checkApprovalRevocation,
  checkPermissionRevocation,
  checkSuperApproverChange,
} from "../../domain/approval-guard";
import { PERMISSION_BITS, type PermissionBitName } from "../../domain/permissions";
import { APPROVAL_AUDIT_EVENTS } from "../../domain/approval-audit-events";
import { CSRF_FIELD_NAME, ensureCsrfToken, isValidCsrf } from "./csrf";
import { csrfRejected } from "./ui/message-page";
import { ApprovalsPage } from "./ui/approvals-page";
import { resolveUserRefs } from "./user-refs";
import type { AppBindings } from "./types";

/**
 * 承認者・権限の管理画面（`admin.under18.dev/approvals`、#190）。
 *
 * **以前は `scripts/admin-approval.mjs`（`wrangler d1 execute` 越し）が
 * 唯一の経路だった。** CLI は残す（締め出しからの復旧経路）が、画面からも
 * 同じ操作ができる——`domain/approval-guard.ts` の締め出し防止は
 * CLI と共有している。
 *
 * **画面側は `session.sub` を知っている分、CLI より強い。** CLI には
 * 「いま実行しているのが誰か」という sub が無く、自分自身の判定が
 * 実質効かない（`admin-approval.mjs` の `NO_ACTOR_SUB` を参照）。ここでは
 * `checkSuperApproverChange` / `checkApprovalRevocation` /
 * `checkPermissionRevocation` の自分自身の判定が実際に働く。
 */

function isValidPermissionBitName(value: string): value is PermissionBitName {
  return value in PERMISSION_BITS;
}

export function registerApprovalsRoutes(app: Hono<AppBindings>): void {
  app.get("/approvals", (c) => renderApprovalsPage(c, {}));

  /** 新しい承認（#190）。 */
  app.post("/approvals", async (c) => {
    const form = await c.req.formData().catch(() => null);
    if (form === null || !isValidCsrf(c, form.get(CSRF_FIELD_NAME)?.toString())) {
      c.header("Cache-Control", "no-store");
      return csrfRejected(c, "/approvals");
    }

    const sub = (form.get("sub")?.toString() ?? "").trim();
    if (sub === "") return renderApprovalsPage(c, { error: "sub を入力してください。" });

    const session = c.get("session");
    const container = c.get("container");
    const isSuperApprover = form.get("is_super_approver")?.toString() === "true";

    await container.approvals.grant(sub, isSuperApprover, session.sub);
    await container.approvals.recordAuditEvent({
      event: APPROVAL_AUDIT_EVENTS.granted.event,
      sub,
      actor: session.sub,
      reason: "granted_via_ui",
    });

    return renderApprovalsPage(c, { notice: `${sub} を承認しました。` });
  });

  /** super approver の切り替え。**最後の 1 人・自分自身の降格は拒否される。** */
  app.post("/approvals/:sub/super", async (c) => {
    const form = await c.req.formData().catch(() => null);
    if (form === null || !isValidCsrf(c, form.get(CSRF_FIELD_NAME)?.toString())) {
      c.header("Cache-Control", "no-store");
      return csrfRejected(c, "/approvals");
    }

    const targetSub = c.req.param("sub");
    const newIsSuperApprover = form.get("is_super_approver")?.toString() === "true";
    const session = c.get("session");
    const container = c.get("container");

    const current = await container.approvals.getBySub(targetSub);
    if (current === null) {
      return renderApprovalsPage(c, { error: `${targetSub} は承認されていません。` });
    }

    const totalSuperApproverCount = await container.approvals.countSuperApprovers();
    const check = checkSuperApproverChange({
      actorSub: session.sub,
      targetSub,
      targetIsCurrentlySuperApprover: current.isSuperApprover,
      newIsSuperApprover,
      totalSuperApproverCount,
    });
    if (!check.ok) return renderApprovalsPage(c, { error: check.reason });

    await container.approvals.grant(targetSub, newIsSuperApprover, current.approvedBySub);
    await container.approvals.recordAuditEvent({
      event: newIsSuperApprover
        ? APPROVAL_AUDIT_EVENTS.granted.event
        : APPROVAL_AUDIT_EVENTS.revoked.event,
      sub: targetSub,
      actor: session.sub,
      reason: newIsSuperApprover ? "super_promoted_via_ui" : "super_demoted_via_ui",
    });

    return renderApprovalsPage(c, { notice: `${targetSub} の super approver を更新しました。` });
  });

  /**
   * 権限ビットの一括更新。**チェックボックスの最終状態をそのまま保存する。**
   *
   * 1 本ずつの付与・剥奪ではなく全体を送るので、変更されたビットだけを
   * 洗い出して、`APPROVAL_GRANT` の自己剥奪だけを別途拒否し、
   * 変わったビットごとに監査イベントを記号名で残す。
   */
  app.post("/approvals/:sub/permissions", async (c) => {
    const form = await c.req.formData().catch(() => null);
    if (form === null || !isValidCsrf(c, form.get(CSRF_FIELD_NAME)?.toString())) {
      c.header("Cache-Control", "no-store");
      return csrfRejected(c, "/approvals");
    }

    const targetSub = c.req.param("sub");
    const session = c.get("session");
    const container = c.get("container");

    const current = await container.approvals.getBySub(targetSub);
    if (current === null) {
      return renderApprovalsPage(c, { error: `${targetSub} は承認されていません。` });
    }

    let newBits = 0n;
    for (const value of form.getAll("bit")) {
      const name = value.toString();
      if (isValidPermissionBitName(name)) newBits |= PERMISSION_BITS[name];
    }

    const removedBits = current.permissions & ~newBits;
    const addedBits = newBits & ~current.permissions;

    if ((removedBits & PERMISSION_BITS.APPROVAL_GRANT) !== 0n) {
      const check = checkPermissionRevocation({
        actorSub: session.sub,
        targetSub,
        isApprovalGrantBit: true,
      });
      if (!check.ok) return renderApprovalsPage(c, { error: check.reason });
    }

    await container.approvals.setPermissions(targetSub, newBits);

    for (const name of Object.keys(PERMISSION_BITS) as PermissionBitName[]) {
      const bit = PERMISSION_BITS[name];
      if ((addedBits & bit) !== 0n) {
        await container.approvals.recordAuditEvent({
          event: APPROVAL_AUDIT_EVENTS.permissionGranted.event,
          sub: targetSub,
          actor: session.sub,
          reason: "granted_via_ui",
          detail: name,
        });
      }
      if ((removedBits & bit) !== 0n) {
        await container.approvals.recordAuditEvent({
          event: APPROVAL_AUDIT_EVENTS.permissionRevoked.event,
          sub: targetSub,
          actor: session.sub,
          reason: "revoked_via_ui",
          detail: name,
        });
      }
    }

    return renderApprovalsPage(c, { notice: `${targetSub} の権限を更新しました。` });
  });

  /** 承認そのものの剥奪。**最後の super approver・自分自身の剥奪は拒否される。** */
  app.post("/approvals/:sub/revoke", async (c) => {
    const form = await c.req.formData().catch(() => null);
    if (form === null || !isValidCsrf(c, form.get(CSRF_FIELD_NAME)?.toString())) {
      c.header("Cache-Control", "no-store");
      return csrfRejected(c, "/approvals");
    }

    const targetSub = c.req.param("sub");
    const session = c.get("session");
    const container = c.get("container");

    const current = await container.approvals.getBySub(targetSub);
    if (current === null) {
      return renderApprovalsPage(c, { error: `${targetSub} は承認されていません。` });
    }

    const totalSuperApproverCount = await container.approvals.countSuperApprovers();
    const check = checkApprovalRevocation({
      actorSub: session.sub,
      targetSub,
      targetIsCurrentlySuperApprover: current.isSuperApprover,
      totalSuperApproverCount,
    });
    if (!check.ok) return renderApprovalsPage(c, { error: check.reason });

    await container.approvals.revoke(targetSub);
    await container.approvals.recordAuditEvent({
      event: APPROVAL_AUDIT_EVENTS.revoked.event,
      sub: targetSub,
      actor: session.sub,
      reason: "revoked_via_ui",
    });

    return renderApprovalsPage(c, { notice: `${targetSub} の承認を剥奪しました。` });
  });
}

/** 一覧をもう一度引いて画面を描き直す。**4 本の経路すべてが共有する**（`clients.routes.tsx` と同じ理由）。 */
async function renderApprovalsPage(
  c: Context<AppBindings>,
  extra: { readonly error?: string; readonly notice?: string },
): Promise<Response> {
  const container = c.get("container");
  const session = c.get("session");
  const approvals = await container.approvals.listAll();
  // **`sub` と `approvedBySub` を 1 回でまとめて解決する**（#482）。
  // `resolveUserRefs` 自身が null と重複を落とすので、ここで選り分けない。
  const refs = await resolveUserRefs(
    container.identityAdmin,
    session.sub,
    approvals.flatMap((approval) => [approval.sub, approval.approvedBySub]),
  );

  c.header("Cache-Control", "no-store");
  return c.html(
    <ApprovalsPage
      csrfToken={ensureCsrfToken(c)}
      approvals={approvals}
      viewerSub={session.sub}
      refs={refs}
      {...(extra.error === undefined ? {} : { error: extra.error })}
      {...(extra.notice === undefined ? {} : { notice: extra.notice })}
    />,
  );
}

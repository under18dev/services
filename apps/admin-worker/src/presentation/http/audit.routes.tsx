import { pageSecurityHeaders } from "@u18/web-ui";
import type { Context, Hono } from "hono";
import { CSRF_FIELD_NAME, ensureCsrfToken, isValidCsrf } from "./csrf";
import { AuditPage } from "./ui/audit-page";
import type { AppBindings } from "./types";

/**
 * 監査ログの閲覧画面（`admin.under18.dev/audit`、#375 / #382 / #390 決定 16 ③）。
 *
 * **`/account/admin/audit`（dashboard-worker、#375）から移した。**
 * `users.routes.tsx` と同じ形——呼び方だけが `actorUserId` 経由の
 * `IdentityAdminDelegatedRPC` に変わった。読むだけの画面なので、
 * PRG や通知の心配は無い。
 */

export function registerAuditRoutes(app: Hono<AppBindings>): void {
  app.get("/audit", pageSecurityHeaders, async (c) => renderAuditPage(c, {}));

  app.post("/audit/search", pageSecurityHeaders, async (c) => {
    const form = await c.req.formData().catch(() => null);
    if (form === null || !isValidCsrf(c, form.get(CSRF_FIELD_NAME)?.toString())) {
      c.header("Cache-Control", "no-store");
      return c.text("forbidden", 403);
    }

    const event = form.get("event")?.toString().trim() ?? "";
    const userId = form.get("user_id")?.toString().trim() ?? "";
    const outcome = form.get("outcome")?.toString();
    const cursor = form.get("cursor")?.toString().trim() ?? "";

    return renderAuditPage(c, {
      ...(event === "" ? {} : { event }),
      ...(userId === "" ? {} : { userId }),
      ...(outcome === "success" || outcome === "failure" ? { outcome } : {}),
      ...(cursor === "" ? {} : { cursor }),
    });
  });
}

async function renderAuditPage(
  c: Context<AppBindings>,
  options: {
    event?: string;
    userId?: string;
    outcome?: "success" | "failure";
    cursor?: string;
    error?: string;
  },
): Promise<Response> {
  const session = c.get("session");
  const container = c.get("container");

  const page = await container.identityAdmin.listAuditLogs({
    actorUserId: session.sub,
    ...(options.event === undefined ? {} : { event: options.event }),
    ...(options.userId === undefined ? {} : { userId: options.userId }),
    ...(options.outcome === undefined ? {} : { outcome: options.outcome }),
    ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
  });
  if (!page.ok) {
    return c.text("しばらくしてからもう一度お試しください。", 503);
  }

  c.header("Cache-Control", "no-store");
  return c.html(
    <AuditPage
      csrfToken={ensureCsrfToken(c)}
      entries={page.value.entries}
      nextCursor={page.value.nextCursor}
      {...(options.event === undefined ? {} : { event: options.event })}
      {...(options.userId === undefined ? {} : { userId: options.userId })}
      {...(options.outcome === undefined ? {} : { outcome: options.outcome })}
      {...(options.error === undefined ? {} : { error: options.error })}
    />,
  );
}

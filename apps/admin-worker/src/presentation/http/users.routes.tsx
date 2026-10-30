import { pageSecurityHeaders } from "@u18/web-ui";
import type { IdentityAdminDelegatedRpcContract, RpcError, SuspendReason } from "@u18/contracts";
import type { Context, Hono } from "hono";
import { CSRF_FIELD_NAME, ensureCsrfToken, isValidCsrf } from "./csrf";
import { UsersPage } from "./ui/users-page";
import type { AppBindings } from "./types";

/**
 * 利用者の管理画面（`admin.under18.dev/users`、#375 / #382 / #390 決定 16 ③）。
 *
 * **`/account/admin/users`（dashboard-worker、#375 / #387）から移した。**
 * 呼び方だけが変わった——`sessionToken` 経由の `IdentityAdminRPC` ではなく、
 * `actorUserId` 経由の `IdentityAdminDelegatedRPC`（Service Binding）を呼ぶ。
 *
 * ## `actorUserId` は `c.get("session").sub`
 *
 * **検証しない。** セッションガード（`app.ts`）が既に「ログイン済み・
 * 承認リストにある・パスキーで入った」ことを確かめたあとにしかここへ
 * 来ない。`IdentityAdminDelegatedRpcContract` の trust boundary の
 * 説明を参照（`nfc.routes.tsx` と同じ形）。
 *
 * ## 操作ごとに別の route にする
 *
 * 1 つの form の `action` フィールドで押し分けていた dashboard-worker 版
 * と違い、`/users/:userId/suspend` のように URL が操作を表す
 * （`nfc.routes.tsx` の `/nfc/:cardId/disable` と同じ形）。
 *
 * ## PRG（成功したら 303 で一覧へ戻す）
 *
 * 停止も解除も「状態を見てから書く」（`setStatus` の `from`）ので、
 * 303 のあと再送されても 2 度目は `conflict` になるだけで状態は動かない。
 * 失敗したときは 303 で戻さず、同じ画面を描き直す（`nfc.routes.tsx` と
 * 同じ判断——失敗の理由をクエリに載せると URL から差し替えられる）。
 *
 * 成功後の 1 文は、切った端末の件数だけをクエリへ乗せて組み立てる
 * （`nfc.routes.tsx` の `ISSUED_COUNT_PARAM` と同じ形。ID は運ばない）。
 */

const NOTICE_PARAM = "notice";
const REVOKED_PARAM = "revoked";

function noticeFromQuery(c: Context<AppBindings>): string | undefined {
  const notice = c.req.query(NOTICE_PARAM);
  const revoked = Number(c.req.query(REVOKED_PARAM) ?? "0");
  const revokedCount = Number.isInteger(revoked) && revoked >= 0 ? revoked : 0;

  if (notice === "suspended") {
    // **「切ったから止まる」と書かない。** 停止した時点で次の要求から
    // 通らなくなる（`GetSessionUseCase` が `isActive` を見る）。
    return `停止しました。ログイン中だった ${revokedCount} 件の端末も切りました。`;
  }
  if (notice === "reinstated") return "停止を解除しました。またログインできます。";
  if (notice === "revoked") {
    // **「ログインできなくなります」とは書かない。** 止めていないので、
    // 本人はログインし直せる。
    return `${revokedCount} 件の端末を切りました。本人はログインし直せます。`;
  }
  return undefined;
}

async function listUsers(
  identityAdmin: IdentityAdminDelegatedRpcContract,
  actorUserId: string,
  options: { readonly query?: string; readonly cursor?: string },
) {
  return identityAdmin.listUsers({
    actorUserId,
    ...(options.query === undefined ? {} : { query: options.query }),
    ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
  });
}

async function renderUsersPage(
  c: Context<AppBindings>,
  options: { query?: string; cursor?: string; error?: string; notice?: string },
): Promise<Response> {
  const session = c.get("session");
  const container = c.get("container");

  const page = await listUsers(container.identityAdmin, session.sub, options);
  if (!page.ok) {
    return c.text("しばらくしてからもう一度お試しください。", 503);
  }

  c.header("Cache-Control", "no-store");
  return c.html(
    <UsersPage
      actorUserId={session.sub}
      csrfToken={ensureCsrfToken(c)}
      users={page.value.users}
      nextCursor={page.value.nextCursor}
      {...(options.query === undefined ? {} : { query: options.query })}
      {...(options.error === undefined ? {} : { error: options.error })}
      {...(options.notice === undefined ? {} : { notice: options.notice })}
    />,
  );
}

/** 通らなかった理由。**内部の事情は書かない。** */
function manageFailureMessage(
  action: "suspend" | "reinstate" | "revoke-sessions",
  error: RpcError,
): string {
  if (error.code === "conflict") {
    if (action === "suspend") {
      // **区別しない。** 既に停止済み・退会済み・`deleted`・自分自身 ——
      // auth-worker がどれも `conflict` に畳んでいる（存在を当てさせない）。
      return "停止できませんでした。すでに停止しているか、自分のアカウントです。";
    }
    if (action === "reinstate") {
      return "解除できませんでした。停止中ではないか、個人情報を削除済みのアカウントです。";
    }
  }
  return "いま操作できません。しばらく待ってからもう一度お試しください。";
}

export function registerUsersRoutes(app: Hono<AppBindings>): void {
  app.get("/users", pageSecurityHeaders, async (c) => {
    const notice = noticeFromQuery(c);
    return renderUsersPage(c, { ...(notice === undefined ? {} : { notice }) });
  });

  app.post("/users/search", pageSecurityHeaders, async (c) => {
    const form = await c.req.formData().catch(() => null);
    if (form === null || !isValidCsrf(c, form.get(CSRF_FIELD_NAME)?.toString())) {
      c.header("Cache-Control", "no-store");
      return c.text("forbidden", 403);
    }

    const query = form.get("query")?.toString().trim() ?? "";
    const cursor = form.get("cursor")?.toString().trim() ?? "";

    return renderUsersPage(c, {
      ...(query === "" ? {} : { query }),
      ...(cursor === "" ? {} : { cursor }),
    });
  });

  app.post("/users/:userId/suspend", pageSecurityHeaders, async (c) => {
    const form = await c.req.formData().catch(() => null);
    if (form === null || !isValidCsrf(c, form.get(CSRF_FIELD_NAME)?.toString())) {
      c.header("Cache-Control", "no-store");
      return c.text("forbidden", 403);
    }

    const session = c.get("session");
    const userId = c.req.param("userId");
    const reason = form.get("reason")?.toString();

    if (reason !== "compromise" && reason !== "abuse") {
      return renderUsersPage(c, { error: "理由を選んでください。" });
    }

    const container = c.get("container");
    const result = await container.identityAdmin.suspendUser({
      actorUserId: session.sub,
      userId,
      reason: reason satisfies SuspendReason,
    });

    if (!result.ok) {
      return renderUsersPage(c, { error: manageFailureMessage("suspend", result.error) });
    }

    c.header("Cache-Control", "no-store");
    return c.redirect(
      `/users?${NOTICE_PARAM}=suspended&${REVOKED_PARAM}=${result.value.revokedSessions}`,
      303,
    );
  });

  app.post("/users/:userId/reinstate", pageSecurityHeaders, async (c) => {
    const form = await c.req.formData().catch(() => null);
    if (form === null || !isValidCsrf(c, form.get(CSRF_FIELD_NAME)?.toString())) {
      c.header("Cache-Control", "no-store");
      return c.text("forbidden", 403);
    }

    const session = c.get("session");
    const userId = c.req.param("userId");

    const container = c.get("container");
    const result = await container.identityAdmin.reinstateUser({
      actorUserId: session.sub,
      userId,
    });

    if (!result.ok) {
      return renderUsersPage(c, { error: manageFailureMessage("reinstate", result.error) });
    }

    c.header("Cache-Control", "no-store");
    return c.redirect(`/users?${NOTICE_PARAM}=reinstated`, 303);
  });

  app.post("/users/:userId/revoke-sessions", pageSecurityHeaders, async (c) => {
    const form = await c.req.formData().catch(() => null);
    if (form === null || !isValidCsrf(c, form.get(CSRF_FIELD_NAME)?.toString())) {
      c.header("Cache-Control", "no-store");
      return c.text("forbidden", 403);
    }

    const session = c.get("session");
    const userId = c.req.param("userId");

    const container = c.get("container");
    const result = await container.identityAdmin.revokeUserSessions({
      actorUserId: session.sub,
      userId,
    });

    if (!result.ok) {
      return renderUsersPage(c, { error: manageFailureMessage("revoke-sessions", result.error) });
    }

    c.header("Cache-Control", "no-store");
    return c.redirect(
      `/users?${NOTICE_PARAM}=revoked&${REVOKED_PARAM}=${result.value.revokedSessions}`,
      303,
    );
  });
}

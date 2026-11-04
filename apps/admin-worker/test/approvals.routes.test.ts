import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/presentation/http/app";
import { PERMISSION_BITS } from "../src/domain/permissions";
import { ORIGIN, cookieHeaderFrom, executionContext, fakeApprovals, loginAs } from "./helpers";

/**
 * 承認者・権限の管理画面（`/approvals`、#190）。
 *
 * **ここで見るのは HTTP 層の責務だけ。** 締め出し防止の判定ロジックそのもの
 * は `approval-guard.test.ts` が持つ——ここは「画面がその判定を実際に通す
 * か」「通らなかったとき何も変わらないか」「session.sub が actor として
 * 渡っているか」を見る。
 */

const SUB = "usr_approvals_admin";

function csrfTokenFrom(cookieHeader: string): string {
  const match = /u18_csrf=([^;]+)/.exec(cookieHeader);
  if (match === null) throw new Error("csrf cookie not found");
  return decodeURIComponent(match[1]!);
}

/** `/approvals` を GET して、以後の POST に要る Cookie と CSRF トークンを得る。 */
async function csrfContext(
  app: ReturnType<typeof createApp>,
  sessionCookie: string,
): Promise<{ readonly cookie: string; readonly csrfToken: string }> {
  const response = await app.fetch(
    new Request(`${ORIGIN}/approvals`, { headers: { Cookie: sessionCookie } }),
    env,
    executionContext(),
  );
  const csrfCookie = cookieHeaderFrom(response);
  return { cookie: `${sessionCookie}; ${csrfCookie}`, csrfToken: csrfTokenFrom(csrfCookie) };
}

async function post(
  app: ReturnType<typeof createApp>,
  path: string,
  cookie: string,
  body: URLSearchParams,
): Promise<Response> {
  return app.fetch(
    new Request(`${ORIGIN}${path}`, {
      method: "POST",
      headers: { Cookie: cookie, Origin: ORIGIN, "Content-Type": "application/x-www-form-urlencoded" },
      body,
    }),
    env,
    executionContext(),
  );
}

describe("GET /approvals", () => {
  it("承認済みの一覧を描く", async () => {
    const approvals = fakeApprovals([SUB, "usr_other"], [SUB]);
    const sessionCookie = await loginAs(SUB, approvals);
    const app = createApp({ approvals });

    const response = await app.fetch(
      new Request(`${ORIGIN}/approvals`, { headers: { Cookie: sessionCookie } }),
      env,
      executionContext(),
    );

    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain(SUB);
    expect(html).toContain("usr_other");
  });
});

describe("POST /approvals（新規承認）", () => {
  it("CSRF が通れば新しい sub を権限 0 で承認する", async () => {
    const approvals = fakeApprovals([SUB], [SUB]);
    const sessionCookie = await loginAs(SUB, approvals);
    const app = createApp({ approvals });
    const { cookie, csrfToken } = await csrfContext(app, sessionCookie);

    const response = await post(
      app,
      "/approvals",
      cookie,
      new URLSearchParams({ csrf_token: csrfToken, sub: "usr_new" }),
    );

    expect(response.status).toBe(200);
    expect(await approvals.isApproved("usr_new")).toBe(true);
    expect(await approvals.getEffectivePermissions("usr_new")).toEqual({
      kind: "bits",
      bits: 0n,
    });
    expect(approvals.events.at(-1)).toMatchObject({
      event: "ops.approval.granted",
      sub: "usr_new",
      actor: SUB,
    });
  });

  it("CSRF トークンが無ければ何も変えない", async () => {
    const approvals = fakeApprovals([SUB], [SUB]);
    const sessionCookie = await loginAs(SUB, approvals);
    const app = createApp({ approvals });

    await post(app, "/approvals", sessionCookie, new URLSearchParams({ sub: "usr_new" }));

    expect(await approvals.isApproved("usr_new")).toBe(false);
  });
});

describe("POST /approvals/:sub/super（締め出し防止、#190 要件⑤）", () => {
  it("他人を降格できる（他に super が居れば）", async () => {
    const approvals = fakeApprovals([SUB, "usr_other"], [SUB, "usr_other"]);
    const sessionCookie = await loginAs(SUB, approvals);
    const app = createApp({ approvals });
    const { cookie, csrfToken } = await csrfContext(app, sessionCookie);

    const response = await post(
      app,
      "/approvals/usr_other/super",
      cookie,
      new URLSearchParams({ csrf_token: csrfToken, is_super_approver: "false" }),
    );

    expect(response.status).toBe(200);
    expect(await approvals.isSuperApprover("usr_other")).toBe(false);
  });

  it("自分自身を降格しようとすると拒否される（他に super が居ても）", async () => {
    const approvals = fakeApprovals([SUB, "usr_other"], [SUB, "usr_other"]);
    const sessionCookie = await loginAs(SUB, approvals);
    const app = createApp({ approvals });
    const { cookie, csrfToken } = await csrfContext(app, sessionCookie);

    await post(
      app,
      `/approvals/${SUB}/super`,
      cookie,
      new URLSearchParams({ csrf_token: csrfToken, is_super_approver: "false" }),
    );

    expect(await approvals.isSuperApprover(SUB)).toBe(true);
  });

  it("最後の super approver を他人が降格しようとしても拒否される", async () => {
    const approvals = fakeApprovals([SUB, "usr_other"], [SUB]);
    const sessionCookie = await loginAs("usr_other", approvals);
    const app = createApp({ approvals });
    const { cookie, csrfToken } = await csrfContext(app, sessionCookie);

    await post(
      app,
      `/approvals/${SUB}/super`,
      cookie,
      new URLSearchParams({ csrf_token: csrfToken, is_super_approver: "false" }),
    );

    expect(await approvals.isSuperApprover(SUB)).toBe(true);
  });
});

describe("POST /approvals/:sub/permissions", () => {
  it("チェックボックスの内容でビットを置き換える", async () => {
    const approvals = fakeApprovals([SUB, "usr_target"], [SUB], { usr_target: 0n });
    const sessionCookie = await loginAs(SUB, approvals);
    const app = createApp({ approvals });
    const { cookie, csrfToken } = await csrfContext(app, sessionCookie);

    const response = await post(
      app,
      "/approvals/usr_target/permissions",
      cookie,
      new URLSearchParams([
        ["csrf_token", csrfToken],
        ["bit", "NFC_READ"],
        ["bit", "AUDIT_READ"],
      ]),
    );

    expect(response.status).toBe(200);
    expect(await approvals.getEffectivePermissions("usr_target")).toEqual({
      kind: "bits",
      bits: PERMISSION_BITS.NFC_READ | PERMISSION_BITS.AUDIT_READ,
    });
    const grantedDetails = approvals.events
      .filter((e) => e.event === "ops.permission.granted")
      .map((e) => e.detail);
    expect(grantedDetails.sort()).toEqual(["AUDIT_READ", "NFC_READ"]);
  });

  it("自分自身の APPROVAL_GRANT を自分で落とすことはできない", async () => {
    const approvals = fakeApprovals([SUB], [], { [SUB]: PERMISSION_BITS.APPROVAL_GRANT });
    const sessionCookie = await loginAs(SUB, approvals);
    const app = createApp({ approvals });
    const { cookie, csrfToken } = await csrfContext(app, sessionCookie);

    // bit を 1 つも送らない = 全剥奪を試みる。
    await post(
      app,
      `/approvals/${SUB}/permissions`,
      cookie,
      new URLSearchParams([["csrf_token", csrfToken]]),
    );

    const effective = await approvals.getEffectivePermissions(SUB);
    expect(
      effective?.kind === "bits" && (effective.bits & PERMISSION_BITS.APPROVAL_GRANT) !== 0n,
    ).toBe(true);
  });

  it("APPROVAL_GRANT 以外のビットは自分自身からでも剥奪できる", async () => {
    const approvals = fakeApprovals([SUB], [], {
      [SUB]: PERMISSION_BITS.APPROVAL_GRANT | PERMISSION_BITS.NFC_READ,
    });
    const sessionCookie = await loginAs(SUB, approvals);
    const app = createApp({ approvals });
    const { cookie, csrfToken } = await csrfContext(app, sessionCookie);

    // APPROVAL_GRANT だけ残し、NFC_READ を外す。
    await post(
      app,
      `/approvals/${SUB}/permissions`,
      cookie,
      new URLSearchParams([
        ["csrf_token", csrfToken],
        ["bit", "APPROVAL_GRANT"],
      ]),
    );

    const effective = await approvals.getEffectivePermissions(SUB);
    expect(effective).toEqual({ kind: "bits", bits: PERMISSION_BITS.APPROVAL_GRANT });
  });
});

describe("POST /approvals/:sub/revoke", () => {
  it("他人の承認を剥奪できる", async () => {
    const approvals = fakeApprovals([SUB, "usr_other"], [SUB]);
    const sessionCookie = await loginAs(SUB, approvals);
    const app = createApp({ approvals });
    const { cookie, csrfToken } = await csrfContext(app, sessionCookie);

    const response = await post(
      app,
      "/approvals/usr_other/revoke",
      cookie,
      new URLSearchParams({ csrf_token: csrfToken }),
    );

    expect(response.status).toBe(200);
    expect(await approvals.isApproved("usr_other")).toBe(false);
  });

  it("最後の super approver である自分自身を剥奪できない", async () => {
    const approvals = fakeApprovals([SUB], [SUB]);
    const sessionCookie = await loginAs(SUB, approvals);
    const app = createApp({ approvals });
    const { cookie, csrfToken } = await csrfContext(app, sessionCookie);

    await post(
      app,
      `/approvals/${SUB}/revoke`,
      cookie,
      new URLSearchParams({ csrf_token: csrfToken }),
    );

    expect(await approvals.isApproved(SUB)).toBe(true);
  });
});

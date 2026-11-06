import { rpcOk } from "@u18/contracts";
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/presentation/http/app";
import { ISLAND_PATH } from "../src/presentation/http/ui/asset-paths";
import { PERMISSION_BITS } from "../src/domain/permissions";
import {
  ORIGIN,
  cookieHeaderFrom,
  executionContext,
  fakeApprovals,
  loginAs,
  minimalIdentityAdmin,
} from "./helpers";

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
      headers: {
        Cookie: cookie,
        Origin: ORIGIN,
        "Content-Type": "application/x-www-form-urlencoded",
      },
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

  it("sub と承認者を名前で出す（#482）", async () => {
    const approvals = fakeApprovals([SUB, "usr_other"], [SUB]);
    // `approvedBySub` は `fakeApprovals` の既定で null。`grant` を呼び直すと
    // 既存の null を埋められる（`helpers.ts` の `grant` を参照）。
    await approvals.grant("usr_other", false, SUB);
    const sessionCookie = await loginAs(SUB, approvals);
    const identityAdmin = {
      ...minimalIdentityAdmin(),
      getUsersByIds: async () =>
        rpcOk([
          { id: SUB, username: "admin", displayName: "管理者", status: "active" as const },
          {
            id: "usr_other",
            username: "other",
            displayName: "別の承認者",
            status: "active" as const,
          },
        ]),
    };
    const app = createApp({ approvals, identityAdmin });

    const response = await app.fetch(
      new Request(`${ORIGIN}/approvals`, { headers: { Cookie: sessionCookie } }),
      env,
      executionContext(),
    );

    const html = await response.text();
    expect(html).toContain("管理者 (@admin)");
    expect(html).toContain("別の承認者 (@other)");
    expect(html).toContain('href="/users/usr_other"');
    // **承認者も名前になる。** `approvedBySub` は SUB（自分）なので、
    // 承認者の節にも「管理者 (@admin)」が出る。
    expect(html).toContain("承認者: ");
  });

  it("sub と承認者の両方に data-copy ボタンを付け、ISLAND_PATH を読む（#504）", async () => {
    const approvals = fakeApprovals([SUB, "usr_other"], [SUB]);
    await approvals.grant("usr_other", false, SUB);
    const sessionCookie = await loginAs(SUB, approvals);
    const identityAdmin = {
      ...minimalIdentityAdmin(),
      getUsersByIds: async () =>
        rpcOk([
          { id: SUB, username: "admin", displayName: "管理者", status: "active" as const },
          {
            id: "usr_other",
            username: "other",
            displayName: "別の承認者",
            status: "active" as const,
          },
        ]),
    };
    const app = createApp({ approvals, identityAdmin });

    const response = await app.fetch(
      new Request(`${ORIGIN}/approvals`, { headers: { Cookie: sessionCookie } }),
      env,
      executionContext(),
    );

    const html = await response.text();
    // **sub 本人（対象）と承認者、両方コピーできる**——`UserRef` に替わる前
    // は画面の文字として出ていた値（#482 の副作用で失っていた）。
    expect(html).toContain(`data-copy="${SUB}" hidden`);
    expect(html).toContain('data-copy="usr_other" hidden');
    // **`UserRef` の表示自体は変えていない。** 名前はそのまま出る。
    expect(html).toContain("管理者 (@admin)");
    expect(html).toContain("別の承認者 (@other)");
    // **`/approvals` は `NAV_PAGE_ROUTES` にある**ので、ISLAND_PATH を
    // 忘れると #480 の検査がここで落ちる（指摘: 3b）。
    expect(html).toContain(ISLAND_PATH);
  });

  /**
   * 履歴の節（#523）。「誰が・いつ・誰に」を読めるようにする。
   *
   * **`sub`（対象）は名前に解決し、`actor`（実行者）は生のまま出す。**
   * `actor` は CLI の `--actor` に渡された自由文字列で u18 Identity の
   * sub ではないため、`UserRef` に通すと「見つかりません」になる——
   * そのまま出すのが正しい（issue のコメント）。
   */
  it("履歴に、対象は名前で・実行者は生のまま・権限ビットは日本語で出す（#523）", async () => {
    const approvals = fakeApprovals([SUB, "usr_other"], [SUB]);
    await approvals.recordAuditEvent({
      event: "ops.permission.granted",
      sub: "usr_other",
      actor: "github-handle-not-a-sub",
      reason: "UI から付与",
      detail: "NFC_READ",
    });
    const sessionCookie = await loginAs(SUB, approvals);
    const identityAdmin = {
      ...minimalIdentityAdmin(),
      getUsersByIds: async () =>
        rpcOk([
          {
            id: "usr_other",
            username: "other",
            displayName: "別の承認者",
            status: "active" as const,
          },
        ]),
    };
    const app = createApp({ approvals, identityAdmin });

    const response = await app.fetch(
      new Request(`${ORIGIN}/approvals`, { headers: { Cookie: sessionCookie } }),
      env,
      executionContext(),
    );

    const html = await response.text();
    expect(html).toContain("権限を付与");
    expect(html).toContain("カードを見る");
    // 対象（sub）は名前に解決される。
    expect(html).toContain("別の承認者 (@other)");
    // 実行者（actor）は生のまま——名前解決も「見つかりません」もしない。
    expect(html).toContain("github-handle-not-a-sub");
  });

  it("対応表に無い event・権限ビットは生のコードのまま出す。「不明」とは書かない（#523）", async () => {
    const approvals = fakeApprovals([SUB]);
    // `recordAuditEvent` の `event` は書き込み側の型で既知の 4 つに閉じて
    // いる（アプリが未知の event を書くことはない）ので、読み出し側の
    // 「未知の値が実在する」場合は `events` へ直接押し込んでシミュレートする。
    approvals.events.push({
      event: "ops.admin.demoted",
      sub: SUB,
      actor: "actor",
      reason: "r",
      createdAt: new Date(0),
    });
    await approvals.recordAuditEvent({
      event: "ops.permission.revoked",
      sub: SUB,
      actor: "actor",
      reason: "r",
      detail: "LEGACY_BIT",
    });
    const sessionCookie = await loginAs(SUB, approvals);
    const app = createApp({ approvals });

    const response = await app.fetch(
      new Request(`${ORIGIN}/approvals`, { headers: { Cookie: sessionCookie } }),
      env,
      executionContext(),
    );

    const html = await response.text();
    expect(html).toContain("<code");
    expect(html).toContain(">ops.admin.demoted</code>");
    expect(html).toContain("LEGACY_BIT");
    expect(html).not.toContain("不明");
  });

  it("履歴に reason は出さない（内部の既定値が漏れるのを防ぐ、#516 と同じ理由）", async () => {
    const approvals = fakeApprovals([SUB]);
    await approvals.recordAuditEvent({
      event: "ops.approval.granted",
      sub: SUB,
      actor: "actor",
      reason: "manual_grant",
    });
    const sessionCookie = await loginAs(SUB, approvals);
    const app = createApp({ approvals });

    const response = await app.fetch(
      new Request(`${ORIGIN}/approvals`, { headers: { Cookie: sessionCookie } }),
      env,
      executionContext(),
    );

    const html = await response.text();
    expect(html).not.toContain("manual_grant");
  });

  it("権限の定数名ではなく日本語名と説明を出す（#487）", async () => {
    // `usr_other` は super approver ではないので、権限のチェックボックスが出る。
    const approvals = fakeApprovals([SUB, "usr_other"], [SUB]);
    const sessionCookie = await loginAs(SUB, approvals);
    const app = createApp({ approvals });

    const response = await app.fetch(
      new Request(`${ORIGIN}/approvals`, { headers: { Cookie: sessionCookie } }),
      env,
      executionContext(),
    );

    const html = await response.text();
    // 日本語名が主役、定数名は補助として併記。
    expect(html).toContain("カードを見る");
    expect(html).toContain("（NFC_READ）");
    expect(html).toContain("ログイン中の端末の追い出しができます。");
    // **`APPROVAL_GRANT` は他の 7 つと見た目を分ける。**
    // 節の見出しはラベル（「権限を配る」）と同じ文字列を繰り返さない
    // （指摘: 3b、節に項目が 1 つしか無いので 2 回読ませると重複でしかない）。
    expect(html).toContain("ここだけ特に重い（実質的な昇格）");
    expect(html).not.toContain("権限を配る（実質的な昇格）");
    expect(html).toContain('value="APPROVAL_GRANT"');
    // super approver（この fixture では SUB だけ）の既存の説明文を
    // 変えていない（指摘: issue #487 の書き方の決め）。
    expect(html).toContain(
      "super approver は全操作を無条件に行えます。個別の権限ビットは意味を持ちません。",
    );
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

describe("POST /approvals/:sub/revoke（2 段階確認、#487）", () => {
  it("1 回目（confirm 無し）は何も変えず、名前入りの確認画面を返す", async () => {
    const approvals = fakeApprovals([SUB, "usr_other"], [SUB]);
    const sessionCookie = await loginAs(SUB, approvals);
    const identityAdmin = {
      ...minimalIdentityAdmin(),
      getUsersByIds: async () =>
        rpcOk([
          { id: "usr_other", username: "other", displayName: "別の人", status: "active" as const },
        ]),
    };
    const app = createApp({ approvals, identityAdmin });
    const { cookie, csrfToken } = await csrfContext(app, sessionCookie);

    const response = await post(
      app,
      "/approvals/usr_other/revoke",
      cookie,
      new URLSearchParams({ csrf_token: csrfToken }),
    );

    expect(response.status).toBe(200);
    // **何も書き込まれていない。** 確認画面を出しただけ。
    expect(await approvals.isApproved("usr_other")).toBe(true);
    const html = await response.text();
    expect(html).toContain("本当に剥奪しますか");
    // **誰を剥奪するのか、名前で出ている**（issue の肝）。
    expect(html).toContain("別の人 (@other)");
    expect(html).toContain('name="confirm" value="true"');
  });

  it("2 回目（confirm=true）で実際に剥奪する", async () => {
    const approvals = fakeApprovals([SUB, "usr_other"], [SUB]);
    const sessionCookie = await loginAs(SUB, approvals);
    const app = createApp({ approvals });
    const { cookie, csrfToken } = await csrfContext(app, sessionCookie);

    const response = await post(
      app,
      "/approvals/usr_other/revoke",
      cookie,
      new URLSearchParams({ csrf_token: csrfToken, confirm: "true" }),
    );

    expect(response.status).toBe(200);
    expect(await approvals.isApproved("usr_other")).toBe(false);
    const html = await response.text();
    expect(html).toContain("usr_other の承認を剥奪しました。");
  });

  it("最後の super approver である自分自身を剥奪できない（confirm=true でも）", async () => {
    const approvals = fakeApprovals([SUB], [SUB]);
    const sessionCookie = await loginAs(SUB, approvals);
    const app = createApp({ approvals });
    const { cookie, csrfToken } = await csrfContext(app, sessionCookie);

    await post(
      app,
      `/approvals/${SUB}/revoke`,
      cookie,
      new URLSearchParams({ csrf_token: csrfToken, confirm: "true" }),
    );

    expect(await approvals.isApproved(SUB)).toBe(true);
  });

  it("剥奪できない場合は、1 回目の時点で確認画面を出さずに理由だけ返す（指摘: 3b）", async () => {
    // **1 段階目で「この人を剥奪します」を見せたあと、2 段階目でロックアウト
    // 判定に落ちると、運用者は確認を押してから拒否されることになる。**
    // 締め出し判定は確認画面より先に済ませてあるべき。
    const approvals = fakeApprovals([SUB], [SUB]);
    const sessionCookie = await loginAs(SUB, approvals);
    const app = createApp({ approvals });
    const { cookie, csrfToken } = await csrfContext(app, sessionCookie);

    const response = await post(
      app,
      `/approvals/${SUB}/revoke`,
      cookie,
      new URLSearchParams({ csrf_token: csrfToken }),
    );

    const html = await response.text();
    expect(html).not.toContain("本当に剥奪しますか");
    // 自分自身の剥奪なので、人数に関係なく「自分自身」の理由になる
    // （`checkApprovalRevocation` は actorSub === targetSub を先に見る）。
    expect(html).toContain("自分自身の承認を剥奪できない（super approver）");
  });

  it("確認画面の表示から実行までの間に最後の 1 人になっていたら、2 回目で拒否される", async () => {
    // **1 段階目の判定結果を 2 段階目で使い回さない。** 状態は古いかも
    // しれない——`/nfc/batch-disable` が再入力のたびに対象枚数を数え直す
    // のと同じ前提。
    const approvals = fakeApprovals([SUB, "usr_other"], [SUB, "usr_other"]);
    const sessionCookie = await loginAs(SUB, approvals);
    const app = createApp({ approvals });
    const { cookie, csrfToken } = await csrfContext(app, sessionCookie);

    // 確認画面を一度開く（この時点では super が 2 人いるので通る）。
    await post(
      app,
      "/approvals/usr_other/revoke",
      cookie,
      new URLSearchParams({ csrf_token: csrfToken }),
    );

    // その間に、別の操作で SUB(自分) が super ではなくなったとする——
    // 承認そのものは残す（丸ごと revoke すると、自分がこの先 /approvals
    // に入れなくなり、2 回目のリクエストが権限ガードに弾かれて別の失敗に
    // すり替わる。見たいのは「人数が減った」ことへの反応であって、
    // 自分の権限が消えたことへの反応ではない）。
    await approvals.grant(SUB, false, null);

    const response = await post(
      app,
      "/approvals/usr_other/revoke",
      cookie,
      new URLSearchParams({ csrf_token: csrfToken, confirm: "true" }),
    );

    expect(await approvals.isApproved("usr_other")).toBe(true);
    const html = await response.text();
    expect(html).toContain("最後の super approver の承認を剥奪できない");
  });
});

import { pageSecurityHeaders } from "@u18/web-ui";
import type {
  AdminCardViewDelegated,
  AuditLogEntryAdmin,
  IdentityAdminDelegatedRpcContract,
  ListAuditLogsDelegatedResult,
  ListCardsByOwnerDelegatedResult,
  RpcError,
  RpcErrorCode,
  SuspendReason,
} from "@u18/contracts";
import type { Context, Hono } from "hono";
import { CSRF_FIELD_NAME, ensureCsrfToken, isValidCsrf } from "./csrf";
import { MessagePage, csrfRejected, serviceUnavailable } from "./ui/message-page";
import {
  ACCOUNT_CLOSED_EVENT,
  OPS_SUSPENDED_EVENT,
  decideSuspensionOrigin,
  type SuspensionOrigin,
} from "./suspension-origin";
import {
  UserDetailPage,
  actorUserIdFromMetadata,
  type DisableCardsConfirmState,
  type DisableCardsFailureRow,
  type DisableCardsResultState,
} from "./ui/user-detail-page";
import { UsersPage } from "./ui/users-page";
import { resolveUserRefs } from "./user-refs";
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
 *
 * ## 詳細（`/users/:userId`）も同じ 3 本の route を使う（#455）
 *
 * 操作の route を詳細用に増やしていない。**同じ操作が 2 組の URL を持つと、
 * 片方だけ直された状態が作れて、しかもどちらも落ちない**（#433 が
 * `/account/*` の運営向け画面を消した理由と同じ形）。代わりに
 * **戻り先だけをフォームが申告する**——`from=detail` が付いていれば
 * 成功後は詳細へ戻し、失敗したときも詳細を描き直す。
 *
 * **`from` を行き先そのものにしない。** `return_to=/任意のパス` の形に
 * すると、外から来た文字列が `Location` に入る（オープンリダイレクト）。
 * 受け取るのは「詳細から来たか」の 1 ビットだけで、組み立てるのは
 * こちらである。
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
    return serviceUnavailable(c);
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

/**
 * 詳細ページに出す監査ログの件数。
 *
 * **全部は出さない。** 1 人ぶんでも記録は増え続けるので、ここで持つのは
 * 「直近に何があったか」までで、遡るのは `/audit` の仕事である
 * （節の下にそこへ飛ぶフォームを置いてある）。
 */
const RECENT_AUDIT_LIMIT = 20;

/** 操作のフォームが「詳細から来た」と申告しているか（上の JSDoc を参照）。 */
function cameFromDetail(form: FormData): boolean {
  return form.get("from")?.toString() === "detail";
}

/** 操作のあとの戻り先。詳細から来たときだけ詳細へ戻す。 */
function redirectTargetOf(form: FormData, userId: string): string {
  return cameFromDetail(form) ? `/users/${encodeURIComponent(userId)}` : "/users";
}

/**
 * 塊ごとの結果を「出せる値」か `null`（いま取れない）へ畳む。
 *
 * **`Promise.allSettled` の `rejected` と `RpcResult` の `ok: false` を
 * 同じに扱う。** 画面から見ればどちらも「この節だけ出せない」であり、
 * 区別しても出し分ける文言が無い。
 */
function entriesOf(
  settled: PromiseSettledResult<ListAuditLogsDelegatedResult | null>,
): readonly AuditLogEntryAdmin[] | null {
  if (settled.status !== "fulfilled" || settled.value === null || !settled.value.ok) return null;
  return settled.value.value.entries;
}

/** 同上、カードの塊。 */
function cardsOf(
  settled: PromiseSettledResult<ListCardsByOwnerDelegatedResult | null>,
): readonly AdminCardViewDelegated[] | null {
  if (settled.status !== "fulfilled" || settled.value === null || !settled.value.ok) return null;
  return settled.value.value.cards;
}

/** 存在しない `userId` を行き止まりにしない（#455）。 */
function userNotFound(c: Context<AppBindings>): Response | Promise<Response> {
  return c.html(
    <MessagePage
      title="その利用者は見つかりません"
      message="ID が違うか、すでに消えています。一覧から探し直してください。"
      actionHref="/users"
      actionLabel="利用者の一覧へ戻る"
    />,
    404,
  );
}

/**
 * 利用者 1 人の詳細（#455）。
 *
 * ## 本人の要約だけは先に取る
 *
 * **これが取れなければ画面が成立しない。** 見出しも、操作の宛先も、
 * そもそも停止中かどうかも、ここから決まる。取れなかったときに
 * 「見つかりません」と「いま取れません」を分けるのもここ ——
 * 混ぜると、打ち間違えた運用者が何度も再読み込みすることになる。
 *
 * ## 残りは塊ごとに独立して取る
 *
 * **`Promise.all` にしない**（`app.tsx` の `/` と同じ判断）。
 * `RpcResult` の `ok: false` は値として返るのでここでは reject しないが、
 * Service Binding 自体の失敗や例外は reject になる —— `Promise.all` だと
 * **カードが取れないだけで、本人の要約も監査ログも消えて 500 になる。**
 * 失敗した塊は `null`（＝「いま取得できません」）に落とすだけで、残りは出す。
 *
 * ## 停止の理由は、専用に 2 件引く
 *
 * 直近 `RECENT_AUDIT_LIMIT` 件の中から探さない。**停止が古ければその枠の
 * 外に出る**ので、「記録が無い」と「遠いだけ」が区別できなくなる ——
 * 区別できないまま「凍結です」と書くのが、この画面でいちばん避けたい
 * 間違いである（`suspension-origin.ts` の冒頭）。
 *
 * **停止中でなければ引かない。** `active` の人に対して聞いても、答えを
 * 使う場所が無い。
 */
async function renderUserDetailPage(
  c: Context<AppBindings>,
  userId: string,
  options: {
    error?: string;
    notice?: string;
    disableCardsConfirm?: DisableCardsConfirmState;
    disableCardsResult?: DisableCardsResultState;
  },
): Promise<Response> {
  const session = c.get("session");
  const container = c.get("container");

  const summary = await container.identityAdmin.getUser({ actorUserId: session.sub, userId });
  if (!summary.ok) {
    c.header("Cache-Control", "no-store");
    // **`invalid_input` も「見つかりません」に畳む。** 形が違う `userId`
    // （長すぎる・空）は、待っても直らない —— 503 にすると運用者は
    // 再読み込みを繰り返す。打ち間違いなので、一覧へ戻す。
    return summary.error.code === "not_found" || summary.error.code === "invalid_input"
      ? userNotFound(c)
      : serviceUnavailable(c);
  }
  const user = summary.value;

  const needsSuspensionReason = user.status === "suspended";
  const [audit, cards, opsSuspended, accountClosed] = await Promise.allSettled([
    container.identityAdmin.listAuditLogs({
      actorUserId: session.sub,
      userId,
      limit: RECENT_AUDIT_LIMIT,
    }),
    container.nfcCards.listCardsByOwner({ actorUserId: session.sub, ownerUserId: userId }),
    needsSuspensionReason
      ? container.identityAdmin.listAuditLogs({
          actorUserId: session.sub,
          userId,
          event: OPS_SUSPENDED_EVENT,
          limit: 1,
        })
      : null,
    needsSuspensionReason
      ? container.identityAdmin.listAuditLogs({
          actorUserId: session.sub,
          userId,
          event: ACCOUNT_CLOSED_EVENT,
          limit: 1,
        })
      : null,
  ]);

  const suspension: SuspensionOrigin = needsSuspensionReason
    ? decideSuspensionOrigin(entriesOf(opsSuspended), entriesOf(accountClosed))
    : // 停止中でなければ画面はこの節を出さない。引いていない以上、
      // 「分からない」以外を返しようがない。
      { kind: "unknown" };

  const auditEntries = entriesOf(audit);
  // **`entry.userId` ではなく `metadata.actorUserId` を集める**（#482）。
  // このクエリは `userId` で絞り込んでいるので、`entry.userId` は常に
  // この利用者自身——実行者は `metadata.actorUserId` にしか無い
  // （`UserDetailPageProps.userRefs` の JSDoc を参照）。
  const userRefs = await resolveUserRefs(
    container.identityAdmin,
    session.sub,
    auditEntries === null
      ? []
      : auditEntries.map((entry) => actorUserIdFromMetadata(entry.metadata)),
  );

  c.header("Cache-Control", "no-store");
  return c.html(
    <UserDetailPage
      csrfToken={ensureCsrfToken(c)}
      actorUserId={session.sub}
      user={user}
      suspension={suspension}
      auditEntries={auditEntries}
      userRefs={userRefs}
      cards={cardsOf(cards)}
      disableCardsConfirm={options.disableCardsConfirm ?? null}
      disableCardsResult={options.disableCardsResult ?? null}
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

/**
 * 「この人のカードをまとめて止める」1 回の上限（#486）。
 *
 * **`nfc.routes.tsx` の `BULK_SELECT_LIMIT` と同じ値、同じ理由。** あちらは
 * 選択できる枚数の上限だが、ここには選択が無い——「所持しているカード
 * 全部」が対象になるので、代わりに**一度に処理する枚数**の上限として
 * 使う。`nfc.routes.tsx` 側は export していないので、値だけここでも
 * 持つ（2 箇所に増えても、どちらも「1 リクエストで流し込みすぎない」
 * という同じ意図を指しているので実害が無い）。
 */
const DISABLE_CARDS_LIMIT = 100;

/**
 * 1 回ぶんの失敗を文言へ訳す（#486）。**`nfc.routes.tsx` の
 * `bulkFailureReason` と同じ区別。** `not_found` とそれ以外を分ける——
 * 両方を「見つかりませんでした」に畳むと、凍結対応の最中に出た
 * 「見つかりません」を運用者が「もう無い（＝対処済み）」と読む
 * （実際には Service Binding の一時的な障害だった、がありえる）。
 */
function disableCardsFailureReason(code: RpcErrorCode): string {
  return code === "not_found"
    ? "そのカードは見つかりませんでした。"
    : "いま処理できませんでした。時間をおいて、もう一度お試しください。";
}

/**
 * 所持カードを「止められる」「既に無効化済み」へ分ける（#486）。
 *
 * **確認画面を描くときと、実行する直前の 2 回、同じ関数で分け直す**
 * （`nfc.routes.tsx` の `categorizeForDisable` と同じ設計。issue #486 への
 * 指摘と同じ）。1 段階目で見てから押すまでの間に、本人が別の端末で
 * カードを手放す・他の運営が無効化する、ということが起こりうる——
 * 確認画面の内訳をそのまま信用しない。
 *
 * **上限を超えたぶんはエラーにしない。** `nfc.routes.tsx` の選択一括操作
 * と違い、ここには選び直す手段が無い——対象は常に「この人の全部」。
 * 先頭 `DISABLE_CARDS_LIMIT` 件だけを対象にし、残りは次の実行に回す
 * （無効化されたカードは次の呼び出しで「既に無効化済み」側へ移るので、
 * 繰り返し押せば必ず収束する）。
 */
function categorizeOwnerCardsForDisable(cards: readonly AdminCardViewDelegated[]): {
  readonly totalCount: number;
  readonly eligibleCardIds: readonly string[];
  readonly alreadyDisabledCount: number;
  readonly cappedAtLimit: boolean;
} {
  const eligible = cards.filter((card) => card.status !== "disabled");
  const alreadyDisabledCount = cards.length - eligible.length;
  const cappedAtLimit = eligible.length > DISABLE_CARDS_LIMIT;
  const eligibleCardIds = eligible.slice(0, DISABLE_CARDS_LIMIT).map((card) => card.cardId);

  return { totalCount: cards.length, eligibleCardIds, alreadyDisabledCount, cappedAtLimit };
}

export function registerUsersRoutes(app: Hono<AppBindings>): void {
  app.get("/users", pageSecurityHeaders, async (c) => {
    const notice = noticeFromQuery(c);
    return renderUsersPage(c, { ...(notice === undefined ? {} : { notice }) });
  });

  /**
   * 利用者 1 人の詳細（#455）。
   *
   * **この route は `/users/` の下のあらゆる 1 階層を拾う。** いまの
   * 同階層は `POST /users/search` だけで、メソッドが違うので当たらない。
   * **`GET /users/新しい固定パス` を足すときは、必ずこれより前に
   * 登録すること** —— Hono は登録順に照合するので、後ろに置くと
   * `:userId` に吸われて 404 にもならず、「見つかりません」の画面が出る。
   */
  app.get("/users/:userId", pageSecurityHeaders, async (c) => {
    const notice = noticeFromQuery(c);
    return renderUserDetailPage(c, c.req.param("userId"), {
      ...(notice === undefined ? {} : { notice }),
    });
  });

  app.post("/users/search", pageSecurityHeaders, async (c) => {
    const form = await c.req.formData().catch(() => null);
    if (form === null || !isValidCsrf(c, form.get(CSRF_FIELD_NAME)?.toString())) {
      c.header("Cache-Control", "no-store");
      return csrfRejected(c, "/users");
    }

    const query = form.get("query")?.toString().trim() ?? "";
    const cursor = form.get("cursor")?.toString().trim() ?? "";

    return renderUsersPage(c, {
      ...(query === "" ? {} : { query }),
      ...(cursor === "" ? {} : { cursor }),
    });
  });

  app.post("/users/:userId/suspend", pageSecurityHeaders, async (c) => {
    const userId = c.req.param("userId");
    const form = await c.req.formData().catch(() => null);
    if (form === null || !isValidCsrf(c, form.get(CSRF_FIELD_NAME)?.toString())) {
      c.header("Cache-Control", "no-store");
      // **戻り先は詳細**（#455）。`form` を読めていないので `from` は
      // 見られないが、この POST 先は 1 人を指しているので、詳細は
      // 必ずその人の画面になる。一覧へ戻すと「誰に対する操作だったか」を
      // 運用者が辿り直すことになる。
      return csrfRejected(c, `/users/${encodeURIComponent(userId)}`);
    }

    const session = c.get("session");
    const reason = form.get("reason")?.toString();

    if (reason !== "compromise" && reason !== "abuse") {
      const message = "理由を選んでください。";
      return cameFromDetail(form)
        ? renderUserDetailPage(c, userId, { error: message })
        : renderUsersPage(c, { error: message });
    }

    const container = c.get("container");
    const result = await container.identityAdmin.suspendUser({
      actorUserId: session.sub,
      userId,
      reason: reason satisfies SuspendReason,
    });

    if (!result.ok) {
      const message = manageFailureMessage("suspend", result.error);
      return cameFromDetail(form)
        ? renderUserDetailPage(c, userId, { error: message })
        : renderUsersPage(c, { error: message });
    }

    c.header("Cache-Control", "no-store");
    return c.redirect(
      `${redirectTargetOf(form, userId)}?${NOTICE_PARAM}=suspended&${REVOKED_PARAM}=${result.value.revokedSessions}`,
      303,
    );
  });

  app.post("/users/:userId/reinstate", pageSecurityHeaders, async (c) => {
    const userId = c.req.param("userId");
    const form = await c.req.formData().catch(() => null);
    if (form === null || !isValidCsrf(c, form.get(CSRF_FIELD_NAME)?.toString())) {
      c.header("Cache-Control", "no-store");
      return csrfRejected(c, `/users/${encodeURIComponent(userId)}`);
    }

    const session = c.get("session");

    const container = c.get("container");
    const result = await container.identityAdmin.reinstateUser({
      actorUserId: session.sub,
      userId,
    });

    if (!result.ok) {
      const message = manageFailureMessage("reinstate", result.error);
      return cameFromDetail(form)
        ? renderUserDetailPage(c, userId, { error: message })
        : renderUsersPage(c, { error: message });
    }

    c.header("Cache-Control", "no-store");
    return c.redirect(`${redirectTargetOf(form, userId)}?${NOTICE_PARAM}=reinstated`, 303);
  });

  app.post("/users/:userId/revoke-sessions", pageSecurityHeaders, async (c) => {
    const userId = c.req.param("userId");
    const form = await c.req.formData().catch(() => null);
    if (form === null || !isValidCsrf(c, form.get(CSRF_FIELD_NAME)?.toString())) {
      c.header("Cache-Control", "no-store");
      return csrfRejected(c, `/users/${encodeURIComponent(userId)}`);
    }

    const session = c.get("session");

    const container = c.get("container");
    const result = await container.identityAdmin.revokeUserSessions({
      actorUserId: session.sub,
      userId,
    });

    if (!result.ok) {
      const message = manageFailureMessage("revoke-sessions", result.error);
      return cameFromDetail(form)
        ? renderUserDetailPage(c, userId, { error: message })
        : renderUsersPage(c, { error: message });
    }

    c.header("Cache-Control", "no-store");
    return c.redirect(
      `${redirectTargetOf(form, userId)}?${NOTICE_PARAM}=revoked&${REVOKED_PARAM}=${result.value.revokedSessions}`,
      303,
    );
  });

  /**
   * この人のカードをまとめて止める（#486）。**凍結（`/suspend`）とは
   * 別の route。** 新しい一括 RPC を作らず、既存の 1 枚ずつの口
   * （`disableCard`）をここで回す——1 枚ごとに正しい `actorUserId` つきで
   * `nfc_card_events` が残る（`nfc.routes.tsx` の `/nfc/bulk-disable` と
   * 同じ判断、issue #486 の指示）。
   *
   * ## 2 段階確認。常に詳細へ戻す
   *
   * 一覧（`/users`）からは呼べない route なので、`cameFromDetail` /
   * `redirectTargetOf` を使わない——戻り先は常にこの利用者の詳細である。
   *
   * ## 選択が無いので、確認のたびに `listCardsByOwner` を引き直す
   *
   * `confirmed` の有無に関わらず、この関数の先頭で毎回フレッシュに
   * 取得して `categorizeOwnerCardsForDisable` で分け直す——1 段階目を
   * 見てから押すまでの間に状態が変わっていても追従する
   * （`nfc.routes.tsx` と同じ設計）。
   */
  app.post("/users/:userId/disable-cards", pageSecurityHeaders, async (c) => {
    const userId = c.req.param("userId");
    const form = await c.req.formData().catch(() => null);
    if (form === null || !isValidCsrf(c, form.get(CSRF_FIELD_NAME)?.toString())) {
      c.header("Cache-Control", "no-store");
      return csrfRejected(c, `/users/${encodeURIComponent(userId)}`);
    }

    const session = c.get("session");
    const container = c.get("container");

    const cardsResult = await container.nfcCards.listCardsByOwner({
      actorUserId: session.sub,
      ownerUserId: userId,
    });
    if (!cardsResult.ok) {
      return renderUserDetailPage(c, userId, {
        error: "いまカードの一覧を取得できません。しばらくしてからもう一度お試しください。",
      });
    }

    const { totalCount, eligibleCardIds, alreadyDisabledCount, cappedAtLimit } =
      categorizeOwnerCardsForDisable(cardsResult.value.cards);

    const confirmed = form.get("confirmed")?.toString() === "1";
    if (!confirmed) {
      if (eligibleCardIds.length === 0) {
        return renderUserDetailPage(c, userId, {
          error: "止められるカードがありません（所持していないか、すでに全部無効化済みです）。",
        });
      }
      const confirm: DisableCardsConfirmState = {
        totalCount,
        eligibleCount: eligibleCardIds.length,
        alreadyDisabledCount,
        cappedAtLimit,
      };
      return renderUserDetailPage(c, userId, { disableCardsConfirm: confirm });
    }

    const succeeded: string[] = [];
    const failed: DisableCardsFailureRow[] = [];
    for (const cardId of eligibleCardIds) {
      const result = await container.nfcCards.disableCard({
        actorUserId: session.sub,
        cardId,
        reason: "owner_suspended",
      });
      if (result.ok) {
        succeeded.push(cardId);
      } else {
        failed.push({ cardId, reason: disableCardsFailureReason(result.error.code) });
      }
    }

    const disableCardsResult: DisableCardsResultState = { succeeded, failed };
    return renderUserDetailPage(c, userId, { disableCardsResult });
  });
}

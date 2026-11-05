import type { AuditLogEntryAdmin } from "@u18/contracts";
import { pageSecurityHeaders } from "@u18/web-ui";
import type { Context, Hono } from "hono";
import type { Container } from "../../composition/container";
import { CSRF_FIELD_NAME, ensureCsrfToken, isValidCsrf } from "./csrf";
import { csrfRejected, MessagePage, serviceUnavailable } from "./ui/message-page";
import { ClientsPage, type CreatedClient } from "./ui/clients-page";
import { ClientDetailPage } from "./ui/client-detail-page";
import { resolveUserRefs } from "./user-refs";
import type { AppBindings } from "./types";

/**
 * OAuth クライアントの管理画面（`admin.under18.dev/clients`、#308 / #333 /
 * #390 決定 16 ③ 段取り 3）。
 *
 * **`/account/admin/clients`（dashboard-worker、d5 が作ったもの、#380）から
 * 移した。** 呼び方だけが変わった——セッション Cookie 経由の UseCase
 * ではなく、`IdentityAdminDelegatedRPC`（Service Binding）を呼ぶ。
 *
 * ## `actorUserId` は `c.get("session").sub`
 *
 * **検証しない。** セッションガード（`app.ts`）が既に「ログイン済み・
 * 承認リストにある」ことを確かめたあとにしかここへ来ない。
 * `IdentityAdminDelegatedRpcContract` の trust boundary の説明を参照。
 *
 * ## JavaScript を要求しない
 *
 * 移行元と同じ理由。**admin-worker にはまだ島が無い**ので、新しく
 * 作らず form POST + 200 でそのまま描く（登録だけは PRG を挟まない。
 * 下の `POST /clients` を参照）。
 */

function redirectUrisFromForm(raw: string): string[] {
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

function scopesFromForm(raw: string): string[] {
  return raw
    .split(/\s+/)
    .map((scope) => scope.trim())
    .filter((scope) => scope !== "");
}

/**
 * 登録が通らなかった理由を、人が読む 1 文にする。
 *
 * **内部の事情は書かない。** `requireExistingActor` / 各検証の `message` は
 * 画面に出さない。delegated 契約は redirect_uri・scope・logo_url・
 * actorUserId 不在のすべてを `invalid_input` に畳んでいるので、
 * 区別せず「入力を見直してください」にまとめる。
 */
function createFailureMessage(code: string): string {
  if (code === "conflict") return "その client_id は既に使われています。別の値で登録してください。";
  if (code === "invalid_input") {
    return "入力に問題があります。表示名・Redirect URI・scope・ロゴ URL を確認してください。";
  }
  return "いま登録できません。しばらく待ってからもう一度お試しください。";
}

/** 失効が通らなかった理由。**一次パーティは `conflict` で返る。** */
function disableFailureMessage(code: string): string {
  if (code === "conflict") return "u18 公式のクライアントは、この画面からは失効させられません。";
  return "いま失効させられません。しばらく待ってからもう一度お試しください。";
}

/** 持ち主の変更が通らなかった理由。 */
function setOwnerFailureMessage(code: string): string {
  if (code === "invalid_input") return "その userId の利用者が見つかりません。";
  if (code === "not_found") return "そのクライアントが見つかりません。";
  return "いま持ち主を変更できません。しばらく待ってからもう一度お試しください。";
}

/** 存在しない `clientId` を行き止まりにしない（#473、`users.routes.tsx` の `userNotFound` と同じ形）。 */
function clientNotFound(c: Context<AppBindings>): Response | Promise<Response> {
  return c.html(
    <MessagePage
      title="そのクライアントは見つかりません"
      message="client_id が違うか、すでに削除されています。一覧から探し直してください。"
      actionHref="/clients"
      actionLabel="クライアントの一覧へ戻る"
    />,
    404,
  );
}

/**
 * 操作のフォームが「詳細から来た」と申告しているか
 * （`users.routes.tsx` の `cameFromDetail` と同じ形）。
 */
function cameFromDetail(form: FormData): boolean {
  return form.get("from")?.toString() === "detail";
}

/**
 * 詳細ページに出す、クライアントに関係する監査ログ（#473）。
 *
 * **`listAuditLogs` に `clientId` で絞る口が無い。** 記録している
 * `userId` はクライアントの対象ではなく**操作した管理者**なので
 * （`delegated-disable-oauth-client.use-case.ts` 等の JSDoc）、ここでは
 * 絞り込みを広げるのではなく、**クライアント全体の管理操作の直近**を
 * イベント名ごとに引いて束ねる**——3b と合意した「出せるものを出し、
 * 絞り込みは別便にする」判断。`resolve` / `authenticate` のように
 * リクエストのたびに積む運用ログは対象に含めない（量が桁違いで、
 * 管理操作の記録が埋もれるため）。
 */
const CLIENT_AUDIT_EVENTS = [
  "oauth.client.created",
  "oauth.client.disabled",
  "oauth.client.owner_changed",
  "oauth.client.app_url_changed",
] as const;

const PER_EVENT_AUDIT_LIMIT = 10;
const CLIENT_AUDIT_DISPLAY_LIMIT = 20;

async function fetchClientAudit(
  container: Container,
  actorUserId: string,
): Promise<readonly AuditLogEntryAdmin[] | null> {
  const settled = await Promise.allSettled(
    CLIENT_AUDIT_EVENTS.map((event) =>
      container.identityAdmin.listAuditLogs({ actorUserId, event, limit: PER_EVENT_AUDIT_LIMIT }),
    ),
  );

  const entries: AuditLogEntryAdmin[] = [];
  let anySucceeded = false;
  for (const result of settled) {
    if (result.status !== "fulfilled" || !result.value.ok) continue;
    anySucceeded = true;
    entries.push(...result.value.value.entries);
  }
  // **全滅したときだけ `null`。** 一部しか取れなくても、取れた分は出す
  // ——`users.routes.tsx` の `entriesOf` と同じ「部分失敗で全消しにしない」判断。
  if (!anySucceeded) return null;

  entries.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  return entries.slice(0, CLIENT_AUDIT_DISPLAY_LIMIT);
}

/** 表示用 URL の変更が通らなかった理由（#457）。 */
function setAppUrlFailureMessage(code: string): string {
  if (code === "invalid_input")
    return "https で始まる、資格情報を含まない URL を入力してください。";
  if (code === "not_found") return "そのクライアントが見つかりません。";
  return "いま URL を変更できません。しばらく待ってからもう一度お試しください。";
}

export function registerClientsRoutes(app: Hono<AppBindings>): void {
  app.get("/clients", pageSecurityHeaders, (c) => renderClientsPage(c, {}));

  /**
   * クライアント 1 件の詳細（#473）。
   *
   * **`/clients` の下のあらゆる 1 階層を拾う。** 同階層には
   * `POST /clients/disable` / `POST /clients/owner` / `POST /clients/app-url`
   * があるが、**メソッドが違うので当たらない**——Hono はメソッドごとに
   * 別の木を持つ（`users.routes.tsx:308` が同じ確認を書いている。
   * `clients.routes.test.ts` の「registered as a later route でも食わない」
   * テストで実測している）。
   *
   * **`GET /clients/新しい固定パス` を足すときは、これより前に登録すること**
   * ——後ろに置くと `:clientId` に吸われる。
   */
  app.get("/clients/:clientId", pageSecurityHeaders, async (c) =>
    renderClientDetailPage(c, c.req.param("clientId"), {}),
  );

  /**
   * クライアントの登録（移行元と同じ理由で PRG を挟まない）。
   *
   * **`client_secret` の平文は、この応答にしか存在しない。** リダイレクト
   * すると次の GET へ運ぶ必要があり、クエリにもパスにも Cookie にも
   * 置けない。200 でそのまま描く。
   */
  app.post("/clients", pageSecurityHeaders, async (c) => {
    const form = await c.req.formData().catch(() => null);

    if (form === null || !isValidCsrf(c, form.get(CSRF_FIELD_NAME)?.toString())) {
      c.header("Cache-Control", "no-store");
      return csrfRejected(c, "/clients");
    }

    const session = c.get("session");
    const clientType = form.get("client_type")?.toString();
    if (clientType !== "confidential" && clientType !== "public") {
      return renderClientsPage(c, { error: "種別を選んでください。" });
    }

    const redirectUris = redirectUrisFromForm(form.get("redirect_uris")?.toString() ?? "");
    const scopes = scopesFromForm(form.get("scopes")?.toString() ?? "");
    const logoUrl = (form.get("logo_url")?.toString() ?? "").trim();

    const container = c.get("container");
    const result = await container.identityAdmin.createOAuthClient({
      actorUserId: session.sub,
      name: (form.get("name")?.toString() ?? "").trim(),
      clientType,
      redirectUris,
      // **空なら渡さない。** 空配列を渡すと「0 個の scope を要求した」に
      // なり、既定（openid profile email）が効かない。
      ...(scopes.length === 0 ? {} : { scopes }),
      ...(logoUrl === "" ? {} : { logoUrl }),
    });

    if (!result.ok) {
      return renderClientsPage(c, { error: createFailureMessage(result.error.code) });
    }

    return renderClientsPage(c, { created: result.value });
  });

  /**
   * クライアントの失効（#308 / #333）。**冪等。**
   *
   * 秘密を返さないのでリダイレクトしてよいが、していない —— 失効は一覧の
   * 見た目が変わる操作で、同じ画面を描き直すほうが「何が変わったか」が
   * 見える（移行元と同じ理由）。
   */
  app.post("/clients/disable", pageSecurityHeaders, async (c) => {
    const form = await c.req.formData().catch(() => null);

    if (form === null || !isValidCsrf(c, form.get(CSRF_FIELD_NAME)?.toString())) {
      c.header("Cache-Control", "no-store");
      return csrfRejected(c, "/clients");
    }

    const session = c.get("session");
    const clientId = (form.get("client_id")?.toString() ?? "").trim();
    const toDetail = cameFromDetail(form);

    const container = c.get("container");
    const result = await container.identityAdmin.disableOAuthClient({
      actorUserId: session.sub,
      clientId,
    });

    if (!result.ok) {
      const error = disableFailureMessage(result.error.code);
      return toDetail
        ? renderClientDetailPage(c, clientId, { error })
        : renderClientsPage(c, { error });
    }

    // **「失効しました」と言い切らない。** 冪等なので 2 度目は何も
    // 変わっておらず、`disabled: false` が返る（未知の client_id も
    // 同じ扱いで、存在を当てさせない——移行元と同じ理由）。
    const notice = result.value.disabled
      ? "失効させました。以後このクライアントでの新しい認可は通りません。"
      : "このクライアントは既に失効しています。";
    return toDetail
      ? renderClientDetailPage(c, clientId, { notice })
      : renderClientsPage(c, { notice });
  });

  /**
   * 持ち主の設定・変更・解除（#441）。
   *
   * **空欄は「外す」であって「変更なし」ではない。** フォームは常にいまの
   * 値を埋めて出しているので、空にして送る操作は意図的な解除としてそのまま
   * `null` を渡す。
   */
  app.post("/clients/owner", pageSecurityHeaders, async (c) => {
    const form = await c.req.formData().catch(() => null);

    if (form === null || !isValidCsrf(c, form.get(CSRF_FIELD_NAME)?.toString())) {
      c.header("Cache-Control", "no-store");
      return csrfRejected(c, "/clients");
    }

    const session = c.get("session");
    const clientId = (form.get("client_id")?.toString() ?? "").trim();
    const ownerUserId = (form.get("owner_user_id")?.toString() ?? "").trim();
    const toDetail = cameFromDetail(form);

    const container = c.get("container");
    const result = await container.identityAdmin.setOAuthClientOwner({
      actorUserId: session.sub,
      clientId,
      ownerUserId: ownerUserId === "" ? null : ownerUserId,
    });

    if (!result.ok) {
      const error = setOwnerFailureMessage(result.error.code);
      return toDetail
        ? renderClientDetailPage(c, clientId, { error })
        : renderClientsPage(c, { error });
    }

    const notice = "持ち主を変更しました。";
    return toDetail
      ? renderClientDetailPage(c, clientId, { notice })
      : renderClientsPage(c, { notice });
  });

  /**
   * 表示用 URL（`app_url`）の設定・変更・解除（#457）。`/clients/owner` と
   * 同じ形——空欄は「外す」であって「変更なし」ではない。
   */
  app.post("/clients/app-url", pageSecurityHeaders, async (c) => {
    const form = await c.req.formData().catch(() => null);

    if (form === null || !isValidCsrf(c, form.get(CSRF_FIELD_NAME)?.toString())) {
      c.header("Cache-Control", "no-store");
      return csrfRejected(c, "/clients");
    }

    const session = c.get("session");
    const clientId = (form.get("client_id")?.toString() ?? "").trim();
    const appUrl = (form.get("app_url")?.toString() ?? "").trim();

    const container = c.get("container");
    const result = await container.identityAdmin.setOAuthClientAppUrl({
      actorUserId: session.sub,
      clientId,
      appUrl: appUrl === "" ? null : appUrl,
    });

    if (!result.ok) {
      return renderClientsPage(c, { error: setAppUrlFailureMessage(result.error.code) });
    }

    return renderClientsPage(c, { notice: "表示用 URL を変更しました。" });
  });
}

/**
 * 一覧をもう一度引いて画面を描き直す。**3 本の経路すべてが共有する。**
 *
 * **一覧をもう一度引く。** 直前の操作の結果を手で足すのではなく、
 * もう一度聞く —— 足す形だと、登録に成功したのに一覧へ出ない
 * （あるいはその逆）という食い違いが作れる（移行元と同じ理由）。
 */
async function renderClientsPage(
  c: Context<AppBindings>,
  extra: { created?: CreatedClient; error?: string; notice?: string },
): Promise<Response> {
  const container = c.get("container");
  const session = c.get("session");
  const result = await container.identityAdmin.listOAuthClients({ actorUserId: session.sub });

  if (!result.ok) {
    return serviceUnavailable(c);
  }

  c.header("Cache-Control", "no-store");
  return c.html(
    <ClientsPage
      clients={result.value}
      csrfToken={ensureCsrfToken(c)}
      {...(extra.created === undefined ? {} : { created: extra.created })}
      {...(extra.error === undefined ? {} : { error: extra.error })}
      {...(extra.notice === undefined ? {} : { notice: extra.notice })}
    />,
  );
}

/**
 * クライアント 1 件の詳細（#473）。`users.routes.tsx` の
 * `renderUserDetailPage` と同じ組み立て方。
 *
 * ## 本人の要約だけは先に取る
 *
 * これが取れなければ画面が成立しない。取れなかったときに「見つからない」
 * と「いま取れない」を分けるのもここ——`getOAuthClient` の冒頭と同じ理由。
 *
 * ## 残りは塊ごとに独立して取る
 *
 * `Promise.all` にしない。持ち主の名前が引けない・監査ログが取れない、
 * それぞれが独立して「その節だけ出せない」に畳まれ、残りは出る
 * （`renderUserDetailPage` と同じ判断）。
 */
async function renderClientDetailPage(
  c: Context<AppBindings>,
  clientId: string,
  extra: { error?: string; notice?: string },
): Promise<Response> {
  const container = c.get("container");
  const session = c.get("session");

  const summary = await container.identityAdmin.getOAuthClient({
    actorUserId: session.sub,
    clientId,
  });
  if (!summary.ok) {
    c.header("Cache-Control", "no-store");
    // **`invalid_input` も「見つかりません」に畳む**（`renderUserDetailPage` と同じ理由）。
    return summary.error.code === "not_found" || summary.error.code === "invalid_input"
      ? clientNotFound(c)
      : serviceUnavailable(c);
  }
  const client = summary.value;

  const [ownerRefs, auditEntries] = await Promise.all([
    resolveUserRefs(container.identityAdmin, session.sub, [client.ownerUserId]),
    fetchClientAudit(container, session.sub),
  ]);

  c.header("Cache-Control", "no-store");
  return c.html(
    <ClientDetailPage
      client={client}
      ownerRefs={ownerRefs}
      auditEntries={auditEntries}
      csrfToken={ensureCsrfToken(c)}
      {...(extra.error === undefined ? {} : { error: extra.error })}
      {...(extra.notice === undefined ? {} : { notice: extra.notice })}
    />,
  );
}

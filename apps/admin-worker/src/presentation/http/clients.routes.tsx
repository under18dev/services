import { pageSecurityHeaders } from "@u18/web-ui";
import type { Context, Hono } from "hono";
import { CSRF_FIELD_NAME, ensureCsrfToken, isValidCsrf } from "./csrf";
import { ClientsPage, type CreatedClient } from "./ui/clients-page";
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

export function registerClientsRoutes(app: Hono<AppBindings>): void {
  app.get("/clients", pageSecurityHeaders, (c) => renderClientsPage(c, {}));

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
      return c.text("forbidden", 403);
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
      return c.text("forbidden", 403);
    }

    const session = c.get("session");
    const clientId = (form.get("client_id")?.toString() ?? "").trim();

    const container = c.get("container");
    const result = await container.identityAdmin.disableOAuthClient({
      actorUserId: session.sub,
      clientId,
    });

    if (!result.ok) {
      return renderClientsPage(c, { error: disableFailureMessage(result.error.code) });
    }

    return renderClientsPage(c, {
      // **「失効しました」と言い切らない。** 冪等なので 2 度目は何も
      // 変わっておらず、`disabled: false` が返る（未知の client_id も
      // 同じ扱いで、存在を当てさせない——移行元と同じ理由）。
      notice: result.value.disabled
        ? "失効させました。以後このクライアントでの新しい認可は通りません。"
        : "このクライアントは既に失効しています。",
    });
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
    return c.text("しばらくしてからもう一度お試しください。", 503);
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

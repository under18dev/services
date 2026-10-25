import { Hono } from "hono";
import type { Context } from "hono";
import type {
  AuthorizationDecision,
  AuthorizationRequestParams,
} from "../../application/use-cases/authorize-request.use-case";
import { formatScope } from "../../domain/services/scope";
import { enforceIpRateLimit } from "./rate-limit";
import { readSessionCookie } from "./session-cookie";
import type { AppBindings } from "./types";
import { AuthorizeErrorPage, ConsentPage } from "./ui/consent-page";
import { CSRF_FIELD_NAME, ensureCsrfToken, isValidCsrf } from "./ui/csrf";
import { pageSecurityHeaders } from "./ui/page-headers";
import { loginUrlWithReturnTo, returnToForRequest } from "./ui/return-to";

/**
 * `/oauth/authorize` と同意画面（仕様書 5.1 / 5.2 / 9、#15）。
 *
 * ## このファイルが守っていること
 *
 * **`AuthorizeRequestUseCase` が宛先を確定させるまで、`c.redirect()` を
 * 1 行も書かない。** `client_id` が未知、あるいは `redirect_uri` が未登録の
 * 段階でそこへエラーを返すと、u18 が任意の宛先へのリダイレクタになる
 * （RFC 6749 §4.1.2.1）。UseCase の `AuthorizationDecision` が
 * `error_page` と `error_redirect` を別の種類にしてあるので、
 * このファイルの `respond()` は分岐を取り違えようがない。
 *
 * ## 同意の POST も同じ UseCase を通る
 *
 * 同意画面の hidden field は「覚えておく」ためのもので、「検証済み」の印では
 * ない。POST を受けたら GET とまったく同じ `AuthorizeRequestUseCase` に
 * 全パラメータを渡し直す。改竄された `scope` や `redirect_uri` はそこで落ちる。
 */
export const oauthAuthorizeRoutes = new Hono<AppBindings>();

/** クエリから認可要求を読む。形の判断は UseCase に委ね、ここでは詰め替えだけ。 */
function paramsFromQuery(c: Context<AppBindings>): AuthorizationRequestParams {
  const q = (name: string): string | null => c.req.query(name) ?? null;

  return {
    clientId: q("client_id"),
    redirectUri: q("redirect_uri"),
    responseType: q("response_type"),
    scope: q("scope"),
    state: q("state"),
    nonce: q("nonce"),
    codeChallenge: q("code_challenge"),
    codeChallengeMethod: q("code_challenge_method"),
    prompt: q("prompt"),
    maxAge: q("max_age"),
    hasRequestObject: q("request") !== null || q("request_uri") !== null,
    sessionToken: readSessionCookie(c),
  };
}

/** 壊れた本文で 500 にしない。`formData()` は不正な本文で投げる。 */
async function readForm(c: Context<AppBindings>): Promise<FormData> {
  try {
    return await c.req.raw.formData();
  } catch {
    return new FormData();
  }
}

function field(form: FormData, name: string): string | null {
  const value = form.get(name);
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * 同意 form から認可要求を読む。
 *
 * `prompt` と `max_age` は読まない（運んでいない）。同意画面が出ている時点で
 * その指示は果たされており、運ぶと進めなくなる（ui/consent-page.tsx を参照）。
 */
function paramsFromForm(c: Context<AppBindings>, form: FormData): AuthorizationRequestParams {
  return {
    clientId: field(form, "client_id"),
    redirectUri: field(form, "redirect_uri"),
    responseType: field(form, "response_type"),
    scope: field(form, "scope"),
    state: field(form, "state"),
    nonce: field(form, "nonce"),
    codeChallenge: field(form, "code_challenge"),
    codeChallengeMethod: field(form, "code_challenge_method"),
    prompt: null,
    maxAge: null,
    hasRequestObject: false,
    sessionToken: readSessionCookie(c),
  };
}

/**
 * 認可応答の URL を組み立てる。
 *
 * `URLSearchParams` に通すことで、`state` に含まれる記号が必ず符号化される。
 * 文字列結合で組むと、`state` に `&` や `#` を入れるだけで他のパラメータを
 * 偽装できる（クライアントが読む `code` を別の値にすり替えられる）。
 *
 * 既存のクエリは保持する。`redirect_uri` にクエリを持つ登録（完全一致で
 * 検証済み）がありうるため、上書きせず追加する（RFC 6749 §3.1.2）。
 */
function buildRedirect(redirectUri: string, params: Record<string, string | null>): string {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) {
    if (value !== null) url.searchParams.append(key, value);
  }
  return url.toString();
}

/**
 * 認可応答を返す。
 *
 * `302` ではなく `303 See Other` を使う。同意の POST からもこの関数を通るので、
 * 302 だとブラウザによっては POST のまま `redirect_uri` へ飛びうる。
 */
function redirectToClient(
  c: Context<AppBindings>,
  redirectUri: string,
  params: Record<string, string | null>,
): Response {
  // 認可応答は 1 回限りの `code` を含む。中間キャッシュに載せない。
  c.header("Cache-Control", "no-store");
  return c.redirect(buildRedirect(redirectUri, params), 303);
}

/**
 * 利用者が同意画面で下した判断。GET の時点ではまだ無い。
 */
type ConsentChoice = "allow" | "deny" | null;

/** 認可を拒否されたときの応答。宛先は検証済みなのでリダイレクトしてよい。 */
function denyToClient(
  c: Context<AppBindings>,
  redirectUri: string,
  state: string | null,
): Response {
  return redirectToClient(c, redirectUri, {
    error: "access_denied",
    error_description: "the user denied the authorization request",
    state,
  });
}

/**
 * `AuthorizationDecision` を HTTP 応答へ翻訳する。
 *
 * GET と同意の POST で共有する。片方だけ分岐を間違える余地を無くすため。
 */
async function respond(
  c: Context<AppBindings>,
  decision: AuthorizationDecision,
  /** 同意画面での選択。GET では null。 */
  choice: ConsentChoice = null,
): Promise<Response> {
  switch (decision.kind) {
    case "error_page": {
      // **リダイレクトしない。** 宛先が検証できていないのがこの分岐の理由。
      c.header("Cache-Control", "no-store");
      return c.html(<AuthorizeErrorPage reason={decision.error} />, 400);
    }

    case "error_redirect": {
      return redirectToClient(c, decision.redirectUri, {
        error: decision.error,
        error_description: decision.description,
        // `state` は受け取ったままを返す（RFC 6749 §4.1.2.1）。
        // クライアントの CSRF 対策がこれに依存している。
        state: decision.state,
      });
    }

    case "login_required": {
      // 戻り先は**現在の認可要求の URL** であって、入力された値ではない。
      // `sanitizeReturnTo` が `/oauth/authorize` 以外を通さない（ui/return-to.ts）。
      //
      // 同意画面の POST からここへ来た場合（表示中にセッションが切れた等）は
      // URL が `/oauth/consent` なので戻り先が付かず、素の `/login` になる。
      // form の hidden field から authorize の URL を組み直すこともできるが、
      // そのために「入力から URL を作る」経路を 1 本増やすほうが割に合わない。
      // 利用者はログイン後にアプリ側からやり直せる。
      c.header("Cache-Control", "no-store");
      return c.redirect(loginUrlWithReturnTo(returnToForRequest(c.req.url)), 303);
    }

    case "consent_required": {
      // 利用者が拒否した。クライアントへ `access_denied` を返す（RFC 6749 §4.1.2.1）。
      if (choice === "deny") {
        return denyToClient(c, decision.request.redirectUri, decision.request.state);
      }

      // 「許可」が押された。ここで初めて同意が成立する。同意の記録は
      // `IssueAuthorizationCodeUseCase` が行う（コードと同じ経路で残すことで、
      // 「コードはあるが同意の記録が無い」状態を作らない）。
      if (choice === "allow") {
        return issueCode(
          c,
          decision.request,
          decision.user.id,
          decision.sessionId,
          decision.authTime,
        );
      }

      const { request, user } = decision;
      const props = user.snapshot();
      c.header("Cache-Control", "no-store");
      return c.html(
        <ConsentPage
          clientName={request.client.name}
          displayName={props.displayName}
          username={props.username}
          scopes={request.scopes}
          request={{
            clientId: request.client.clientId,
            redirectUri: request.redirectUri,
            responseType: "code",
            scope: formatScope(request.scopes),
            state: request.state,
            nonce: request.nonce,
            codeChallenge: request.codeChallenge,
            codeChallengeMethod: request.codeChallengeMethod,
          }}
          csrfToken={ensureCsrfToken(c)}
        />,
      );
    }

    case "authorized": {
      // 同意済みのクライアントでも「許可しない」は尊重する。既存の同意を
      // 根拠に押し切ると、利用者が今この瞬間に下した判断を無視することになる。
      if (choice === "deny") {
        return denyToClient(c, decision.request.redirectUri, decision.request.state);
      }

      return issueCode(
        c,
        decision.request,
        decision.user.id,
        decision.sessionId,
        decision.authTime,
      );
    }
  }
}

/** 認可コードを発行して `redirect_uri` へ返す。 */
async function issueCode(
  c: Context<AppBindings>,
  request: Extract<AuthorizationDecision, { kind: "authorized" }>["request"],
  userId: string,
  sessionId: string,
  authTime: Date,
): Promise<Response> {
  const issued = await c.get("container").useCases.issueAuthorizationCode.execute({
    request,
    userId,
    sessionId,
    authTime,
  });

  if (!issued.ok) {
    // コードを作れなかった。入力ではなくサーバー側の問題なので、
    // `server_error` としてクライアントへ返す（RFC 6749 §4.1.2.1）。
    return redirectToClient(c, request.redirectUri, {
      error: "server_error",
      error_description: "failed to issue an authorization code",
      state: request.state,
    });
  }

  return redirectToClient(c, issued.value.redirectUri, {
    code: issued.value.code,
    state: issued.value.state,
  });
}

oauthAuthorizeRoutes.get("/oauth/authorize", pageSecurityHeaders, async (c) => {
  // ブラウザから来る経路なので IP 単位（#21）。正常利用は RP ごとに 1 回で、
  // SSO で複数アプリを渡り歩いても 1 分に 30 回へは届かない。
  const limited = await enforceIpRateLimit(c, "oauth_authorize");
  if (limited !== null) return limited;

  const decision = await c.get("container").useCases.authorizeRequest.execute(paramsFromQuery(c));
  return respond(c, decision);
});

/**
 * 同意画面の送信先。
 *
 * CSRF の扱いはログイン画面と揃える（Origin 検証 + double-submit トークン）。
 * 同意画面でこれを落とすと、攻撃者は被害者のブラウザに「許可」を押させる
 * だけで、自分のクライアントへ認可コードを発行させられる。
 */
oauthAuthorizeRoutes.post("/oauth/consent", pageSecurityHeaders, async (c) => {
  // `/oauth/authorize` と**同じ枠**。同意は認可要求と 1 続きの流れなので、
  // 片方だけ制限すると残った側へ寄るだけになる。正常利用は 1 往復に
  // つき authorize 1 回 + consent 1 回。
  const limited = await enforceIpRateLimit(c, "oauth_authorize");
  if (limited !== null) return limited;

  const form = await readForm(c);

  if (!isValidCsrf(c, form.get(CSRF_FIELD_NAME)?.toString())) {
    // 理由は書かない（トークンが古いのか Origin が違うのかを教えない）。
    // 認可要求そのものはまだ検証していないので、リダイレクトもしない。
    c.header("Cache-Control", "no-store");
    return c.html(<AuthorizeErrorPage reason="invalid_request" />, 403);
  }

  // 「許可」以外はすべて拒否として扱う（fail-closed）。ボタンの name が
  // 落ちた送信や、`decision` を細工した送信で黙って許可にならないようにする。
  const choice = form.get("decision") === "allow" ? "allow" : "deny";

  // hidden field を信用せず、GET とまったく同じ検証を通し直す。
  const decision = await c
    .get("container")
    .useCases.authorizeRequest.execute(paramsFromForm(c, form));

  return respond(c, decision, choice);
});

import type { OAuthClient } from "../../domain/entities/oauth-client";
import type { User } from "../../domain/entities/user";
import {
  isSupportedCodeChallengeMethod,
  isValidCodeChallenge,
  type CodeChallengeMethod,
} from "../../domain/services/pkce";
import { disallowedScopes, parseScope, unsupportedScopes } from "../../domain/services/scope";
import type { AuditLogger } from "../ports/audit-log.port";
import type { Clock } from "../ports/clock.port";
import type { OAuthGrantRepository } from "../ports/oauth-grant.repository";
import type { UserRepository } from "../ports/user.repository";
import type { GetSessionUseCase } from "./get-session.use-case";
import type { ResolveOAuthClientUseCase } from "./resolve-oauth-client.use-case";
import { settleSideEffects } from "./side-effects";

/**
 * 認可要求の生パラメータ。
 *
 * **すべて `string | null` で受ける。** クエリ文字列から来る値なので、
 * Presentation 側で型を整えようとすると「どこで検証したか」が 2 箇所に散る。
 * 形の判断はこの UseCase に集約する。
 */
export type AuthorizationRequestParams = {
  readonly clientId: string | null;
  readonly redirectUri: string | null;
  readonly responseType: string | null;
  readonly scope: string | null;
  readonly state: string | null;
  readonly nonce: string | null;
  readonly codeChallenge: string | null;
  readonly codeChallengeMethod: string | null;
  readonly prompt: string | null;
  readonly maxAge: string | null;
  /** `request` / `request_uri`（Request Object）が付いていたか。 */
  readonly hasRequestObject: boolean;
  /** セッション Cookie の値。未ログインなら null。 */
  readonly sessionToken: string | null;
};

/** 検証を通った認可要求。ここから先は生の入力文字列を使わない。 */
export type ValidatedAuthorizationRequest = {
  readonly client: OAuthClient;
  readonly redirectUri: string;
  readonly scopes: readonly string[];
  readonly state: string | null;
  readonly nonce: string | null;
  readonly codeChallenge: string;
  readonly codeChallengeMethod: CodeChallengeMethod;
};

/**
 * 認可要求に対する判断。
 *
 * ## `error_page` と `error_redirect` を分けている理由
 *
 * RFC 6749 §4.1.2.1 の中核。`client_id` が未知、あるいは `redirect_uri` が
 * 未登録の段階では、**その `redirect_uri` へエラーを返してはならない**。
 * 返した瞬間、攻撃者は u18 を踏み台にした任意の宛先へのリダイレクタとして
 * 使える（オープンリダイレクト）。この 2 つを別の種類にしてあるので、
 * Presentation 側で「どちらでもリダイレクトする」という実装が書けない。
 *
 * `error_redirect` に `redirectUri` を持たせているのも同じ意図で、
 * 宛先は**検証済みの値**として UseCase から渡る。Presentation が入力の
 * `redirect_uri` を読み直す必要が無い。
 */
export type AuthorizationDecision =
  /** 自前のエラー画面を出す。**リダイレクトしてはならない。** */
  | {
      readonly kind: "error_page";
      readonly error: "invalid_client" | "invalid_redirect_uri" | "invalid_request";
      readonly description: string;
    }
  /** 検証済みの宛先へ `error` / `state` を付けて返す。 */
  | {
      readonly kind: "error_redirect";
      readonly redirectUri: string;
      readonly state: string | null;
      readonly error: string;
      readonly description: string;
    }
  /** ログインが要る。Presentation は `/login` へ誘導し、戻り先を持ち回る。 */
  | { readonly kind: "login_required"; readonly request: ValidatedAuthorizationRequest }
  /**
   * 同意画面を出す。
   *
   * `authorized` と同じく `sessionId` / `authTime` を持たせてある。
   * 同意の POST はこの判断のまま「許可」を受け取るので、Presentation が
   * セッションを引き直さずにコードを発行できる必要がある。引き直すと、
   * 同意の可否を決めた判断と発行に使う判断が別物になる。
   */
  | {
      readonly kind: "consent_required";
      readonly request: ValidatedAuthorizationRequest;
      readonly user: User;
      readonly sessionId: string;
      readonly authTime: Date;
    }
  /** そのままコードを発行してよい。 */
  | {
      readonly kind: "authorized";
      readonly request: ValidatedAuthorizationRequest;
      readonly user: User;
      readonly sessionId: string;
      /** 実際に認証が行われた時刻（= セッションの作成時刻）。ID Token の `auth_time`。 */
      readonly authTime: Date;
    };

export type AuthorizeRequestDeps = {
  readonly resolveClient: ResolveOAuthClientUseCase;
  readonly getSession: GetSessionUseCase;
  readonly users: UserRepository;
  readonly grants: OAuthGrantRepository;
  readonly clock: Clock;
  readonly audit: AuditLogger;
};

/** OIDC Core 3.1.2.1 が定める `prompt` の値。 */
const KNOWN_PROMPTS = new Set(["none", "login", "consent", "select_account"]);

/**
 * `/oauth/authorize` の判断をすべて担う（仕様書 5.1 / 9、#15）。
 *
 * 画面の描画もリダイレクトもここでは行わず、「何をすべきか」だけを返す。
 * 判断を Presentation に書くと、検証の順序——とりわけ
 * 「`redirect_uri` が確定するまでリダイレクトしない」——がルートごとに
 * 再実装されることになり、1 箇所でも間違えればオープンリダイレクトになる。
 *
 * 同意画面の POST からも同じ UseCase を通す。hidden field で持ち回った
 * パラメータを信用せず、毎回ここで全部を検証し直すため。
 */
export class AuthorizeRequestUseCase {
  constructor(private readonly deps: AuthorizeRequestDeps) {}

  async execute(params: AuthorizationRequestParams): Promise<AuthorizationDecision> {
    // ---- 1. クライアントと宛先の確定（ここを抜けるまでリダイレクト禁止）----
    if (params.clientId === null || params.clientId === "") {
      return page("invalid_request", "client_id is required");
    }
    if (params.redirectUri === null || params.redirectUri === "") {
      // `redirect_uri` を省略して「登録が 1 本だけなら補う」という実装にしない。
      // 補完は完全一致検証の例外を 1 つ作ることであり、登録が複数ある
      // クライアントで「どれが選ばれたか」が利用者にも運用者にも見えなくなる。
      return page("invalid_request", "redirect_uri is required");
    }

    const resolved = await this.deps.resolveClient.execute({
      clientId: params.clientId,
      redirectUri: params.redirectUri,
    });
    if (!resolved.ok) {
      // `ResolveOAuthClientUseCase` は失敗理由を監査ログへ残している。
      // ここでは画面に出す種別だけを決める。
      return page(
        resolved.error.code === "invalid_redirect_uri" ? "invalid_redirect_uri" : "invalid_client",
        resolved.error.message,
      );
    }

    const { client, redirectUri } = resolved.value;
    // ここから先の失敗はすべて検証済みの宛先へ返せる。
    const reject = (error: string, description: string): AuthorizationDecision => ({
      kind: "error_redirect",
      redirectUri,
      state: params.state,
      error,
      description,
    });

    // ---- 2. 対応していない拡張 ----
    if (params.hasRequestObject) {
      // Request Object は署名・暗号の検証経路をもう 1 本増やす。Discovery でも
      // `request_parameter_supported: false` と広告しているので、黙って無視
      // するのではなく拒否する（無視すると、クライアントは署名したつもりの
      // パラメータが効いていないことに気付けない）。
      return reject("request_not_supported", "request objects are not supported");
    }

    // ---- 3. response_type ----
    if (params.responseType !== "code") {
      // Implicit / Hybrid は提供しない（仕様書 9）。`token` や `id_token` を
      // 受け付けると、フラグメント経由でトークンが URL バーと履歴に載る。
      return reject("unsupported_response_type", "only response_type=code is supported");
    }

    // ---- 4. PKCE（S256 必須）----
    if (params.codeChallenge === null || params.codeChallenge === "") {
      // public クライアントだけでなく confidential にも必須にする。
      // クライアント認証は「交換したのが誰か」しか担保せず、認可コードが
      // ブラウザから漏れる経路（RFC 9700 §4.1）は塞げない。
      return reject("invalid_request", "code_challenge is required");
    }
    if (!isSupportedCodeChallengeMethod(params.codeChallengeMethod)) {
      // 未指定を `plain` とみなす RFC 7636 の既定には従わず、明示を要求する。
      return reject("invalid_request", "code_challenge_method must be S256");
    }
    if (!isValidCodeChallenge(params.codeChallenge)) {
      return reject("invalid_request", "code_challenge is malformed");
    }

    // ---- 5. scope ----
    const requestedScopes = parseScope(params.scope ?? "");
    if (!requestedScopes.includes("openid")) {
      // u18 は OIDC Provider であって汎用の OAuth 2.0 AS ではない。
      // `openid` 無しの要求を通すと、ID Token の出ない認可が生まれ、
      // 「何のための認可か」が利用者にも説明できなくなる。
      return reject("invalid_scope", "the openid scope is required");
    }
    if (unsupportedScopes(requestedScopes).length > 0) {
      // 未知の scope は黙って捨てない。捨てると、クライアントが得たつもりの
      // 権限と実際に出る claim がずれる（domain/services/scope.ts）。
      return reject("invalid_scope", "requested scope is not supported");
    }
    if (disallowedScopes(requestedScopes, client.allowedScopes).length > 0) {
      return reject("invalid_scope", "requested scope is not allowed for this client");
    }

    // ---- 6. prompt / max_age ----
    const prompts = parseScope(params.prompt ?? "");
    if (prompts.some((value) => !KNOWN_PROMPTS.has(value))) {
      return reject("invalid_request", "prompt contains an unknown value");
    }
    if (prompts.includes("none") && prompts.length > 1) {
      // OIDC Core 3.1.2.1。`none` は「一切 UI を出すな」なので、
      // 他の値と同時に指定された要求は矛盾している。
      return reject("invalid_request", "prompt=none cannot be combined with other values");
    }
    const maxAgeSeconds = parseMaxAge(params.maxAge);
    if (maxAgeSeconds === "invalid") {
      return reject("invalid_request", "max_age must be a non-negative integer");
    }

    const request: ValidatedAuthorizationRequest = {
      client,
      redirectUri,
      scopes: requestedScopes,
      state: params.state,
      nonce: params.nonce,
      codeChallenge: params.codeChallenge,
      codeChallengeMethod: "S256",
    };

    // ---- 7. 認証 ----
    const now = this.deps.clock.now();
    const session = await this.loadSession(params.sessionToken);

    const needsFreshLogin =
      session === null ||
      prompts.includes("login") ||
      // 口座の選び直しを要求されたときも、ログイン画面へ戻すのが u18 の
      // 「アカウント選択」になる（専用の選択 UI は無い）。黙って現在の
      // セッションで通すと、別アカウントへ切り替える手段が無くなる。
      prompts.includes("select_account") ||
      (maxAgeSeconds !== null && isStale(session.authTime, now, maxAgeSeconds));

    if (needsFreshLogin) {
      if (prompts.includes("none")) {
        // `prompt=none` は「対話なしで済むなら通せ」という要求なので、
        // 画面を出す代わりにクライアントへ返す（OIDC Core 3.1.2.6）。
        return reject("login_required", "authentication is required");
      }
      return { kind: "login_required", request };
    }

    const user = await this.deps.users.findById(session.userId);
    if (user === null || !user.isActive) {
      // `GetSessionUseCase` が既に弾いている想定だが、ここでも確かめる。
      // トークン発行の手前で停止・削除済みユーザーを通さないことは
      // 1 箇所の実装に委ねたくない（仕様書 14-1 の決定 7）。
      return { kind: "login_required", request };
    }

    // ---- 8. 同意 ----
    const consent = await this.needsConsent(user.id, client, requestedScopes, prompts);
    if (consent) {
      if (prompts.includes("none")) {
        return reject("consent_required", "user consent is required");
      }
      return {
        kind: "consent_required",
        request,
        user,
        sessionId: session.sessionId,
        authTime: session.authTime,
      };
    }

    await settleSideEffects(
      "oauth.authorize",
      this.deps.audit.record({
        event: "oauth.authorize.decided",
        userId: user.id,
        outcome: "success",
        // 要求の中身（state / nonce / redirect_uri）は残さない。攻撃者が
        // 任意の文字列を監査ログへ書き込める経路になる。
        metadata: { clientId: client.clientId, scope: requestedScopes.join(" ") },
      }),
    );

    return {
      kind: "authorized",
      request,
      user,
      sessionId: session.sessionId,
      authTime: session.authTime,
    };
  }

  /**
   * 同意画面を出す必要があるか。
   *
   * ファーストパーティを省略してよいのは、u18 自身が運営するサービスに対して
   * 「u18 にログインする」以上の権限移譲が起きていないため（仕様書 7.1 の
   * スキーマコメント）。サードパーティは**必ず**取る。
   */
  private async needsConsent(
    userId: string,
    client: OAuthClient,
    requestedScopes: readonly string[],
    prompts: readonly string[],
  ): Promise<boolean> {
    // `prompt=consent` は既存の同意があっても取り直す。利用者が自分で
    // 確認し直したいときの手段を、ファーストパーティでも塞がない。
    if (prompts.includes("consent")) return true;
    if (client.isFirstParty) return false;

    const grant = await this.deps.grants.find(userId, client.id);
    return grant === null || !grant.covers(requestedScopes);
  }

  /** セッション Cookie から `userId` / `sessionId` / `auth_time` を取り出す。 */
  private async loadSession(
    sessionToken: string | null,
  ): Promise<{ userId: string; sessionId: string; authTime: Date } | null> {
    if (sessionToken === null || sessionToken === "") return null;

    const result = await this.deps.getSession.execute({ sessionToken });
    if (!result.ok || result.value === null) return null;

    return {
      userId: result.value.userId,
      sessionId: result.value.session.id,
      // `auth_time` はセッションの作成時刻を使う。u18 のセッションは
      // 「1 回の認証」と 1 対 1 で、途中で認証をやり直す経路が無い
      // （再認証は `domain/services/reauthentication.ts` も `created_at` を見る）。
      authTime: result.value.session.createdAt,
    };
  }
}

const page = (
  error: "invalid_client" | "invalid_redirect_uri" | "invalid_request",
  description: string,
): AuthorizationDecision => ({ kind: "error_page", error, description });

/** `max_age` を秒として読む。未指定は null、形式不正は "invalid"。 */
function parseMaxAge(raw: string | null): number | null | "invalid" {
  if (raw === null || raw === "") return null;
  if (!/^\d+$/.test(raw)) return "invalid";

  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : "invalid";
}

/** 認証からの経過が `max_age` を超えているか（OIDC Core 3.1.2.1）。 */
function isStale(authTime: Date, now: Date, maxAgeSeconds: number): boolean {
  return now.getTime() - authTime.getTime() > maxAgeSeconds * 1000;
}

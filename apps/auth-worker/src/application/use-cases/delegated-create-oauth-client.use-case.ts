import { newClientId } from "@u18/domain";
import type { OAuthClient, OAuthClientType } from "../../domain/entities/oauth-client";
import { validateLogoUrl } from "../../domain/services/logo-url";
import { validateRedirectUriForRegistration } from "../../domain/services/redirect-uri";
import { formatScope, unsupportedScopes } from "../../domain/services/scope";
import type { AuditLogger } from "../ports/audit-log.port";
import type { OAuthClientRepository } from "../ports/oauth-client.repository";
import type { RandomTokenGenerator, TokenHasher } from "../ports/crypto.port";
import type { UserRepository } from "../ports/user.repository";
import { requireExistingActor } from "./admin-access";
import { settleSideEffects } from "./side-effects";
import { err, ok, type UseCaseResult } from "./types";

export type DelegatedCreateOAuthClientCommand = {
  readonly actorUserId: string;
  readonly clientId: string;
  readonly name: string;
  readonly clientType: OAuthClientType;
  readonly redirectUris: readonly string[];
  readonly scopes?: readonly string[] | undefined;
  readonly logoUrl?: string | null | undefined;
};

export type DelegatedCreateOAuthClientOutput = {
  readonly client: OAuthClient;
  readonly clientSecret: string | null;
};

export type DelegatedCreateOAuthClientDeps = {
  readonly users: UserRepository;
  readonly clients: OAuthClientRepository;
  readonly tokens: RandomTokenGenerator;
  readonly hasher: TokenHasher;
  readonly audit: AuditLogger;
};

const DEFAULT_SCOPES = ["openid", "profile", "email"] as const;
const MAX_REDIRECT_URIS = 16;

/**
 * OAuth クライアントを登録する（admin-worker 経由、#390 決定 16 ③）。
 * `CreateOAuthClientUseCase` と対になる。
 *
 * ## 違いは認可の持ち方だけ
 *
 * **再認証（`hasFreshAuthentication`）を持たない。** 窓が守っていたのは
 * 「盗んだセッション Cookie 1 枚で登録できないこと」で、admin-worker
 * 経由にはそもそもセッション Cookie が無い。**`actorUserId` の実在だけ
 * 確かめる**（`requireExistingActor`）。
 *
 * **検証ロジックは共有する。** `validateRedirectUriForRegistration` /
 * `validateLogoUrl` / `unsupportedScopes` は Domain の純粋関数で、CLI・
 * 通常の管理画面・delegated の 3 つが同じものを読む。ここだけ別の判定を
 * 書くと、入口によって通る URI が変わる事故になる。
 *
 * **`is_first_party` を受け取らないのも同じ。** `CreateOAuthClientUseCase`
 * の JSDoc を参照 —— 「登録できる」と「同意を省略できる」は別の権限。
 *
 * **`client_id` は呼び出し元から受け取る。** `CreateOAuthClientUseCase`
 * 側は自動生成に変わったが（#408）、この入口は admin-worker からしか
 * 呼ばれず、画面の「二重送信で気づかれない重複ができる」問題がそのまま
 * 当てはまるかは admin-worker 側の UI 次第である。admin-worker の画面が
 * 固まったら、同じ判断（自動生成するか、受け取ったままにするか）を
 * ここでも下すこと。
 */
export class DelegatedCreateOAuthClientUseCase {
  constructor(private readonly deps: DelegatedCreateOAuthClientDeps) {}

  async execute(
    command: DelegatedCreateOAuthClientCommand,
  ): Promise<UseCaseResult<DelegatedCreateOAuthClientOutput>> {
    const actor = await requireExistingActor(this.deps, command.actorUserId);
    if (!actor.ok) return actor;
    const actorUserId = actor.value.userId;

    if (command.redirectUris.length === 0 || command.redirectUris.length > MAX_REDIRECT_URIS) {
      await this.record(actorUserId, "failure", command.clientId, { reason: "redirect_uri_count" });
      return err("invalid_input", "redirect_uris must contain 1..16 entries");
    }

    const validated: string[] = [];
    for (const uri of command.redirectUris) {
      const result = validateRedirectUriForRegistration(uri);
      if (!result.ok) {
        await this.record(actorUserId, "failure", command.clientId, {
          reason: "invalid_redirect_uri",
          metadata: { rejection: result.reason },
        });
        return err("invalid_input", `redirect_uri is not registrable (${result.reason})`);
      }
      validated.push(result.uri);
    }

    const logoUrl = command.logoUrl ?? null;
    if (logoUrl !== null) {
      const logo = validateLogoUrl(logoUrl);
      if (!logo.ok) {
        await this.record(actorUserId, "failure", command.clientId, {
          reason: "invalid_logo_url",
          metadata: { rejection: logo.reason },
        });
        return err("invalid_input", `logo_url is not acceptable (${logo.reason})`);
      }
    }

    const scopes = command.scopes ?? DEFAULT_SCOPES;
    const unsupported = unsupportedScopes(scopes);
    if (unsupported.length > 0) {
      await this.record(actorUserId, "failure", command.clientId, {
        reason: "unsupported_scope",
        metadata: { unsupported },
      });
      return err("invalid_input", "scopes contain unsupported values");
    }

    const clientSecret =
      command.clientType === "confidential" ? this.deps.tokens.generate(32) : null;
    const clientSecretHash =
      clientSecret === null ? null : await this.deps.hasher.hash(clientSecret);

    const created = await this.deps.clients.create({
      id: newClientId(),
      clientId: command.clientId,
      name: command.name,
      clientType: command.clientType,
      clientSecretHash,
      allowedScopes: formatScope(scopes),
      isFirstParty: false,
      logoUrl,
      redirectUris: validated,
    });

    if (created === null) {
      await this.record(actorUserId, "failure", command.clientId, {
        reason: "duplicate_client_id",
      });
      return err("conflict", "client_id is already registered");
    }

    await this.record(actorUserId, "success", command.clientId, {
      metadata: {
        internalId: created.id,
        clientType: created.clientType,
        redirectUris: validated,
        scopes: [...scopes],
      },
    });

    return ok({ client: created, clientSecret });
  }

  private async record(
    actorUserId: string,
    outcome: "success" | "failure",
    clientId: string,
    extra: { reason?: string; metadata?: Record<string, unknown> },
  ): Promise<void> {
    await settleSideEffects(
      "oauth.client.created",
      this.deps.audit.record({
        event: "oauth.client.created",
        userId: actorUserId,
        outcome,
        ...extra,
        metadata: { clientId, ...extra.metadata },
      }),
    );
  }
}

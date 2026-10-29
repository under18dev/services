import { newClientId } from "@u18/domain";
import type { OAuthClient, OAuthClientType } from "../../domain/entities/oauth-client";
import { validateRedirectUriForRegistration } from "../../domain/services/redirect-uri";
import { formatScope, unsupportedScopes } from "../../domain/services/scope";
import type { AuditLogger } from "../ports/audit-log.port";
import type { RandomTokenGenerator, TokenHasher } from "../ports/crypto.port";
import type { OAuthClientRepository } from "../ports/oauth-client.repository";
import { requireAdminSession, type AdminAccessDeps } from "./admin-access";
import { settleSideEffects } from "./side-effects";
import { err, ok, type UseCaseResult } from "./types";

export type CreateOAuthClientCommand = {
  readonly sessionToken: string;
  readonly clientId: string;
  readonly name: string;
  readonly clientType: OAuthClientType;
  readonly redirectUris: readonly string[];
  /** 省略すると `openid profile email`。 */
  readonly scopes?: readonly string[] | undefined;
  /** 省略すると false（同意画面を省略しない）。 */
  readonly isFirstParty?: boolean | undefined;
  readonly logoUrl?: string | null | undefined;
};

export type CreateOAuthClientOutput = {
  readonly client: OAuthClient;
  /**
   * 生成した `client_secret` の平文。public クライアントでは null。
   *
   * **ここから先、どこにも保存されない。** DB に入るのはハッシュだけで、
   * 呼び出し元が 1 度だけ表示する。
   */
  readonly clientSecret: string | null;
};

export type CreateOAuthClientDeps = AdminAccessDeps & {
  readonly clients: OAuthClientRepository;
  readonly tokens: RandomTokenGenerator;
  readonly hasher: TokenHasher;
  readonly audit: AuditLogger;
};

/** 既定の許可 scope。`oauth_clients.allowed_scopes` の既定と同じ（仕様書 5.1）。 */
const DEFAULT_SCOPES = ["openid", "profile", "email"] as const;

/** 1 クライアントあたりの Redirect URI の上限。契約側の zod と同じ値。 */
const MAX_REDIRECT_URIS = 16;

/**
 * OAuth クライアントを登録する（#308）。**管理者のみ。**
 *
 * ## これは緩和策の置き換えである
 *
 * `scripts/oauth-client.mjs` の冒頭が書いていたとおり、登録を叩ける場所を
 * 広げることは **Redirect URI の完全一致検証の前提を薄くする**ことに等しい。
 * 「運用者の手元からしか叩けない」を「管理者だけが叩ける」へ置き換えた
 * 以上、**管理者の資格が唯一の壁**になる（脅威モデル RR-21）。だから
 * 判定は Presentation ではなくここにある。
 *
 * ## 検証は Domain の関数をそのまま使う
 *
 * `validateRedirectUriForRegistration` は **CLI も同じものを読み込んでいる**
 * （`oauth-client.mjs` の `loadDomain`）。ここで別の判定を書くと、CLI で
 * 通した URI が認可時に弾かれる（あるいはその逆）という形でずれが出る。
 * 原因は URL を目視しても分からない。
 *
 * **`allowLoopbackHttp` は渡さない。** この入口から `http://localhost` を
 * 登録できると、本番 IdP に攻撃者の手元へ届く宛先を残せることになる
 * （`redirect-uri.ts` のコメント）。CLI は `--remote` との併用を禁じて
 * 同じことを防いでいるが、こちらは**本番にしか繋がらない**ので、
 * 選択肢そのものを置かない。
 *
 * ## `client_id` の重複は DB に止めさせる
 *
 * 「存在するか確認してから挿す」に分けない。同時に 2 本走ると両方が
 * 「無い」と判断しうる。`OAuthClientRepository.create` は unique index に
 * 衝突したとき `null` を返すので、それを `conflict` に写すだけでよい。
 */
export class CreateOAuthClientUseCase {
  constructor(private readonly deps: CreateOAuthClientDeps) {}

  async execute(
    command: CreateOAuthClientCommand,
  ): Promise<UseCaseResult<CreateOAuthClientOutput>> {
    const admin = await requireAdminSession(
      this.deps,
      command.sessionToken,
      "oauth.client.created",
    );
    if (!admin.ok) return admin;

    const { userId } = admin.value;

    if (command.redirectUris.length === 0 || command.redirectUris.length > MAX_REDIRECT_URIS) {
      // Redirect URI を持たないクライアントは認可フローに入れない。
      // 「後で足す」を許すと、未検証の URI が直接 SQL で入る経路ができる。
      await this.record(userId, "failure", command.clientId, { reason: "redirect_uri_count" });
      return err("invalid_input", "redirect_uris must contain 1..16 entries");
    }

    const validated: string[] = [];
    for (const uri of command.redirectUris) {
      const result = validateRedirectUriForRegistration(uri);
      if (!result.ok) {
        // 拒否の理由は返す。**登録しようとしているのは管理者本人**で、
        // 何を直せばよいか分からないと正規形に書き直せない（CLI も
        // 同じ理由で `reason` をそのまま出している）。
        await this.record(userId, "failure", command.clientId, {
          reason: "invalid_redirect_uri",
          metadata: { rejection: result.reason },
        });
        return err("invalid_input", `redirect_uri is not registrable (${result.reason})`);
      }
      validated.push(result.uri);
    }

    const scopes = command.scopes ?? DEFAULT_SCOPES;
    const unsupported = unsupportedScopes(scopes);
    if (unsupported.length > 0) {
      // 未知の scope を黙って無視すると、クライアントが得たつもりの権限と
      // 実際に出る claim がずれる（`domain/services/scope.ts`）。
      await this.record(userId, "failure", command.clientId, {
        reason: "unsupported_scope",
        metadata: { unsupported },
      });
      return err("invalid_input", "scopes contain unsupported values");
    }

    // 秘密は confidential のときだけ作る。public は PKCE だけで認証する
    // （仕様書 5.1）ので、持たせると「使われない秘密」が DB に残る。
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
      isFirstParty: command.isFirstParty === true,
      logoUrl: command.logoUrl ?? null,
      redirectUris: validated,
    });

    if (created === null) {
      await this.record(userId, "failure", command.clientId, { reason: "duplicate_client_id" });
      return err("conflict", "client_id is already registered");
    }

    await this.record(userId, "success", command.clientId, {
      // **宛先を残す。** この操作で増えたのは「認可コードを受け取ってよい
      // 場所」なので、後から調べるときに要るのは client_id ではなく URI の
      // 側である。秘密とそのハッシュは入れない（`AuditEvent.metadata`）。
      metadata: {
        internalId: created.id,
        clientType: created.clientType,
        isFirstParty: created.isFirstParty,
        redirectUris: validated,
        scopes: [...scopes],
      },
    });

    return ok({ client: created, clientSecret });
  }

  private async record(
    userId: string,
    outcome: "success" | "failure",
    clientId: string,
    extra: { reason?: string; metadata?: Record<string, unknown> },
  ): Promise<void> {
    await settleSideEffects(
      "oauth.client.created",
      this.deps.audit.record({
        event: "oauth.client.created",
        userId,
        outcome,
        ...extra,
        metadata: { clientId, ...extra.metadata },
      }),
    );
  }
}

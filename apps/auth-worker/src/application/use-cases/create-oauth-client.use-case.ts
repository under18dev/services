import { newClientId } from "@u18/domain";
import type { OAuthClient, OAuthClientType } from "../../domain/entities/oauth-client";
import { hasFreshAuthentication } from "../../domain/services/reauthentication";
import { validateRedirectUriForRegistration } from "../../domain/services/redirect-uri";
import { formatScope, unsupportedScopes } from "../../domain/services/scope";
import type { AuditLogger } from "../ports/audit-log.port";
import type { Clock } from "../ports/clock.port";
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
  readonly logoUrl?: string | null | undefined;
  // `isFirstParty` は**受け取らない**。クラスの JSDoc を参照。
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
  /** 再認証の窓を測るのに要る。 */
  readonly clock: Clock;
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
 * 以上、**管理者の資格が壁の中心**になる（脅威モデル RR-21）。だから
 * 判定は Presentation ではなくここにある。
 *
 * ## 再認証が要る
 *
 * **盗んだセッション Cookie 1 枚で通させない。** この操作が決めるのは
 * **認可コードの宛先**で、攻撃者が自分の `redirect_uri` を登録できると、
 * Redirect URI の完全一致検証（T-1）を**登録の側から迂回**できる。
 * 照合のコードは健在なまま、照合先が攻撃者のものになるという形である。
 *
 * **Passkey の登録（#306）が既存セッションだけで通るのと水準が違う。**
 * あちらは自分の認証器を**足す**操作で、こちらは**他人の認可の宛先を作る**
 * 操作である。`deletePasskey` / username の変更と同じ側に置く。
 *
 * 判定は `hasFreshAuthentication`（`domain/services/reauthentication.ts`）を
 * そのまま使う。**独自の窓を作らない** —— 再認証の意味が操作ごとに違うと、
 * 利用者から見た手順（ログインし直してからやり直す）も説明も分かれる。
 * 窓は 5 分で、セッションの `created_at` が「最後に本人確認を通した時刻」
 * そのものになっている（この実装にはセッション行を使い回したまま再認証する
 * 経路が無い）。
 *
 * **順序は「管理者か」が先、「新しいか」が後。** 逆にすると、古い
 * セッションを持つ一般利用者に `reauthentication_required` が返り、
 * **管理機能が存在することだけが伝わる**（`not_found` に畳んだ意味が消える）。
 *
 * ## `is_first_party` は受け取らない
 *
 * **この入口から同意画面の省略は指定できない。常に false で登録する。**
 *
 * 「クライアントを登録できる」と「同意を省略できる」は**別の権限**で、
 * 後者のほうが重い（T-1 の攻撃シナリオは「ファーストパーティなので
 * 同意画面が出ず、被害者が気づかない」を前提にしている）。1 つの口に
 * まとめると、**管理者アカウント 1 つの乗っ取りで同意の省略まで取れる。**
 *
 * 一次パーティの指定は稀で、重い判断である。経路は
 * `scripts/oauth-client.mjs --first-party` だけに残す ——
 * **あのスクリプトを残す理由が 1 つ増えた**ことになる。
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

    const { session, userId } = admin.value;

    // 管理者であることを確かめた**後**に見る。逆順だと、古いセッションの
    // 一般利用者に `reauthentication_required` が返り、`not_found` に
    // 畳んだ意味（管理機能の存在を漏らさない）が消える。
    if (!hasFreshAuthentication(session, this.deps.clock.now())) {
      await this.record(userId, "failure", command.clientId, { reason: "stale_authentication" });
      return err("reauthentication_required", "recent authentication is required");
    }

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
      // **常に false。** 同意画面の省略はこの入口から取れない（上記）。
      // 定数を直書きしているのは、command 側に項目が無いことを
      // 読む人に見せるため —— `command.isFirstParty === true` のような
      // 書き方だと「渡せば立つ」と読める。
      isFirstParty: false,
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

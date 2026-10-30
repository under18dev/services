import { z } from "zod";
import type { RpcResult } from "./errors";
import { rpcCallerSchema, sessionTokenSchema } from "./identity";

/**
 * auth-worker の **`IdentityAdminRPC`** が公開する DTO（#308）。
 *
 * ## なぜ `IdentityRpcContract` と分かれているか
 *
 * **Service Binding はメソッド単位で絞れない。** 束縛できるのは
 * `entrypoint` 単位で、その Entrypoint が持つメソッドは全部呼べる。
 * つまり管理用メソッドを `IdentityRpcContract` に足すと、
 * **`IdentityRPC` を束縛している Worker は全部それを呼べる**ことになる。
 *
 * いま束縛しているのは dashboard-worker と **nfc-worker** の 2 つ。
 * nfc-worker は設計上**管理者のセッショントークンを扱う** —— 運営による
 * カード発行の可否を `SessionSummary.isAdmin` で決めるために
 * `getSession` を呼んでおり（#187）、**管理者の新しいセッションが日常的に
 * あの Worker を通る**。しかも nfc-worker はレート制限も `no-store` の
 * 既定化も外れている（脅威モデル N-5）。侵害されたとき、通りかかった
 * 管理者のセッションで OAuth クライアントを登録できる状態は作らない。
 *
 * **`caller` では代えられない。** あれは自己申告で、侵害された Worker は
 * 別の Worker を名乗れる（`identity.ts` の `RPC_CALLERS`）。`entrypoint` は
 * Cloudflare 側で強制されるので、**実際に効く境界**になる。
 *
 * 誰がどの Entrypoint を束縛してよいかは
 * `scripts/check-service-bindings.mjs` が静的に検査する —— Worker が
 * 増えたときに黙って束縛されるのを防ぐため。
 */

// ------------------------------------------------------ OAuth クライアント管理
//
// **管理者だけが使える領域**（#308 / 仕様書 §14.1 決定 11 の段階 (2)）。
//
// ## これは緩和策の置き換えである
//
// `apps/auth-worker/scripts/oauth-client.mjs` の冒頭は、登録を HTTP へ
// 出さない理由をこう書いていた —— 「任意の `redirect_uri` を持つクライアントを
// 誰でも作れる」状態になると、認可コードの宛先を攻撃者が自分で登録できるので、
// Redirect URI の完全一致検証が無意味になる。**運用者の手元からしか
// 叩けないこと自体が緩和策**だった。
//
// 運用者の判断で、その緩和策を**「手元からしか叩けない」から
// 「管理者だけが叩ける」へ置き換える**。弱くなる方向の変更なので、
// 何が弱くなったかは `docs/threat-model.md` RR-21 に書いてある。
//
// 置き換えに伴って、この契約には 6 つの形がある。
//
// 1. **`client_secret_hash` を型に持たない。** `PasskeySummary` が公開鍵を
//    載せないのと同じで、フィルタではなく型で落とす（RR-13）。
// 2. **内部 ID（`oauth_clients.id`）も載せない。** 外へ出すと、以後それを
//    受け付ける API を消せなくなる（`GrantListItem.clientId` と同じ理由）。
// 3. **管理者でないセッションには `not_found` を返す。** 「権限がありません」と
//    「そんな機能はありません」を区別すると、管理機能の存在そのものが
//    一般利用者に漏れる。
// 4. **登録と失効には再認証が要る**（`reauthentication_required`）。
//    決めているのは**認可コードの宛先**なので、盗んだセッション Cookie
//    1 枚で通ってよい操作ではない —— 通ると、Redirect URI の完全一致検証を
//    **登録の側から迂回**できる。判定は auth-worker の UseCase にあり、
//    窓は `deletePasskey` / username 変更と同じ 5 分。
// 5. **同意画面の省略（`is_first_party`）はこの入口から指定できない。**
//    登録できることと同意を省略できることは別の権限で、後者のほうが重い。
// 6. **一次パーティのクライアントは失効させられない。** 登録と対称にして
//    ある —— 作れないものを止められると、管理者 1 人で `u18-dashboard` を
//    落として u18 全サービスのログインを止められる。止める経路は
//    `scripts/oauth-client.mjs disable` に残してある。

export const listOAuthClientsInputSchema = z.object({
  sessionToken: sessionTokenSchema,
  caller: rpcCallerSchema,
});

export type ListOAuthClientsInput = z.infer<typeof listOAuthClientsInputSchema>;

/**
 * 一覧・登録の応答に載せるクライアント。
 *
 * **`client_secret_hash` がこの型に無い。** 詰め忘れではなく「詰めようが
 * ない」形にしてある —— ハッシュは `client_secret` の総当たりにそのまま
 * 使える値で、confidential クライアントのなりすましは認可コードを
 * トークンへ換える力と等しい（脅威モデル E-5）。
 *
 * 平文の `client_secret` は `CreateOAuthClientResult` にだけ現れる。
 * 一覧から読み直す経路は作らない（作ると「後から誰でも読み出せる平文」に
 * 戻る）。
 */
export type OAuthClientSummary = {
  /** OIDC の公開 `client_id`。失効（`disableOAuthClient`）の引数にもこれを使う。 */
  readonly clientId: string;
  readonly name: string;
  readonly clientType: "confidential" | "public";
  /** 同意画面を省略してよい u18 公式サービスか（仕様書 5.1）。 */
  readonly isFirstParty: boolean;
  readonly logoUrl: string | null;
  /** 登録済み Redirect URI。完全一致で照合される実物（仕様書 9）。 */
  readonly redirectUris: readonly string[];
  /** 許可 scope。表示のために配列で渡す（`GrantListItem.scopes` と同じ形）。 */
  readonly scopes: readonly string[];
  /** ISO 8601 (UTC) */
  readonly createdAt: string;
  /** ISO 8601 (UTC)。失効していなければ null。 */
  readonly disabledAt: string | null;
};

/**
 * **失効済みのクライアントも含めて返す。**
 *
 * 除くと、画面から失効させた直後に行が消えることになり、運用者は
 * 「失効したのか、消えたのか、そもそも登録されていなかったのか」を
 * 区別できない。`disabledAt` を載せて表示側に判断させる。
 */
export type ListOAuthClientsResult = RpcResult<readonly OAuthClientSummary[]>;

// ------------------------------------------------------- createOAuthClient

export const createOAuthClientInputSchema = z.object({
  sessionToken: sessionTokenSchema,
  caller: rpcCallerSchema,
  /** OIDC の `client_id`。重複は DB の unique index が止める。 */
  clientId: z.string().min(1).max(255),
  name: z.string().min(1).max(255),
  clientType: z.enum(["confidential", "public"]),
  /**
   * 登録する Redirect URI。**1 つ以上必須。**
   *
   * 「後で足す」を許すと、未検証の URI が直接 SQL で入る経路ができる
   * （`oauth-client.mjs` と同じ判断）。検証そのものは auth-worker の
   * `domain/services/redirect-uri.ts` が行う —— **CLI も同じ関数を読んでいる**
   * ので、ここで別の判定を書くと CLI で通した URI が認可時に弾かれる
   * （あるいはその逆）という形でずれる。
   *
   * `http://localhost` は**この入口からは登録できない**。CLI の
   * `--allow-loopback-http` に当たるものを置いていないのは、本番 IdP に
   * ループバック宛の行が残ると、その `client_id` を知る攻撃者が被害者の
   * ブラウザで認可を走らせ、自分の手元で待つアプリへコードを届けられるため
   * （`redirect-uri.ts` のコメント）。開発用クライアントは引き続き
   * `scripts/oauth-client.mjs seed-dev` で入れる。
   */
  redirectUris: z.array(z.string().min(1).max(2048)).min(1).max(16),
  /**
   * 許可 scope。省略すると `openid profile email`。
   *
   * 既定も上限も auth-worker の `CreateOAuthClientUseCase` にある。
   * **ここで弾くのは早期に返すためで、正本はあちら**（`updateProfile` の
   * `displayName` と同じ扱い）。
   */
  scopes: z.array(z.string().min(1).max(64)).min(1).max(16).optional(),
  logoUrl: z.string().max(2048).nullable().optional(),
  // **`isFirstParty` は無い。** この入口から登録したクライアントは
  // 必ず third-party（同意画面が出る）になる。
  //
  // 「クライアントを登録できる」と「同意を省略できる」は**別の権限**で、
  // 後者のほうが重い —— 脅威モデル T-1 の攻撃シナリオは「ファースト
  // パーティなので同意画面が出ず、被害者が気づかない」を前提にしている。
  // 1 つの口にまとめると、**管理者アカウント 1 つの乗っ取りで同意の省略
  // まで取れる。**
  //
  // **項目ごと置いていない**のは、`isFirstParty: false` を残すと次に見た
  // 人が「渡せば立つ」と読むため。一次パーティの登録は
  // `scripts/oauth-client.mjs --first-party` だけに残してある（RR-21）。
});

export type CreateOAuthClientInput = z.infer<typeof createOAuthClientInputSchema>;

export type CreateOAuthClientResult = RpcResult<{
  readonly client: OAuthClientSummary;
  /**
   * 生成した `client_secret` の**平文**。public クライアントでは null。
   *
   * **この応答にしか存在しない。** DB に入るのはハッシュだけで（仕様書 7.1）、
   * 取り損ねたら再発行するしかない。これは不便ではなく、「後から誰でも
   * 読み出せる平文」を作らないための形である（`oauth-client.mjs` の
   * `generateSecret` と同じ判断）。
   */
  readonly clientSecret: string | null;
}>;

// ------------------------------------------------------ disableOAuthClient

export const disableOAuthClientInputSchema = z.object({
  sessionToken: sessionTokenSchema,
  /** 失効させるクライアントの公開 `client_id`。 */
  clientId: z.string().min(1).max(255),
  caller: rpcCallerSchema,
});

export type DisableOAuthClientInput = z.infer<typeof disableOAuthClientInputSchema>;

export type DisableOAuthClientResult = RpcResult<{
  /**
   * 行が「失効済み」へ遷移したか。**既に失効済みでも、未登録の `client_id`
   * でも false（冪等）。**
   *
   * 区別しないのは `revokeGrant` と同じ理由で、区別すると「どの `client_id`
   * が登録済みか」を総当たりで調べる窓口になる。失効は何度呼んでも同じ
   * 状態へ収束し、`disabled_at` は最初の 1 回から動かない
   * （`DrizzleOAuthClientRepository.disable`）。
   *
   * **発行済みの Access Token は止まらない。** 止まるのは**以後の認可**
   * だけで、既に出ているトークンは期限（最大 10 分）まで
   * `/oauth/userinfo` から claim を返し続ける。いま動いているアクセスを
   * 切るのは `revokeGrant` の仕事である。**表示側は「アクセスを停止
   * しました」と書かないこと** —— 正しくは「新しい認可を止めました」。
   *
   * **一次パーティのクライアントはここでは止まらない**（`conflict` が
   * 返る）。登録できないものを止められる形にすると、管理者 1 人で
   * `u18-dashboard` を失効させ、u18 全サービスのログインを落とせる。
   */
  readonly disabled: boolean;
}>;

/**
 * dashboard-worker が Service Binding 越しに見る **管理用** Entrypoint の形。
 * auth-worker 側の `IdentityAdminRPC` はこの型を満たす必要がある。
 *
 * **`ping` を置いていない。** 死活確認は `IdentityRpcContract` の側にあり、
 * ここに重ねると「認証を要求しない入口」が 2 つになる。
 */
export interface IdentityAdminRpcContract {
  /**
   * OAuth クライアントの一覧（#308）。**管理者のセッションでしか通らない。**
   *
   * 判定は auth-worker の UseCase の中にある。呼び出し元の画面が
   * 管理者向けの導線を隠しているかどうかとは独立に効く。
   */
  listOAuthClients(input: ListOAuthClientsInput): Promise<ListOAuthClientsResult>;
  /** OAuth クライアントの新規登録（#308）。**管理者のみ。再認証が要る。** */
  createOAuthClient(input: CreateOAuthClientInput): Promise<CreateOAuthClientResult>;
  /**
   * OAuth クライアントの失効（#308）。**管理者のみ。再認証が要る。**冪等。
   *
   * **一次パーティのクライアントは失効させられない**（`conflict`）。
   * 止める経路は `scripts/oauth-client.mjs disable` だけに残してある。
   */
  disableOAuthClient(input: DisableOAuthClientInput): Promise<DisableOAuthClientResult>;
}

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

/**
 * `client_id` は**受け取らない**（運用者の判断、2026-10-30）。
 *
 * 以前はここで呼び出し元が決める値だった。**自動生成に変えた** ——
 * `CreateOAuthClientUseCase` が `newPublicClientId()` で発行する。
 *
 * **これにより「`client_id` に一意制約があるので 2 回押しても 2 本目は
 * `conflict` になる、だから `Idempotency-Key` は要らない」という以前の
 * 根拠が崩れている。** 自動生成だと再送信のたびに別の ID が割り当たり、
 * 一意制約は「同じ ID が 2 行になる」ことしか防がない。
 *
 * **それでも `Idempotency-Key` を足していない。** 登録は管理者だけが
 * 叩く稀な操作で、二重送信で 2 本できても実害は小さく、気づいたら
 * 片方を失効させれば済む（`disableOAuthClient` は冪等）。新しい状態
 * 保持の仕組みを 1 つ増やすより、この画面には見合わないと判断した。
 */
export const createOAuthClientInputSchema = z.object({
  sessionToken: sessionTokenSchema,
  caller: rpcCallerSchema,
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

// ------------------------------------------------------------ 利用者の管理
//
// **他人の `userId` を扱う最初の領域である**（#375 / #382）。これまでの
// RPC はすべて「セッションの持ち主」しか指せなかった —— `sessionToken` が
// 誰を指すかを auth-worker が決めており、**呼ぶ側は対象を選べなかった。**
//
// ## 増えた面
//
// 1. **列挙できるようになる。** 一覧がある以上「u18 に誰が居るか」は
//    管理者から見える。隠しても意味が無いので隠さない代わりに、
//    **管理者でない呼び出しは `not_found`** に畳む（`admin-access.ts`）
// 2. **`userId` が入力になる。** 総当たりの的が増えるが、**的に当たっても
//    管理者のセッションが無ければ何も返らない。** ID の秘匿を防御に
//    使わない（`revokeSession` が他人のセッション ID と存在しない ID を
//    同一視しているのと同じ判断）
//
// ## メールアドレスを載せる
//
// **これは「他人の個人情報を画面に出す」最初の口である。** 載せるのは、
// 運用の問い合わせが**アドレスで来る**ため —— 載せないと、管理者は結局
// `wrangler d1 execute` で SQL を打つことになり、この画面を作った意味が
// 無くなる（ランブック §11.6 / §11.7 はアドレスで本人を特定している）。
//
// **そのぶん置き場所を縛る。** 画面は `Cache-Control: no-store`
// （dashboard の `root.use("*")` が既定で付ける）、**URL に載せない**
// （`csrf.ts` が拒否のログに `pathname` を書く）。検索語はクエリではなく
// **form POST の本文**で渡すこと。

export const listUsersInputSchema = z.object({
  sessionToken: sessionTokenSchema,
  caller: rpcCallerSchema,
  /**
   * 絞り込み。**省略すると新しい順の先頭から返す。**
   *
   * 照合は「メールアドレスの完全一致」か「username の完全一致」だけで、
   * **部分一致を持たない。** `LIKE %x%` は索引から外れて全表走査になる
   * うえ、**管理者が思っていない行まで拾う** —— 問い合わせ対応で
   * 「このアドレスの人」を引くのに部分一致は要らない。
   */
  query: z.string().min(1).max(320).optional(),
  /** 続きを読む位置。前回の応答の `nextCursor` をそのまま渡す。 */
  cursor: z.string().min(1).max(64).optional(),
  /**
   * 1 回で返す上限。**既定 50、最大 200。**
   *
   * 上限を置くのは応答の大きさのためだけではない。**1 回で全員を返せる
   * 口があると、それが「利用者名簿を 1 リクエストで吸い出す口」になる。**
   */
  limit: z.number().int().min(1).max(200).optional(),
});

export type ListUsersInput = z.infer<typeof listUsersInputSchema>;

/**
 * 管理画面の一覧に出す 1 人分。
 *
 * **`UserProfile` と別の型にしてある。** あちらは「本人が見る自分」で、
 * ここは「管理者が見る他人」である。同じ型を使い回すと、本人向けに
 * 足した項目が管理画面にも自動で出る —— **逆もまた起きる**（管理用に
 * 足した項目が本人の `/api/me` に出る）。
 *
 * **パスキーの公開鍵もセッショントークンも持たない。** `PasskeySummary`
 * と同じで、フィルタではなく型で落とす（RR-13）。
 */
export type UserAdminSummary = {
  /**
   * 内部 ID。**凍結や失効の引数になるので載せる。**
   *
   * `OAuthClientSummary` が `oauth_clients.id` を載せていないのと
   * 判断が違う。あちらは公開の `client_id` という別の鍵があったが、
   * **利用者には username しか無く、あれは本人が変えられる。**
   * 操作の宛先が時間で変わる鍵だと、**一覧で見た人と操作した人が
   * 違う**ことが起こりうる。
   */
  readonly id: string;
  readonly username: string;
  readonly displayName: string;
  /** **他人のアドレス。** 画面に出す条件は上の節を読むこと。 */
  readonly primaryEmail: string;
  readonly emailVerified: boolean;
  /**
   * `active` / `suspended` / `deleted`。
   *
   * **`suspended` は 2 つの理由で付く** —— 運営による凍結と、本人の退会
   * （#318）。**`status` だけでは区別できない。** 区別は `audit_logs` の
   * `account.closed` が持っているので、**画面で「凍結されています」と
   * 言い切らないこと。**
   */
  readonly status: "active" | "suspended" | "deleted";
  /**
   * `users.is_admin` が立っているか。**「いま管理者として振る舞える」
   * ではない。**
   *
   * ## 名前を `isAdmin` にしていない
   *
   * 契約の他の `isAdmin`（`SessionSummary` / `UserProfile`）は
   * **`User.actsAsAdminWith(authMethod)`** の結果で、「**この
   * セッションで**管理者として振る舞ってよいか」を意味する（決定 8 /
   * RR-5 / #337）。一覧に出すのは**他人の行**で、その人がいまどんな
   * セッションを持っているかは分からない。**同じ名前にすると、意味の
   * 違う 2 つが同じ型・同じ名前で並ぶ。**
   *
   * #337 で踏んだのがまさにその形だった —— `isAdmin` の意味が狭まった
   * のに、Presentation の 2 か所が `users` の行から直接詰めていて、
   * **型は `boolean` なので何も言われなかった。** あれを見つけるために
   * `vitest.config.ts` の走査（`isAdmin:` の右辺を集める）を入れてある。
   * **この項目はその走査に引っかかって当然なので、名前のほうを変えた。**
   *
   * ## 旗が立っていてもログインできるとは限らない
   *
   * 決定 8 により、管理者はメール OTP 単独ではログインできない。
   * **「管理者」と出ている人が、いま u18 に入れるかは別の話である。**
   */
  readonly hasAdminFlag: boolean;
  /** ISO 8601 (UTC) */
  readonly createdAt: string;
};

/**
 * **最終ログイン（`users.last_login_at`、#286）を載せていない。**
 *
 * 列は実在するが、**Domain の `User` が持っていない** —— あれは
 * `touchLastActive` が書くだけの列で、`UserProps` に写されていない。
 * ここへ足すには Entity を広げる必要があり、**それは「一覧を出す」
 * 以上の変更になる。**
 *
 * 載せる価値はある（保持期間は「最終利用から 1 年」で、ランブック
 * §11.7 の起点がこの列である）。**足すときは Domain から**。
 * 契約にだけ足して Presentation で行を直接読む形にしないこと ——
 * そこだけ Repository を迂回する経路になる。
 */

/**
 * 停止の理由（#375 / ランブック §11.1 の表）。
 *
 * **`status` は `suspended` の 1 値しか持たない。** 「侵害の疑いによる
 * 緊急停止」「規約違反による BAN」「本人の退会」の 3 つが同じ値に畳まれる
 * ので、**どれだったかは `audit_logs` にしか残らない。** 管理者が立てる
 * のはこの 2 つで、3 つ目は `account.closed`（#318）が記録する。
 *
 * **自由記述にしていない。** 後から読んで効くのは「戻す前提か」だけで、
 * 文章にすると集計も検索もできなくなる。
 */
export const suspendReasonSchema = z.enum(["compromise", "abuse"]);
export type SuspendReason = z.infer<typeof suspendReasonSchema>;

export const suspendUserInputSchema = z.object({
  sessionToken: sessionTokenSchema,
  caller: rpcCallerSchema,
  userId: z.string().min(1).max(64),
  reason: suspendReasonSchema,
});
export type SuspendUserInput = z.infer<typeof suspendUserInputSchema>;

export type SuspendUserResult = RpcResult<{
  /**
   * 切ったセッションの本数。
   *
   * **「切ったから止まる」ではない。** 停止した時点で次の要求から通らなく
   * なる（auth-worker の `GetSessionUseCase` が `isActive` を見る）。
   * 切るのは、止まっているのに生きた行が残る状態を作らないため。
   */
  readonly revokedSessions: number;
}>;

export const reinstateUserInputSchema = z.object({
  sessionToken: sessionTokenSchema,
  caller: rpcCallerSchema,
  userId: z.string().min(1).max(64),
});
export type ReinstateUserInput = z.infer<typeof reinstateUserInputSchema>;

/**
 * 解除の応答。**中身が無い。**
 *
 * 「何が起きたか」は `status` が `active` に戻ったことに尽きる。件数を
 * 返すと呼ぶ側がそれを使った文言を書きたくなるが、**戻るのは 1 行**である。
 */
export type ReinstateUserResult = RpcResult<Record<string, never>>;

export const revokeUserSessionsInputSchema = z.object({
  sessionToken: sessionTokenSchema,
  caller: rpcCallerSchema,
  userId: z.string().min(1).max(64),
});
export type RevokeUserSessionsInput = z.infer<typeof revokeUserSessionsInputSchema>;

export type RevokeUserSessionsResult = RpcResult<{ readonly revokedSessions: number }>;

/**
 * 監査ログの 1 行（#375）。
 *
 * **`ipHash` を載せている。** `SessionListItem` の JSDoc が「必要になったら
 * 専用の管理用 RPC を分ける」と書いていた、その RPC がこれである。
 * dashboard がこの DTO をそのまま返すのは本人向けの画面だけ、という
 * 前提がここでは成り立たない —— **呼べるのは管理者だけ**なので、
 * 同じ Worker を調べた複数アカウントを `ipHash` で結び付ける調査ができる。
 */
export type AuditLogEntryAdmin = {
  readonly id: string;
  readonly event: string;
  readonly userId: string | null;
  readonly actor: string | null;
  readonly outcome: "success" | "failure";
  readonly reason: string | null;
  /**
   * **秘密を含まないことは書き込み側が保証している**（`AuditEvent` の
   * JSDoc と `test/audit-secrets.test.ts`）。ここで二重に選別しない ——
   * 「何が安全に含まれるか」の正本を 2 か所に作らない。
   */
  readonly metadata: Record<string, unknown> | null;
  readonly ipHash: string | null;
  readonly userAgent: string | null;
  /** ISO 8601 (UTC) */
  readonly createdAt: string;
};

export const listAuditLogsInputSchema = z.object({
  sessionToken: sessionTokenSchema,
  caller: rpcCallerSchema,
  /**
   * イベント名の完全一致。**列挙はしない** —— 登録簿（`AUDIT_EVENTS`）は
   * auth-worker の内部にあり、contracts へ持ち出すと二重管理になる。
   * 一致しない文字列を渡しても 0 件が返るだけで、エラーにはしない。
   */
  event: z.string().min(1).max(64).optional(),
  userId: z.string().min(1).max(64).optional(),
  outcome: z.enum(["success", "failure"]).optional(),
  cursor: z.string().min(1).max(64).optional(),
  limit: z.number().int().min(1).max(200).optional(),
});
export type ListAuditLogsInput = z.infer<typeof listAuditLogsInputSchema>;

export type ListAuditLogsResult = RpcResult<{
  readonly entries: readonly AuditLogEntryAdmin[];
  readonly nextCursor: string | null;
}>;

export type ListUsersResult = RpcResult<{
  readonly users: readonly UserAdminSummary[];
  /**
   * 続きがあるときだけ入る。**件数の合計は返さない。**
   *
   * `count(*)` は行が増えるほど重くなるうえ、**管理者が知りたいのは
   * 「この条件の人が居るか」であって総数ではない。** 総数が要るように
   * なったら、そのための口を別に作ること（一覧のついでに数えない）。
   */
  readonly nextCursor: string | null;
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
  /**
   * 利用者の一覧（#375）。**管理者のみ。**
   *
   * **再認証は要求していない。** 読み取りだけで、状態を 1 つも変えない
   * —— `listOAuthClients` と同じ扱いである。変える操作（凍結・セッション
   * の失効）をここへ足すときは、**そちらに `hasFreshAuthentication` を
   * 付けること。**
   */
  listUsers(input: ListUsersInput): Promise<ListUsersResult>;
  /**
   * 利用者を停止する（#375）。**管理者のみ。再認証が要る。**
   *
   * **自分は止められない**（`conflict`）—— 止めた瞬間に自分のセッションが
   * 死に、解除する人が居なくなる。
   *
   * **理由（`reason`）は `audit_logs` にしか残らない。** `status` は
   * 1 値なので、記録を消すと「なぜ止まっているか」が分からなくなる。
   */
  suspendUser(input: SuspendUserInput): Promise<SuspendUserResult>;
  /**
   * 停止を解除する（#375）。**管理者のみ。再認証が要る。**
   *
   * **`deleted` の利用者は戻せない**（`conflict`）。あれは個人情報が
   * 落ちている状態で、**落とした情報は戻らないのに `active` に見える
   * アカウント**ができる。
   */
  reinstateUser(input: ReinstateUserInput): Promise<ReinstateUserResult>;
  /**
   * 利用者のセッションを全部切る（#375）。**管理者のみ。再認証が要る。**
   *
   * **停止とは別の操作である。** 止めずに切りたいことがある —— 端末を
   * 失くした人の救済や、侵害の疑いが晴れていない段階での予防。
   * **自分に対しては許している**（全端末からログアウト）。
   */
  revokeUserSessions(input: RevokeUserSessionsInput): Promise<RevokeUserSessionsResult>;
  /**
   * 監査ログの閲覧（#375）。**管理者のみ。**
   *
   * これまで `wrangler d1 execute` でしか読めなかった。再認証は要求して
   * いない —— 読み取りだけで状態を変えない（`listUsers` と同じ扱い）。
   */
  listAuditLogs(input: ListAuditLogsInput): Promise<ListAuditLogsResult>;
}

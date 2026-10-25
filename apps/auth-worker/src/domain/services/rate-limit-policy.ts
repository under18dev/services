/**
 * レート制限のポリシー（仕様書 9 Abuse、#21）。
 *
 * `token-lifetime.ts` が「いつまで使えるか」、`retention-policy.ts` が
 * 「いつまで残すか」の単一の出典であるように、ここは「どれだけ叩けるか」の
 * 単一の出典である。
 *
 * ## これは**バースト**だけを見る層である
 *
 * Cloudflare の Rate Limiting binding は `period` に **10 秒か 60 秒しか
 * 取れない**。つまりこの層で止められるのは「短時間に大量」までで、
 * 「60 秒ごとに 1 通を延々と」は止まらない。それは #88 で直したのと同じ形の
 * 穴なので、**持続的な濫用はアドレス単位の長い窓で別に止める**
 * （`OtpPolicy.resendWindowMs`、D1 の行数で判定）。二層で 1 組である。
 *
 * ここだけを見て「レート制限は入っている」と判断しないこと。
 *
 * ## binding 名をここに置いてある理由
 *
 * `limit` / `period` の実体は `wrangler.jsonc` の `ratelimits` にあり、
 * **コードからは読めない**。binding 側の値を変えてもこのファイルは変わらず、
 * ずれても誰も気づかない —— `Retry-After` に載せる秒数がここから出る以上、
 * ずれは利用者に見える形で現れる。
 *
 * そこで設定と突き合わせられるよう binding 名まで含めてここに書き、
 * `test/rate-limit-config.test.ts` で `wrangler.jsonc` と照合している。
 * `retention-policy.ts` が D1 の物理テーブル名をそのまま持っているのと同じ理由。
 */

/** 制限をかける対象。エンドポイントではなく「守りたいもの」の単位で切る。 */
export type RateLimitScope =
  "email_start" | "email_verify" | "login_verify" | "oauth_authorize" | "oauth_client";

export type RateLimitRule = {
  /** `wrangler.jsonc` の `ratelimits[].name`。 */
  readonly binding: string;
  /** `period` の間に許す回数。 */
  readonly limit: number;
  /** binding が取れるのは 10 か 60 のみ。 */
  readonly periodSeconds: 10 | 60;
};

/**
 * 閾値の根拠はランブック §7.4 に書いてある。**変えるときはそちらも直すこと。**
 *
 * いずれも IP 単位で、1 人の利用者が普通に操作して到達する値ではない。
 * 共有回線（学校・CGNAT）では複数人が同じ鍵を共有するため、
 * 「1 人分の必要回数」ではなく「同一 IP の後ろに何人いるか」で見ている。
 */
export const RateLimitPolicy: Readonly<Record<RateLimitScope, RateLimitRule>> = {
  /**
   * OTP の送信要求。
   *
   * 1 通送るのに 1 回。利用者が再送を押しても 60 秒のクールダウンがあるので、
   * 正常利用で 1 分に 10 回へ届くことはない。宛先を変えながらのメール爆撃は
   * ここで頭打ちになる（アドレス単位の上限はアドレスを変えると回避される）。
   */
  email_start: { binding: "RL_EMAIL_START", limit: 10, periodSeconds: 60 },

  /**
   * OTP の検証。
   *
   * challenge 単位の試行上限（`OtpPolicy.maxAttempts` = 5）は、アドレスを
   * 変えながら総当たりされると効かない。IP 単位で頭を押さえる。
   */
  email_verify: { binding: "RL_EMAIL_VERIFY", limit: 15, periodSeconds: 60 },

  /**
   * Passkey のログイン検証。
   *
   * 署名検証は CPU を使うので、失敗を投げ続けられること自体が負荷になる。
   * 正常利用は 1 回で終わるため、他の 2 つより緩めても危険が増えない。
   */
  login_verify: { binding: "RL_LOGIN_VERIFY", limit: 20, periodSeconds: 60 },

  /**
   * `GET /oauth/authorize`。**IP 単位。**
   *
   * ブラウザから来る経路なので、他のエンドポイントと同じ扱いでよい。
   * 正常利用では RP ごとに 1 回で、SSO で複数アプリを渡り歩いても
   * 1 分に 30 回へは届かない。
   */
  oauth_authorize: { binding: "RL_OAUTH_AUTHORIZE", limit: 30, periodSeconds: 60 },

  /**
   * `POST /oauth/token` と `POST /oauth/revoke`。**`client_id` と IP を混ぜた鍵。**
   *
   * ## なぜ IP 単位にしないのか
   *
   * この 2 つを叩くのは**ブラウザではなく RP のサーバ**である。IP 単位に
   * すると 1 台の RP に利用者全員分のトークン交換が集中して、正常利用が
   * 弾かれる。
   *
   * ## なぜ `client_id` 単位にもしないのか
   *
   * #21 の本文は「client 単位」と書いているが、**そのままでは攻撃者が
   * 被害クライアントを締め出せる。** `client_id` は秘密ではないので、
   * 他人のそれを名乗って枠を使い切るだけでよい。ブルートフォースを
   * 防ぐつもりが、より安いサービス妨害を 1 つ増やすことになる。
   *
   * ## 混ぜると両方が成り立つ
   *
   * 鍵を `<client_id>:<ipHash>` にすると、
   *
   *  - 本物の RP は自分の IP に自分の枠を持つ（攻撃者に消費されない）
   *  - 攻撃者は「自分の IP × 被害クライアント」の枠しか消費できない
   *
   * **残る穴**: 攻撃者が `client_id` を変えながら同じ IP から叩くと、
   * 鍵が毎回変わるので総量は抑えられない。ただしその経路はクライアント
   * 認証で即座に弾かれるうえ、`client_id` の総当たりそのものになる。
   * 経路全体の総量規制は RR-1 の残りとして `/api/me` 系と一緒に扱う。
   *
   * ## 2 つの経路で枠を共有する
   *
   * RFC 7009 §2.1 が `/oauth/revoke` に `/oauth/token` と**同じ**クライアント
   * 認証を求めており、実装も `oauth.client-auth.ts` を共有している。
   * 攻撃者がどちらを叩いても同じ枠を消費するほうが、総量として素直である。
   * 代償として、トークン交換の多い RP は失効の枠も食う。
   */
  oauth_client: { binding: "RL_OAUTH_CLIENT", limit: 60, periodSeconds: 60 },
} as const;

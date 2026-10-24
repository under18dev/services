import { AuditRetention, type AuditRetentionTier } from "../../domain/services/retention-policy";

/**
 * 監査イベント名の登録簿（#22、仕様書 7.1 / 9）。
 *
 * ## なぜ `string` ではないのか
 *
 * 以前は `AuditEvent.event` が `string` だった。そのため **typo が黙って通り**、
 * `session.revoke` と `session.revoked` のような揺れが混ざっても、
 * 気づくのは侵害調査で「このイベントが 1 件も出てこない」と分かった時になる。
 * 調査の最中に監査ログの名前が信用できないと分かるのが最悪の順序である。
 *
 * 「宣言はあるが発動しない」を型で止める、という点では #88（再送上限が
 * 一度も発動していなかった）と同じ構図になっている。
 *
 * ## 名前を変えていない
 *
 * `session.issue` / `otp.start` のように、動詞の形が揃っていない名前がある。
 * ここは**実際に使われている名前をそのまま写した**。改名すると
 * ランブック §5.2 / §5.3 の調査用 SQL と、将来の本番データの両方が
 * 食い違う。揺れの修正は、名前の集合を閉じることとは別の判断である。
 *
 * ## 追加するとき
 *
 * この配列に足すだけでは足りない。**`src/` のどこからも発行されない名前が
 * 残ると `test/audit-events.test.ts` が落ちる。** 登録簿と実装が離れないよう、
 * わざとそうしてある。
 */
export const AUDIT_EVENTS = [
  // --- セッション ---
  /** セッション発行。失敗の `reason` は `user_not_active` など。 */
  "session.issue",
  /** セッションの提示が拒否された。期限切れ・失効・不存在を区別せず畳む。 */
  "session.rejected",
  /** 単一セッションの失効（本人操作）。 */
  "session.revoke",
  /** ログアウト。全デバイス失効を含む。 */
  "session.logout",

  // --- メール OTP ---
  /** OTP 送信要求。`reason` に `resend_limit` / `no_eligible_account`。 */
  "otp.start",
  /** OTP 検証。`reason` に `attempts_exhausted` / `mismatch` / `user_missing` など。 */
  "otp.verify",

  // --- Passkey ---
  /** Passkey 登録の検証。 */
  "passkey.register",
  /** Passkey でのログイン検証。`reason` に `counter_regression` が入りうる（複製の兆候）。 */
  "passkey.login",
  /** Passkey の削除。 */
  "passkey.deleted",

  // --- プロフィール ---
  /** displayName / username の変更。 */
  "profile.updated",

  // --- OAuth / OIDC ---
  /** client_id から公開情報を解決した（認可画面の表示前）。 */
  "oauth.client.resolve",
  /** client_secret による認証。失敗はクライアントのなりすまし試行を意味する。 */
  "oauth.client.authenticate",
  /** 認可リクエストの受理・拒否。 */
  "oauth.authorize.decided",
  /** 認可コードの発行。 */
  "oauth.code.issued",
  /**
   * 認可コードの再使用を検出した。
   *
   * **単発でも侵害の兆候として扱うイベント。** 正常な経路では起こらず、
   * コードが漏れて第三者が先に交換した場合に出る（RFC 6749 §10.5）。
   */
  "oauth.code.replayed",
  /** 認可コードとトークンの交換。失敗を含む。 */
  "oauth.token.exchange",
  /** アクセストークン / ID Token の発行。 */
  "oauth.token.issued",
  /** トークンの失効（RFC 7009）。 */
  "oauth.token.revoked",
  /** 同意（grant）の取り消し。 */
  "oauth.grant.revoked",
  /** UserInfo の提供。どのクライアントがどの scope を読んだかを残す。 */
  "oauth.userinfo",

  // --- 運用 ---
  /** 保持期限を過ぎた行の掃除（#43）。 */
  "retention.sweep",
  /**
   * レート制限の超過（#21）。
   *
   * **このイベントだけ `audit_logs` に書かない。** 弾いたリクエスト 1 本ごとに
   * D1 へ 1 行書くと、攻撃者は「弾かれること」をそのまま D1 への書き込みに
   * 変換できる。レート制限が防ぐはずの資源枯渇を、レート制限自身が
   * 引き起こすことになる。Workers の observability へ構造化ログとして出す
   * （`presentation/http/rate-limit.ts`、ランブック §13.5）。
   *
   * 名前をここに置いているのは、**出力先が違っても同じ名前空間の
   * セキュリティイベントだから**。別に持つと、片方だけ改名する事故が起きる。
   */
  "rate_limit.exceeded",
] as const;

export type AuditEventName = (typeof AUDIT_EVENTS)[number];

/**
 * イベントごとの保持区分（#22、仕様書 7.3 / ランブック §7.2）。
 *
 * ## 分け方
 *
 * **長期側（`security`）に置くのは「アカウントの支配権が変わる操作」だけ。**
 * 遅れて始まる調査で要るのはこれで、しかも量が少ない。逆に
 * `oauth.userinfo` や `oauth.token.issued` のような**リクエストごとに
 * 1 行出るイベント**は、行数を押し上げるうえ古くなるほど価値が下がる。
 *
 * ## `Record<AuditEventName, ...>` にしてある理由
 *
 * **イベントを 1 つ足すと、ここがコンパイルエラーになる。** 区分を
 * 決めないと通らない。既定値へ黙って落ちる形（`?? "standard"`）にすると、
 * 新しい高リスクイベントが 180 日で消える状態が無言で生まれる ——
 * このリポジトリで繰り返している「宣言はあるが発動しない」と同じ形になる。
 *
 * ## 選別は event 名でしかできない
 *
 * `reason` で絞らないのは、掃除の WHERE 句がインデックス
 * （`(event, created_at)`）から外れるため。結果として
 * **「失敗だけ長く残したい」イベントは、成功も一緒に残すコスト**と
 * 引き換えになる。それが見合わないものは `standard` に置いてある。
 *
 * 具体例が `passkey.login` で、`reason: counter_regression`（認証器の
 * 複製の兆候）だけは長く残す価値があるが、成功したログインすべてを
 * 2 年持つ量には見合わない。**分けたいなら専用のイベント名を足すのが
 * 正しい**（issue #22 の本文が挙げていた `passkey.counter_regression`）。
 * 区分ではなく名前の問題なので、ここでは解かない。
 */
export const AUDIT_EVENT_RETENTION: Readonly<Record<AuditEventName, AuditRetentionTier>> = {
  // --- 支配権が変わる操作（2 年） ---
  /** 認証器を足した。乗っ取りの最も典型的な足跡。 */
  "passkey.register": "security",
  /** 認証器を外した。締め出しの手口でもある。 */
  "passkey.deleted": "security",
  /** username / displayName の変更。なりすましの足跡。 */
  "profile.updated": "security",
  /** 同意の取り消し。第三者アプリの常設アクセスが切れた時点。 */
  "oauth.grant.revoked": "security",
  /** 本人によるセッション失効。「いつ気づいたか」の起点になる。 */
  "session.revoke": "security",
  /** ログアウト（全デバイス失効を含む）。乗っ取り後の後始末か本人かを後から分ける。 */
  "session.logout": "security",
  /**
   * 認可コードの再使用。**単発でも侵害の兆候**で、正常な経路では
   * 起こらない（RFC 6749 §10.5）。量はほぼゼロなので残さない理由が無い。
   */
  "oauth.code.replayed": "security",

  // --- それ以外（180 日） ---
  /** ログインのたびに 1 行。直近の異常を見るためのもの。 */
  "session.issue": "standard",
  /** 期限切れ Cookie の提示でも出る。最も量が多い部類。 */
  "session.rejected": "standard",
  "otp.start": "standard",
  "otp.verify": "standard",
  /** 上記「選別は event 名でしかできない」を参照。 */
  "passkey.login": "standard",
  "oauth.client.resolve": "standard",
  /** 失敗はなりすまし試行だが、成功が /oauth/token のたびに出るため量が多い。 */
  "oauth.client.authenticate": "standard",
  "oauth.authorize.decided": "standard",
  "oauth.code.issued": "standard",
  "oauth.token.exchange": "standard",
  "oauth.token.issued": "standard",
  "oauth.token.revoked": "standard",
  "oauth.userinfo": "standard",
  /** 15 分おきに 1 行。掃除自身の記録を 2 年持つ理由が無い。 */
  "retention.sweep": "standard",
  /**
   * **この行は実際には使われない。** `rate_limit.exceeded` だけは
   * `audit_logs` に書かず Workers のログへ出す（#21。弾いたリクエスト
   * 1 本ごとに D1 へ書くと、レート制限自身が資源枯渇を引き起こす）。
   * `Record` が網羅を要求するので値を置いているだけで、掃除の対象に
   * この名前の行が現れることは無い。
   */
  "rate_limit.exceeded": "standard",
};

/**
 * 既定（`RetentionPolicy.audit_logs`）より長く残すイベントの境界時刻。
 *
 * **`standard` のものは入れない。** 既定の境界がそのまま使われるので、
 * 入れると同じ条件を 2 回書くことになる。
 */
export function auditEventDeadlines(now: Date): ReadonlyMap<AuditEventName, Date> {
  const deadlines = new Map<AuditEventName, Date>();
  for (const [event, tier] of Object.entries(AUDIT_EVENT_RETENTION) as [
    AuditEventName,
    AuditRetentionTier,
  ][]) {
    if (tier === "standard") continue;
    deadlines.set(event, new Date(now.getTime() - AuditRetention[tier]));
  }
  return deadlines;
}

export interface AuditEvent {
  readonly event: AuditEventName;
  readonly userId?: string | undefined;
  readonly actor?: string | undefined;
  readonly outcome: "success" | "failure";
  readonly reason?: string | undefined;
  /**
   * 追加文脈。
   *
   * **秘密を入れない**（トークン・OTP・平文メールアドレス・生 IP・
   * セッション値）。メールアドレスは `EmailAddress.masked` を使う。
   * 入っていないことは `test/audit-secrets.test.ts` が実際の行を走査して
   * 確かめている。レビューだけに頼らない。
   */
  readonly metadata?: Record<string, unknown> | undefined;
  readonly ipHash?: string | undefined;
  readonly userAgent?: string | undefined;
}

/**
 * 監査ログの Port。
 *
 * 記録の失敗で本来の処理を落とさないこと。ログが書けないからといって
 * ログインを拒否すると、可用性の問題がそのまま認証停止になる。
 */
export interface AuditLogger {
  record(event: AuditEvent): Promise<void>;
}

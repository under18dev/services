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
  /** Passkey でのログイン検証。 */
  "passkey.login",
  /**
   * WebAuthn の署名カウンタが巻き戻った。**認証器が複製された疑い**（仕様書 9 WebAuthn）。
   *
   * `passkey.login` の `reason` に畳まず**専用の名前**にしてあるのは、
   * 保持期間の選別が event 名でしかできないため（#147）。`reason` を
   * 掃除の条件に足すと `(event, created_at)` インデックスから外れる。
   *
   * これだけ 2 年残す。単発でも侵害の兆候で、件数はほぼゼロなので量に見合う。
   * 一方 `passkey.login` を長期側へ入れると、成功したログインすべてが
   * 2 年残ることになる。
   *
   * **このイベントが出たとき `passkey.login` は出ない。** 両方に出ると
   * 調査で件数が二重に見える。
   */
  "passkey.counter_regression",
  /** Passkey の削除。 */
  "passkey.deleted",

  // --- アカウント ---
  /**
   * 利用者を新規作成した。
   *
   * `users.created_at` でも作成時刻は分かるが、**証跡として追えるのは
   * `audit_logs` の側**である（保持期限・R2 への退避・調査手順がそちらに
   * 乗っている）。OTP 検証の成功経路でユーザーが生まれるのに、
   * 作成の記録がどこにも残らない状態だった（#151）。
   *
   * 既存ユーザーへのログインでは記録しない。
   */
  "user.created",
  /**
   * 運用者が凍結アカウントの個人情報を落とした（#265 / ランブック §11.6）。
   *
   * **この操作だけは元に戻せない。** 落とした `username` /
   * `display_name` / `primary_email` と `user_emails` の行は復元できない。
   * だから**行そのものではなく、ここに残る記録が「何が起きたか」の唯一の
   * 手がかり**になる（`users` の行は残るが、中身は置き換わっている）。
   */
  "user.purged",
  /**
   * 本人が退会した（#318 / ランブック §11.7）。
   *
   * **`status` では BAN と区別が付かない。** 本人の退会も不正利用者の
   * BAN も `suspended` になる —— `deleted` は「個人情報が落ちている」
   * ことを指す名前で、落とさずに立てると `purgeUserSql` の
   * `status <> 'deleted'` に弾かれ、**管理者が二度と落とせなくなる**
   * （しかも `returning` が 0 行なので「既に落とした」と区別が付かない）。
   *
   * そこで**理由はここで分ける。** 退会した人に §11.6 を回すのと、
   * BAN した相手の個人情報を残すのとでは、次にやることが逆になる。
   */
  "account.closed",

  // --- 運用者が wrangler 越しに書くもの（`ops.` 接頭辞） ---
  //
  // **アプリが書くイベントと混ざらないよう接頭辞で分けてある**
  // （ランブック §10.6）。出所が違えば信用の度合いも違う。
  /**
   * 管理権限を与えた（`scripts/admin-role.mjs`）。
   *
   * **長らく登録簿に無く、180 日で消えていた**（#270）。決定 8 が
   * 「管理者は Passkey 必須」として守ろうとしているものそのものなので、
   * 他のどの security よりも支配権が変わる。
   */
  "ops.admin.granted",
  /** 管理権限を剥がした。締め出しの手口でもある。 */
  "ops.admin.revoked",
  /**
   * 管理者が利用者を停止した（#375 / ランブック §11.1 の表）。
   *
   * **理由はここにしか無い。** `status` は `suspended` の 1 値で、
   * 「侵害の疑いによる緊急停止」「規約違反による BAN」「本人の退会」の
   * 3 つを区別しない（区別するのは `metadata.reason` とこのイベント名）。
   * §11.6 の purge の対象になるのは `deleted` だけなので、**どの理由で
   * 止めたかが後から読めないと、戻してよいのかも判断できない。**
   */
  "ops.user.suspended",
  /** 管理者が停止を解除した（#375）。 */
  "ops.user.reinstated",
  /**
   * 管理者が利用者のセッションを全部切った（#375）。
   *
   * **停止とは別の操作である。** 停止すれば次の要求から通らなくなる
   * （`GetSessionUseCase` が `isActive` を見る）が、**止めずに切りたい**
   * ことがある —— 端末を失くした人の救済や、侵害の疑いが晴れていない
   * 段階での予防。
   */
  "ops.user.sessions_revoked",
  /**
   * 管理者の旗が立ったアカウントが、**Passkey 以外で張られたセッション**で
   * 現れた（決定 8 / 脅威モデル RR-5）。権限は与えず、その事実だけを出す。
   *
   * **正常な経路では起こらない。** `IssueSessionUseCase` が管理者の
   * `email_otp` ログインを拒否するので、この状態は
   * `grantAdminSql` と `revokeNonPasskeySessionsSql` の間に張られたセッションか、
   * 2 文目が流れなかった場合にしか残らない。`oauth.code.replayed` や
   * `passkey.counter_regression` と同じ「単発でも異常」の側である。
   *
   * **`audit_logs` には書かず Workers のログへ出す**
   * （`application/use-cases/get-session.use-case.ts`）。出せるのは有効な
   * セッションを持つ管理者だけなので外から誘発できる量ではないが、
   * `getSession` はリクエストのたびに通る経路で、しかも応答時間を
   * 畳み込んである（#126）。そこへ INSERT を足さない。
   */
  "admin.session_not_passkey",
  /** displayName / username の変更。 */
  "profile.updated",
  /**
   * 管理者向けの操作を、管理者でないセッションが叩いた（#308）。
   *
   * **このイベントは `audit_logs` に書かない。** `rate_limit.exceeded` と
   * 同じ理由で、有効なセッションさえ持てば誰でも呼べる経路なので、
   * 拒否のたびに D1 へ 1 行書くと**弾くこと自体が書き込みに変換される**。
   * RPC 経路にレート制限は無く、しかも `security` 区分なら 2 年残る。
   * Workers の observability へ構造化ログとして出す
   * （`application/use-cases/admin-access.ts`、ランブック §13.5）。
   *
   * 名前をここに置いているのは、**出力先が違っても同じ名前空間の
   * セキュリティイベントだから**（`rate_limit.exceeded` と同じ扱い）。
   *
   * 応答は `not_found` に畳むので、**叩かれたことはこのログにしか
   * 現れない。** 何を登録しようとしたかは出さない（呼び出し元が決めた
   * 文字列をログへ流さないため）。
   */
  "admin.denied",

  // --- OAuth / OIDC ---
  /** client_id から公開情報を解決した（認可画面の表示前）。 */
  "oauth.client.resolve",
  /** client_secret による認証。失敗はクライアントのなりすまし試行を意味する。 */
  "oauth.client.authenticate",
  /**
   * 管理者が OAuth クライアントを登録した（#308）。
   *
   * **`ops.admin.*` と同じ「支配権が変わる操作」である。** 登録された
   * `redirect_uri` は認可コードの宛先そのもので、1 行増えるたびに
   * 「コードを受け取ってよい場所」が増える。しかも効くのは特定の利用者に
   * 対してではなく、その `client_id` で認可を通す全員に対してである。
   *
   * **この名前で行が書かれるのは、管理者まで通った呼び出しだけ**
   * （成功と、再認証切れ・不正な `redirect_uri`・重複などの失敗）。
   * 管理者でないセッションからの呼び出しは `admin.denied` として
   * Workers のログへ出し、ここには書かない —— 理由は `admin.denied`。
   */
  "oauth.client.created",
  /**
   * 管理者が OAuth クライアントを失効させた（#308）。
   *
   * 付与と同じだけ残す（`ops.admin.revoked` と同じ理由）——
   * 失効は正規のクライアントを黙って止める手口でもある。
   */
  "oauth.client.disabled",
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
  /**
   * form の CSRF 検証に落ちた。**`audit_logs` には書かず Workers のログへ出す**
   * （`presentation/http/ui/csrf.ts`）。`rate_limit.exceeded` と同じ理由で、
   * 弾いたリクエスト 1 本ごとに D1 へ書くと攻撃者が書き込みを誘発できる。
   *
   * 画面には理由を出さない（出し分けると何を直せばよいか教えることになる）。
   * **ログに出ないと調べようがない** —— 本番で「どのメールアドレスを入れても
   * 操作を受け付けられない」という報告が出たとき、`wrangler tail` で生の
   * ヘッダを見るまで `Origin: null` だと分からなかった。
   */
  "csrf.rejected",
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
  /**
   * アカウントの新規作成。**支配権が発生した瞬間**で、この系列の起点になる。
   *
   * 消えると「このアカウントはいつ誰が作ったか」を後から追えなくなり、
   * 他のイベントを 2 年持つ意味も半減する。量は利用者数と同じで、
   * リクエストごとに増えるものではない。
   */
  "user.created": "security",
  /**
   * 個人情報を落とした。**支配権が変わるどころか、戻せない。**
   *
   * 2 年では短いかもしれないが、区分を増やすほどの根拠がまだ無い。
   * R2 への退避（730 日）と合わせて約 4 年になる（決定 14）。
   */
  "user.purged": "security",
  /**
   * 本人の退会。**アカウントの支配権が変わる操作**で、しかもこれが
   * 「個人情報を落としてよい」の起点になる（§11.6）。
   */
  "account.closed": "security",
  /** 管理権限の付与。**アカウントの支配権が変わる操作そのもの**（#270）。 */
  "ops.admin.granted": "security",
  /** 剥奪。締め出しの手口でもあるので、付与と同じだけ残す。 */
  "ops.admin.revoked": "security",
  /**
   * **支配権が変わる操作なので長期側。** しかも `ops.user.suspended` は
   * **理由の唯一の保存先**である（`status` は 1 値しか持たない）。
   * 180 日で消えると、「なぜ止まっているのか」が誰にも分からない
   * アカウントが残る。
   */
  "ops.user.suspended": "security",
  /** 付与と剥奪を同じだけ残すのと同じ理由（`ops.admin.revoked`）。 */
  "ops.user.reinstated": "security",
  /**
   * **管理者しか起こせないので件数が頭打ちになる。** 外から誘発できる
   * `admin.denied` と違い、`audit_logs` を伸ばす経路にならない。
   */
  "ops.user.sessions_revoked": "security",
  /** 認証器を足した。乗っ取りの最も典型的な足跡。 */
  "passkey.register": "security",
  /** 認証器を外した。締め出しの手口でもある。 */
  "passkey.deleted": "security",
  /** username / displayName の変更。なりすましの足跡。 */
  "profile.updated": "security",
  /** 同意の取り消し。第三者アプリの常設アクセスが切れた時点。 */
  "oauth.grant.revoked": "security",
  /**
   * OAuth クライアントの登録（#308）。**認可コードの宛先が増えた記録**で、
   * `ops.admin.granted` と同じく支配権が変わる操作にあたる。
   *
   * **量は管理者の操作回数で頭打ちになる。** 管理者でない呼び出しは
   * ここに来ない（`admin.denied` として Workers のログへ出る）ので、
   * 「弾いた回数ぶん行が増える」形にはならない。
   */
  "oauth.client.created": "security",
  /** 失効。正規のクライアントを止める手口でもあるので、登録と同じだけ残す。 */
  "oauth.client.disabled": "security",
  /** 本人によるセッション失効。「いつ気づいたか」の起点になる。 */
  "session.revoke": "security",
  /** ログアウト（全デバイス失効を含む）。乗っ取り後の後始末か本人かを後から分ける。 */
  "session.logout": "security",
  /**
   * 認可コードの再使用。**単発でも侵害の兆候**で、正常な経路では
   * 起こらない（RFC 6749 §10.5）。量はほぼゼロなので残さない理由が無い。
   */
  "oauth.code.replayed": "security",
  /**
   * 署名カウンタの巻き戻し。**認証器の複製の兆候**で、`oauth.code.replayed` と
   * 同じ性質 —— 正常な経路では起こらず、量はほぼゼロ（#147）。
   */
  "passkey.counter_regression": "security",

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
  /**
   * `rate_limit.exceeded` と同じく**この行は実際には使われない**（ログへ出す
   * だけで `audit_logs` に行が現れない）。`Record` の網羅のために置いている。
   */
  "csrf.rejected": "standard",
  /**
   * これも**使われない行**。`admin.session_not_passkey` は Workers のログへ
   * 出すだけで `audit_logs` に現れない（決定 8 / RR-5）。`Record` の網羅の
   * ために置いている。
   *
   * 仮に書くことにしたら `security` に入れる —— 件数はほぼゼロで、
   * 「管理者の前提が崩れていた期間」は後から遡りたい種類の情報だからである。
   * ここが `standard` なのは**出力先の話であって重要度の話ではない。**
   *
   * **ここには「次を足すときは、区分を `"not_persisted"` のような値で
   * 表せないかを先に考えること」と書いてあった。その次がすぐ下の
   * `admin.denied` で、4 行目になる**（`rate_limit.exceeded` /
   * `csrf.rejected` / これ / `admin.denied`）。`Record` の網羅が要求する
   * ので値を置いているが、**置いた値が意味を持たない行が増えていく形**が
   * そのまま続いている。
   *
   * 直すべきなのは型のほうで、いまは「掃除の対象になる期間」と
   * 「そもそも掃除の対象でない」が同じ型で書かれている。**この PR では
   * 直さない** —— ここで型を変えると、この PR が触っていない監査イベント
   * 全部の分類を道連れにする。別で出す。
   */
  "admin.session_not_passkey": "standard",
  /**
   * こちらも**実際には使われない行**。`admin.denied` は `audit_logs` に
   * 書かず Workers のログへ出す（#308）。`Record` の網羅のために置いている。
   *
   * 仮に書くことにしたとしても `security` には入れない —— 外から誘発できる
   * イベントを 2 年側へ置くと、掃除が効かないまま行が伸びる。
   */
  "admin.denied": "standard",
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

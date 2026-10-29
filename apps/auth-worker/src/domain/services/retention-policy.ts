/**
 * 保持期限（仕様書 7.3「データ保持・削除ポリシー」/ 9 Privacy、#43）。
 *
 * `token-lifetime.ts` が「いつまで使えるか」の単一の出典であるのに対し、
 * ここは「使えなくなってから、いつまで行を残すか」の単一の出典である。
 * 2 つは別の判断なので定数も分けてある。有効期限を延ばしても保持期間は
 * 自動では変わらないし、逆も同じ。
 */

/** 掃除の対象テーブル。D1 の物理名をそのまま使う（ログと SQL を突き合わせやすくするため）。 */
export type RetentionTarget =
  | "sessions"
  | "oauth_authorization_codes"
  | "oauth_tokens"
  | "email_challenges"
  | "webauthn_challenges"
  | "audit_logs";

/**
 * `audit_logs` の保持区分（#22、ランブック §7.2）。
 *
 * ## なぜ 2 つに分けるのか
 *
 * 一律 180 日だと、**アカウントの支配権が変わった操作の記録が、
 * 侵害が発覚するより先に消える。** 「攻撃者がいつ自分の認証器を
 * 足したのか」は、半年以上経ってから訊かれる質問である。
 *
 * かといって全部 2 年残すのは割に合わない。`audit_logs` の行数を
 * 押し上げているのは `oauth.userinfo` や `oauth.token.issued` のような
 * **リクエストごとに 1 行出るイベント**で、これらは古くなるほど価値が
 * 下がる（直近の異常を見るためのもので、2 年前の UserInfo 取得を
 * 遡る理由が無い）。
 *
 * そこで **「支配権が変わる操作」だけ**を長期側に置く。量が少なく、
 * 遅れて始まる調査でこそ要るものである。どのイベントがどちらかは
 * `AUDIT_EVENT_RETENTION`（`application/ports/audit-log.port.ts`）が持つ。
 * 登録簿の隣に置いてあるので、**イベントを足すと区分の判断を迫られる**。
 */
export type AuditRetentionTier = "standard" | "security";

export const AuditRetention: Readonly<Record<AuditRetentionTier, number>> = {
  /** 180 日。既定。 */
  standard: 180 * 24 * 60 * 60 * 1000,
  /**
   * 2 年。
   *
   * 下限の根拠は「侵害の発覚が遅れる幅」。報告される侵害の滞留時間は
   * 数か月規模になることがあり、180 日では**調査を始めた時点で
   * 既に消えている**ことが起こりうる。2 年あれば、発覚が 1 年遅れても
   * その前後を見られる。
   *
   * 上限側の歯止めは D1 の容量と、保持そのものがリスクである
   * という点（消さないデータは漏れうる）。長期側に入れるイベントを
   * **量の少ないものに限る**ことでこの 2 つを両立させている。
   */
  security: 2 * 365 * 24 * 60 * 60 * 1000,
};

/**
 * 「用済みになってから」この時間が経った行を消してよい。
 *
 * 起点は作成時刻ではなく **行が使えなくなった時刻**（期限切れ / 失効 / 消費、
 * `email_challenges` は最終送信も含む）。作成時刻を起点にすると、
 * 期限が延びたときに「まだ生きている行」を消しかねない。
 */
export const RetentionPolicy: Readonly<Record<RetentionTarget, number>> = {
  /**
   * 30 日。
   *
   * ランブック §7.2 の方針（「期限切れ後 30 日」）に合わせる。セッション一覧 UI の
   * 履歴表示と、侵害調査で「いつどこから入られたか」を遡るために要る。
   * D1 の Time Travel が 30 日なので、復旧窓とも揃う。
   */
  sessions: 30 * 24 * 60 * 60 * 1000,

  /**
   * 24 時間。
   *
   * コード自体の寿命は 60 秒しかないが、消費済みの行は
   * 「同じコードが 2 回来た（= リプレイ）」を判定する材料になる。
   * 事後の照合に使える程度の余裕として 1 日だけ残す。
   */
  oauth_authorization_codes: 24 * 60 * 60 * 1000,

  /**
   * 30 日。`sessions` と揃える。
   *
   * アクセストークンの寿命は 10 分（`TokenLifetime.accessTokenMs`）なので、
   * 行としての用は 10 分で終わる。それでも 30 日残すのは、
   * **失効したトークンが後から提示されたか**を調べる窓としてである
   * （`oauth_authorization_codes` を 1 日残すのと同じ理由だが、
   * あちらは単回消費のリプレイ判定で、こちらは失効後の再提示）。
   *
   * 行を消すと、再提示されたトークンは「失効済み」ではなく
   * **「知らないトークン」**として扱われる。どちらも拒否はするが、
   * 調査のときに意味が違う —— 前者は「漏れた後に使われた」証拠になる。
   *
   * **これより長くする理由は薄い。** 発行と失効の事実は監査ログに残り
   * （`oauth.token.issued` / `oauth.token.revoked`、`standard` = 180 日）、
   * 行のほうは `user_id` を持つので「誰がいつどのアプリを使ったか」が
   * そのまま積まれる。残す価値より、持ち続けるリスクのほうが先に増える。
   *
   * **`oauth_grants` は掃除しない。** あちらは期限を持たず、「この利用者が
   * このアプリに同意している」という**継続中の状態そのもの**である。
   * 期限切れという概念が無いものを保持期間で消すと、同意が黙って外れる。
   */
  oauth_tokens: 30 * 24 * 60 * 60 * 1000,

  /**
   * 1 時間。**6 つの中で最も短い。**
   *
   * このテーブルだけメールアドレスを平文で持つ（`email_challenges.email`）。
   * ログインを試みただけのアドレス——登録すらしていないアドレスを含む——が
   * 溜まり続けるので、未成年利用者を想定する以上ここは短くする（仕様書 9 Privacy）。
   *
   * ただし **`OtpPolicy.resendWindowMs` より短くできない。** 再送上限は
   * 「窓の中に何行作られたか」で判定するので（#88、`StartEmailOtpUseCase`）、
   * 掃除で消えた行は数えられない。保持期間を窓より短くすると、待つだけで
   * 上限を回り込める。現在はどちらも 1 時間で**余裕がゼロ**。短くするなら
   * 窓を先に短くすること。`test/otp-resend-limit.test.ts` が両者の関係を
   * 不変条件として固定している。
   *
   * クールダウン判定（`OtpPolicy.resendCooldownMs` = 60 秒）も `last_sent_at` を
   * 読むので、消費済みの行を即座に消すと「コードを使う → 行が消える →
   * 送信履歴が無くなる」で同じく回り込める。1 時間はクールダウン窓の 60 倍、
   * OTP の有効期限（5 分）の 12 倍で、どちらの窓も確実に跨ぐ。
   */
  email_challenges: 60 * 60 * 1000,

  /**
   * 24 時間。
   *
   * challenge はランダム値で個人情報を含まないが、単回消費なので消費後の
   * 有用性は無い。Passkey の登録・ログイン失敗を当日中に調べられる程度に
   * 残して、それ以降は消す。
   */
  webauthn_challenges: 24 * 60 * 60 * 1000,

  /**
   * 180 日（`AuditRetention.standard`）。
   *
   * ランブック §7.2 の推奨値。インシデントの発覚は遅れるので、直近半年を
   * 遡れる必要がある。
   *
   * **ただしイベントによってはこれより長く残す（#22）。** 区分は
   * `AuditRetention` と、`application/ports/audit-log.port.ts` の
   * `AUDIT_EVENT_RETENTION` が決める。ここはその既定値である。
   */
  audit_logs: AuditRetention.standard,
} as const;

/**
 * 1 回の掃除で 1 テーブルから消す行数の上限。
 *
 * D1 は 1 ステートメントあたりの実行時間に上限があり、溜まった数百万行を
 * 1 回の `delete` で消そうとすると途中で落ちる。落ちた分は 1 行も消えないので、
 * 「溜まっているほど掃除が失敗する」という最悪の挙動になる。
 *
 * そこで必ず `limit` を付け、上限に達したら残りは次回に持ち越す。
 * 15 分おきの Cron（`wrangler.jsonc` の `triggers.crons`）で回すので、
 * 1 テーブルあたり 1 時間で 4,000 行、1 日で 96,000 行を処理できる。
 * 想定する利用規模では流入量がこれを超えないため、バックログは必ず縮む。
 * 超えるようになったら、この値ではなく Cron の間隔を先に詰めること
 * （1 回あたりの削除量を増やすより、D1 の実行時間上限から遠いままでいられる）。
 */
export const RETENTION_SWEEP_LIMIT = 1_000;

/** 保持期限を過ぎた行の境界時刻。これより前に用済みになった行が削除対象。 */
export const retentionCutoff = (now: Date, target: RetentionTarget): Date =>
  new Date(now.getTime() - RetentionPolicy[target]);

/**
 * 消す前に別ストレージへ退避するテーブル（#43 の残件）。
 *
 * ## `audit_logs` だけを退避する
 *
 * 180 日を過ぎた監査ログは、消してよいから消しているのではなく、
 * **D1 に置き続けるコストが見合わないから消している**。侵害の発覚が
 * 1 年遅れることはあるので、戻せる場所に置いておく価値がある。
 *
 * ## 残り 5 つを退避しない理由
 *
 * **これらは「消してよいから消している」のではなく、「消さなければ
 * ならないから消している」。** 退避すると、消したはずの個人情報が
 * 別の場所に残る。
 *
 * - `email_challenges` —— **6 つの中で唯一メールアドレスを平文で持つ。**
 *   登録すらしていないアドレスが溜まるので 1 時間という最短の保持期間に
 *   してある（上記）。それを R2 へ写したら、保持期間を 1 時間にした判断が
 *   丸ごと無意味になる。
 * - `sessions` —— `ip_hash` と `user_agent` を持つ。pepper が同じうちは
 *   ハッシュから同一人物を追跡できる。追跡に使える情報の保持期間を
 *   延ばす判断は、#27 の `ip_hash` 保持期間の議論（ランブック 7.3）と
 *   セットで決めるべきもので、掃除の実装で勝手に延ばしてよくない。
 * - `oauth_authorization_codes` / `webauthn_challenges` —— どちらも
 *   単回消費のランダム値で、期限を過ぎた行に情報価値が無い。
 *   退避しても誰も読まない。
 *
 * **足すときは「なぜ残してよいか」を書くこと。** 「念のため」で足すと、
 * 消す仕組みを作った意味が無くなる。
 */
export const ARCHIVED_TARGETS: readonly RetentionTarget[] = ["audit_logs"];

export const isArchivedTarget = (target: RetentionTarget): boolean =>
  ARCHIVED_TARGETS.includes(target);

/**
 * **掃除しないテーブルと、その理由**（#301）。
 *
 * `RetentionPolicy` が「いつ消すか」の出典であるのに対し、ここは
 * **「消さないと決めた」こと自体の出典**である。値は人が読むための理由で、
 * 機械は使わない —— 機械が使うのは**キーが揃っていること**のほうである。
 *
 * ## なぜ「書かないこと」を書くのか
 *
 * #279 で「`expires_at` を持つテーブルは保持期間が決まっていなければ
 * ならない」をスキーマ側から数える検査にした。ところがこれは、
 * **列が `expires_at` という名前のときしか何も訊かない。** 期限列を持たない
 * テーブルを足した人は、保持期間について一言も問われずに済む。
 * `oauth_grants` がまさにそれで、「掃除しない」は散文のコメントにしか
 * 無かった —— 読めば正しいが、**機械からは「判断済み」と「まだ誰も
 * 考えていない」が同じ形に見える。**
 *
 * そこで `RetentionPolicy` と合わせて**スキーマの全テーブルをちょうど
 * 1 回ずつ覆う**ことにし、分類されていないテーブルがあればテストを落とす
 * （`retentionClassificationGaps`）。新しいテーブルは**分類するまで CI が
 * 通らない。**
 *
 * ## これで防げないこと
 *
 * **分類を間違えることは防げない。** `users` をうっかり `RetentionPolicy`
 * 側に書いた人も、ここに書いた人も、「1 箇所に書いた」ことには変わりない。
 * 防げるのは**分類を忘れること**だけである。
 *
 * 掃除対象へ移すときに**理由の 1 行が差分から消える**のは副産物だが、
 * レビューの当たる面としてはこちらのほうが効く。
 *
 * ## ここに入れれば `expires_at` の検査を回り込める、わけではない
 *
 * **期限列を持つテーブルはここに置けない。** 置けてしまうと、#279 の検査は
 * 「分類済みだから良し」で黙り、**検査を回り込む抜け道をこの定数が作る**
 * ことになる。`retentionClassificationGaps` が別建てで弾く。
 */
export const NEVER_SWEPT: Readonly<Record<string, string>> = {
  /**
   * アカウントは物理削除せず凍結で表現する（仕様書 14.1 決定 7）。
   * 退会済みの行を消すかどうかは保持期間ではなく**退会の扱い**の話で、
   * #27 / #51 の範囲。`last_active_at` は 1 年を越えて残ることが役割
   * （#286 / #297）なので、ここが掃除されると判定材料ごと消える。
   */
  users: "凍結で表現するので物理削除しない（仕様書 14.1 決定 7）",

  /** `users` と同じ寿命。メールアドレスは本人の識別子そのもので、期限が無い。 */
  user_emails: "利用者の識別子。users と同じ寿命",

  /**
   * 認証器そのもの。消すと**本人がログインできなくなる。**
   * 削除は利用者の操作（`DeletePasskeyUseCase`）だけが行う。
   */
  passkeys: "消すと本人がログインできなくなる。削除は利用者の操作だけ",

  /** RP の登録情報。運用で入れたものを時間で消す意味が無い。 */
  oauth_clients: "RP の登録情報。運用が消すまで有効",
  oauth_redirect_uris: "RP の登録情報。oauth_clients と同じ寿命",

  /**
   * **期限を持たない継続中の状態。** 「この利用者がこのアプリに同意して
   * いる」という事実そのものなので、保持期間で消すと**同意が黙って外れる。**
   * 取り消しは `revoked_at` で表す。
   */
  oauth_grants: "継続中の同意そのもの。期限で消すと同意が黙って外れる",

  /**
   * **`retires_at` を持つが掃除しない。**（列名が `expires_at` でないため
   * #279 の検査は見ていなかった。#301 で明示する。）
   *
   * 退役した鍵の `kid` と公開鍵は、**過去に発行したトークンがどの鍵で
   * 署名されたかを後から言える**ために残す。行は 1 鍵につき 1 行で、
   * ローテーションの頻度ぶんしか増えない —— 消して得られる容量より、
   * 「この kid は確かに自分たちの鍵だった」と言えることのほうが価値が高い。
   */
  signing_key_metadata: "退役した鍵も kid の出所を後から言うために残す（行数は鍵の本数ぶん）",
};

/** 分類の穴。すべて空であることをテストが固定する（#301）。 */
export interface RetentionClassificationGaps {
  /** どちらにも書かれていないテーブル。**新しいテーブルはまずここに出る。** */
  readonly unclassified: readonly string[];
  /** 両方に書かれているテーブル。どちらの意図なのか読めない。 */
  readonly classifiedTwice: readonly string[];
  /** 期限列を持つのに「掃除しない」側にあるテーブル（#279 の回り込み）。 */
  readonly expiringButNotSwept: readonly string[];
  /** 分類に名前はあるが、スキーマに実在しないテーブル。 */
  readonly unknownTables: readonly string[];
}

/** 分類そのもの。既定は `RetentionPolicy` と `NEVER_SWEPT`。 */
export interface RetentionClassification {
  readonly swept: readonly string[];
  readonly kept: readonly string[];
}

/**
 * スキーマのテーブル一覧を受け取り、分類の穴を返す（#301）。
 *
 * **スキーマも分類も自分で読みに行かない。** どちらも引数で受け取るのは、
 * テストから**作り物**を渡して**この規則自体**を確かめられるようにする
 * ためである。実物だけを相手にすると、規則が空振りしていても
 * 「穴はありません」としか出てこない —— 検査を足した直後がいちばん
 * 危ないのはこれで、このリポジトリで何度か踏んでいる。
 *
 * 既定の引数は実物なので、呼ぶ側は何も渡さなくてよい。
 */
export const retentionClassificationGaps = (
  tables: readonly { readonly name: string; readonly hasExpiry: boolean }[],
  classification: RetentionClassification = {
    swept: Object.keys(RetentionPolicy),
    kept: Object.keys(NEVER_SWEPT),
  },
): RetentionClassificationGaps => {
  const { swept, kept } = classification;
  const names = tables.map((table) => table.name);

  return {
    unclassified: names.filter((name) => !swept.includes(name) && !kept.includes(name)),
    classifiedTwice: names.filter((name) => swept.includes(name) && kept.includes(name)),
    expiringButNotSwept: tables
      .filter((table) => table.hasExpiry && kept.includes(table.name))
      .map((table) => table.name),
    unknownTables: [...swept, ...kept].filter((name) => !names.includes(name)),
  };
};

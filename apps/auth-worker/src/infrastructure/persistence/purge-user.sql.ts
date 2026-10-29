import type { AuditEventName } from "../../application/ports/audit-log.port";

/**
 * SQL の文字列リテラルへ逃がす。
 *
 * **`admin-role.sql.ts` にある同名の関数と同じ実装である。** import せずに
 * 置いてあるのは、この 2 つのモジュールが**運用 CLI から Node の型ストリップ
 * で直接読み込まれる**ため。型ストリップは拡張子なしの相対 import を解決
 * できず、`./admin-role.sql` が `ERR_MODULE_NOT_FOUND` になる。
 *
 * 3 行の重複と引き換えに、**CLI とテストが同じ文を使う**という性質を保つ
 * （そちらが崩れると、テストが検証している文と運用が流す文が別物になる）。
 */
function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/**
 * 凍結アカウントから個人情報を落とす SQL（#265 / ランブック §11.6）。
 *
 * ## 誰が何のために実行するのか
 *
 * **運用者が手で実行する。自動では走らない。** 2026-10-28 の方針決定
 * 「管理者が任意で削除できるようにしながらも、一応その操作があるまでは残す」
 * に対応する。時間では落とさない。
 *
 * ## `suspended` と `deleted` を使い分ける
 *
 * | status | 何のため | 個人情報 | 同じアドレスでの再登録 |
 * | --- | --- | --- | --- |
 * | `suspended` | 不正利用者の BAN | **保持する** | **不可**（`primary_email` が残り一意制約で弾かれる） |
 * | `deleted` | 削除要求に応じた | **落とす** | **可** |
 *
 * **仕様書 §14.1 決定 7 の「不正利用者の再登録防止」は `suspended` が担う。**
 * 削除要求に応じた相手に再登録を許すのは筋が通っている —— 消したと言った
 * のだから、同じアドレスで作り直せないほうがおかしい。
 *
 * **この使い分けは、ここに書くまでコードのどこにも無かった。** `status` の
 * enum に 3 つ並んでいるだけで、どれをいつ使うかは決まっていなかった。
 *
 * ## 何を落として、何を残すか
 *
 * 落とす: `username` / `display_name` / `primary_email` / `user_emails` の行。
 *
 * **残す: `audit_logs`。** `user_id` は外部キーではない `text` 列で、
 * ユーザーを消しても証跡が残るよう意図的にそうしてある
 * （`packages/db/src/schema/audit.ts`）。§11.6 が「削除要求への対応と
 * セキュリティ証跡の保全は正面から衝突する」と書いているところで、
 * **ここでは証跡を取る。** `ip_hash` と `user_agent` も同じ行にあるので、
 * 落とすなら別の判断が要る。
 *
 * ## 落とすのであって、行は消さない
 *
 * `delete from users` にしない理由は決定 7 のとおり —— 監査ログとの整合と
 * 誤削除からの復旧。**行を残したまま中身だけ置き換える**ので、
 * `audit_logs.user_id` から辿ったときに「このアカウントは削除された」と
 * 読める（辿れなくなるのではない）。
 */

/** epoch ミリ秒。アプリ側（Drizzle の `timestampMs`）と単位を揃える。 */
const NOW_MS = "unixepoch() * 1000";

/**
 * 監査に残すイベント名。
 *
 * **オブジェクトのプロパティとして書いてある理由がある。**
 * `vitest.config.ts` の `collectAuditEventNames` が `src/` を走査して
 * イベント名を拾い、`test/audit-events.test.ts` が登録簿（`AUDIT_EVENTS`）と
 * 突き合わせる。走査が見ているのは**プロパティとして書かれた形**なので、
 * SQL の中に文字列として埋めるだけでは引っかからない。
 * 登録簿にあるのに発行されていない名前として落ちるので、ここで形を揃える。
 *
 * **このコメント自体が一度その走査を誤作動させた。** 説明のために書いた
 * 例が走査の正規表現に一致してしまい、「登録簿に無い名前が発行されている」
 * と報告された。**検査の仕組みを説明する文が、その検査に拾われる** ——
 * 散文と対象を同じ面で見分けている限り避けられない形で、
 * `collectAuditEventNames` が行コメント（`//`）だけを除いて JSDoc を
 * 除いていないのもそのためである。
 *
 * `satisfies` で型も縛っているので、登録簿から消えればここで止まる。
 *
 * **`admin-role.sql.ts` の `ops.admin.*` はこの形になっておらず、登録簿にも
 * 無い。** つまり保持区分が付かず 180 日で消える。別の論点として残っている。
 */
const PURGE_EVENT = { event: "user.purged" } as const satisfies { event: AuditEventName };

/**
 * トゥームストーンのメールアドレス。
 *
 * **`primary_email` は `notNull` かつ一意**なので、空にできない。
 * `.invalid` は RFC 2606 が「決して解決しない」と予約している TLD で、
 * **間違って送信経路に載っても誰にも届かない。**
 *
 * `user_id` を含めるのは一意性のため。削除したアカウントが 2 つあっても
 * ぶつからない。
 */
export function tombstoneEmail(userId: string): string {
  return `deleted+${userId}@invalid`;
}

/** トゥームストーンの `username`。表示名と違い一意なので ID を含める。 */
export function tombstoneUsername(userId: string): string {
  return `deleted_${userId}`;
}

/** 落としたあとの表示名。**利用者ごとに変えない** —— 変えると中身が残る。 */
export const TOMBSTONE_DISPLAY_NAME = "削除済みのアカウント";

/**
 * 個人情報を落とし、`deleted` にする。
 *
 * **`returning` で適用された行だけを返す。** 呼び出し側は「0 行なら落として
 * いない」で判断でき、別の SELECT で確かめ直す必要がない（確かめ直す形に
 * すると、その SELECT と UPDATE の間でまた状態が変わりうる）。
 *
 * **既に `deleted` の行には当たらない。** 二度目の実行で `updated_at` と
 * `deleted_at` だけが進むのを避ける —— 実行した記録は `audit_logs` に残る
 * ので、行のほうを塗り替える意味が無い。
 */
export function purgeUserSql(userId: string): string {
  const id = sqlLiteral(userId);
  return `update users
   set username = ${sqlLiteral(tombstoneUsername(userId))},
       display_name = ${sqlLiteral(TOMBSTONE_DISPLAY_NAME)},
       primary_email = ${sqlLiteral(tombstoneEmail(userId))},
       email_verified = 0,
       status = 'deleted',
       is_admin = 0,
       deleted_at = coalesce(deleted_at, ${NOW_MS}),
       updated_at = ${NOW_MS}
 where id = ${id}
   and status <> 'deleted'
returning id, username, status;`;
}

/**
 * メールアドレスの台帳を消す。
 *
 * **`users` の行とは違って、こちらは消す。** `user_emails` は「どのアドレスが、
 * いつ確認されたか」の台帳で（`packages/db/src/schema/users.ts`）、
 * **アドレスそのものが中身である。** トゥームストーン化しても意味が無い。
 */
export function deleteUserEmailsSql(userId: string): string {
  return `delete from user_emails where user_id = ${sqlLiteral(userId)};`;
}

/**
 * ログインの手段と、発行済みの権限をすべて断つ。
 *
 * **順序に意味は無いが、1 つでも欠けると「消したはずのアカウントで何かが
 * 動く」状態が残る。** セッションは失効印、パスキーとトークンと同意は行ごと。
 *
 * `oauth_grants` を消すのは、同意の記録が「このアカウントがこのアプリを
 * 使っていた」ことを示すためで、**RP 側に残る情報まではここでは触れない。**
 */
export function revokeEverythingSql(userId: string): readonly string[] {
  const id = sqlLiteral(userId);
  return [
    `update sessions set revoked_at = coalesce(revoked_at, ${NOW_MS}) where user_id = ${id};`,
    `delete from passkeys where user_id = ${id};`,
    `delete from oauth_tokens where user_id = ${id};`,
    `delete from oauth_grants where user_id = ${id};`,
    `delete from oauth_authorization_codes where user_id = ${id};`,
  ];
}

/**
 * 実行した事実を監査に残す。
 *
 * **保持区分は `security`。** アカウントの支配権が変わる操作であり、
 * しかも**この操作だけは元に戻せない**（落とした個人情報は復元できない）。
 *
 * `actor` は実行した人の識別子。**メールアドレスや本名を入れないこと**
 * （`audit-log.port.ts` と同じ約束）。GitHub のハンドルやチケット番号で足りる。
 */
export function purgeUserAuditSql(input: {
  readonly userId: string;
  readonly actor: string;
  readonly reason: string;
}): string {
  return `insert into audit_logs (id, event, user_id, actor, outcome, reason, metadata, created_at)
values (
  'aud_' || lower(hex(randomblob(16))),
  ${sqlLiteral(PURGE_EVENT.event)},
  ${sqlLiteral(input.userId)},
  ${sqlLiteral(input.actor)},
  'success',
  ${sqlLiteral(input.reason)},
  json_object('source', 'scripts/purge-user.mjs'),
  ${NOW_MS}
);`;
}

/**
 * 実行前後に状態を確かめるための SELECT。
 *
 * 運用者が「本当にこのアカウントでよいか」を自分の目で見るためのもので、
 * 判定には使わない（判定は UPDATE の WHERE が単独で行う）。
 *
 * **メールアドレスをそのまま返す。** 落とす前に本人確認の材料として要る。
 * 落としたあとは `deleted+...@invalid` が返るので、**成否がそのまま読める。**
 */
export function purgeStatusSql(userId: string): string {
  const id = sqlLiteral(userId);
  return `select u.id, u.username, u.display_name, u.primary_email, u.status,
       (u.deleted_at is not null) as is_deleted,
       (select count(*) from user_emails e where e.user_id = u.id) as emails,
       (select count(*) from passkeys p where p.user_id = u.id) as passkeys,
       (select count(*) from sessions s
         where s.user_id = u.id and s.revoked_at is null) as live_sessions,
       (select count(*) from oauth_grants g where g.user_id = u.id) as grants
  from users u
 where u.id = ${id};`;
}

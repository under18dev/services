/**
 * 管理権限の付与・剥奪に使う SQL 文（仕様書 §14.1 決定 8 / #83 / #40）。
 *
 * **なぜ Repository のメソッドではなく SQL の文字列なのか。**
 * 付与・剥奪に公開 UI も API も作らない（#13 の `oauth-client.mjs` と同じ方針）。
 * 唯一の実行経路は運用者の手元で動く `scripts/admin-role.mjs` で、それは Worker の
 * 中ではなく `wrangler d1 execute` 越しに DB を触る。つまり Repository を足しても
 * **誰も呼ばない実装がもう 1 つ増えるだけ**で、実際に流れる SQL は検証されない。
 * そこで「実際に流れる文」そのものをここへ出し、CLI とテストの両方が同じ文字列を
 * 使う形にした。`test/admin-role.test.ts` はこの関数が返す文を実物の D1 に流す。
 *
 * **判定条件を文の中に入れてあることが肝心。**
 * 「Passkey があるか確かめてから UPDATE する」と 2 文に分けると、その隙間に
 * 最後の Passkey が削除されうる（TOCTOU）。`exists (...)` を UPDATE の WHERE に
 * 畳んでおけば、権限が立つ瞬間と Passkey が在る瞬間が同じになる。
 */

/**
 * SQL リテラルへ落とす。
 *
 * 値は運用者の手元からしか来ないが、だからといってそのまま埋めない。
 * ユーザー ID はサポート窓口のチケットや他システムの出力から貼られるもので、
 * `'` を含む文字列を渡されたときに**文が壊れるのではなく意味が変わる**のが
 * SQL 注入である。ここは CLI とテストが共有する唯一の入口なので、
 * 逃がす処理もここに 1 つだけ置く。
 */
export function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/** epoch ミリ秒。アプリ側（Drizzle の `timestampMs`）と単位を揃える。 */
const NOW_MS = "unixepoch() * 1000";

/**
 * 管理権限を与える。**Passkey が 1 本も無いアカウントには立たない。**
 *
 * 条件を外すと、生まれるのは次のどちらかである。
 *
 *  - ログインできない管理者（決定 8 により OTP が塞がれているため）
 *  - OTP で入れる管理者（決定 8 を緩めて救済した場合）
 *
 * どちらも #40 が排除したかった状態なので、**付与の時点**で弾く。
 * 凍結・削除済みのアカウントにも与えない。凍結を解除した瞬間に管理者が
 * 復活する形は、凍結の意味を弱める（仕様書 §14.1 決定 7）。
 *
 * 適用された行だけを `returning` で返す。呼び出し側は「0 行なら与えていない」で
 * 判断でき、別の SELECT で確かめ直す必要がない（確かめ直す形にすると、
 * その SELECT と UPDATE の間でまた状態が変わりうる）。
 */
export function grantAdminSql(userId: string): string {
  const id = sqlLiteral(userId);
  return `update users
   set is_admin = 1, updated_at = ${NOW_MS}
 where id = ${id}
   and is_admin = 0
   and status = 'active'
   and deleted_at is null
   and exists (select 1 from passkeys p where p.user_id = users.id)
returning id;`;
}

/**
 * 管理権限を外す。
 *
 * 付与と違って前提条件を置かない。**権限を減らす操作は常に通ること。**
 * 凍結済みかどうか、Passkey が何本あるかを条件にすると、「今すぐ権限を
 * 落としたいのに条件を満たさなくて落とせない」状況が作れてしまう。
 */
export function revokeAdminSql(userId: string): string {
  const id = sqlLiteral(userId);
  return `update users
   set is_admin = 0, updated_at = ${NOW_MS}
 where id = ${id}
   and is_admin = 1
returning id;`;
}

/**
 * Passkey 以外で確立済みの生きたセッションを失効させる。付与と同時に流す。
 *
 * 付与より前に張られた OTP セッションは、権限が立った瞬間に「OTP で入った
 * 管理者セッション」になる。`IssueSessionUseCase` が止められるのは新規発行
 * だけなので、既存の分はここで落とす。これを忘れると、決定 8 を強制した
 * つもりで最大 12 時間（`TokenLifetime.sessionMs`）穴が開いたままになる。
 */
export function revokeNonPasskeySessionsSql(userId: string): string {
  const id = sqlLiteral(userId);
  return `update sessions
   set revoked_at = ${NOW_MS}
 where user_id = ${id}
   and auth_method <> 'passkey'
   and revoked_at is null
   and expires_at > ${NOW_MS}
returning id;`;
}

export type AdminRoleAuditEvent = "ops.admin.granted" | "ops.admin.revoked";

/**
 * 付与・剥奪を監査ログに残す（仕様書 §9 / runbook §10.6）。
 *
 * `wrangler d1 execute` は `audit_logs` に何も書かない。アプリの外で権限が
 * 動いた事実は、運用者がこの文を流さない限りどこにも残らない。CLI は
 * 権限の変更が**実際に適用されたときだけ**これを流す。
 *
 * イベント名に `ops.` を付けるのは、**アプリが書くイベントと混ざらないため**
 * （runbook §10.6 の約束）。`session.issue` や `passkey.deleted` は Worker の
 * コードが書くもので、こちらは運用者の手元から `wrangler` 越しに入る。
 * 出所が違えば信用の度合いも違うので、接頭辞で分けておく。
 *
 * `actor` は実行した人の識別子。**メールアドレスや本名を入れないこと**
 * （`audit-log.port.ts` と同じ約束）。GitHub のハンドルやチケット番号で足りる。
 */
export function adminRoleAuditSql(input: {
  readonly event: AdminRoleAuditEvent;
  readonly userId: string;
  readonly actor: string;
  readonly reason: string;
}): string {
  return `insert into audit_logs (id, event, user_id, actor, outcome, reason, metadata, created_at)
values (
  'aud_' || lower(hex(randomblob(16))),
  ${sqlLiteral(input.event)},
  ${sqlLiteral(input.userId)},
  ${sqlLiteral(input.actor)},
  'success',
  ${sqlLiteral(input.reason)},
  json_object('source', 'scripts/admin-role.mjs'),
  ${NOW_MS}
);`;
}

/**
 * 付与の前後に状態を確かめるための SELECT。
 *
 * 運用者が「なぜ付与できなかったのか」を自分で読めるようにするためのもので、
 * 判定には使わない（判定は UPDATE の WHERE が単独で行う）。
 */
export function adminRoleStatusSql(userId: string): string {
  const id = sqlLiteral(userId);
  return `select u.id, u.username, u.status, u.is_admin,
       (u.deleted_at is not null) as is_deleted,
       (select count(*) from passkeys p where p.user_id = u.id) as passkeys,
       (select count(*) from sessions s
         where s.user_id = u.id and s.revoked_at is null
           and s.expires_at > ${NOW_MS} and s.auth_method <> 'passkey') as otp_sessions
  from users u
 where u.id = ${id};`;
}

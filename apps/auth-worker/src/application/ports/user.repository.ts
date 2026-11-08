import type { User } from "../../domain/entities/user";

export interface NewUser {
  readonly id: string;
  readonly username: string;
  readonly displayName: string;
  readonly email: string;
  readonly emailVerified: boolean;
}

/**
 * プロフィール更新の結果。
 *
 * username の一意性を最終的に裁くのは `users_username_unique`（lower(username)）で、
 * アプリ側で「引いてから書く」だけでは同時更新の競合を防げない。衝突を例外では
 * なく値で返し、Application が 409 へ翻訳できるようにする。`PasskeyRepository.create`
 * が一意制約の負けを null で返すのと同じ考え方（仕様書 7.3）。
 */
export type UpdateProfileOutcome =
  | { readonly kind: "updated"; readonly user: User }
  | { readonly kind: "username_taken" }
  | { readonly kind: "not_found" };

/**
 * ユーザー永続化の Port。
 *
 * Application が必要とする操作だけを並べる。Drizzle のクエリビルダや
 * テーブル型をここへ漏らさない（仕様書 7.2）。
 */
export interface UserRepository {
  findById(id: string): Promise<User | null>;
  /**
   * まとめ引き（#471、admin-worker の一覧が所有者・actor を名前で出すため）。
   *
   * **`findById` をループで呼ばないこと。** 1 行ごとに読むと行数ぶんの
   * 往復が走る——`IN` 句 1 回にまとめる。
   *
   * **見つからない ID は結果に含めない。** 呼ぶ側（`DelegatedGetUsersByIdsUseCase`）
   * はこれを「取りこぼし」として扱う前提で、ここでは `null` を混ぜたり
   * 例外を投げたりしない。
   *
   * **重複があっても二重に返さない。** 一意な `id` に対する行の集合を
   * 返すだけなので、呼ぶ側が重複を落とさなくても壊れない
   * （落とすのが望ましいのは、呼び出しの大きさを抑えるためであって、
   * 正しさのためではない）。
   */
  findByIds(ids: readonly string[]): Promise<readonly User[]>;
  /** 大文字小文字を無視して検索する。 */
  findByEmail(email: string): Promise<User | null>;
  findByUsername(username: string): Promise<User | null>;
  create(user: NewUser): Promise<User>;
  updateProfile(
    id: string,
    changes: { displayName?: string; username?: string },
  ): Promise<UpdateProfileOutcome>;
  markEmailVerified(id: string, email: string): Promise<void>;
  /**
   * 最後にログインした時刻を記録する（#286）。
   *
   * **`sessions.touch()` とは別物である。** あちらは認証付き要求が届く
   * たびに動き、30 日で掃除される。こちらは**ログインが成立した瞬間**
   * だけで、保持期間（最終利用から 1 年）の起点として 1 年を越えて残る。
   */
  touchLastActive(id: string, at: Date): Promise<void>;
  /**
   * 本人の退会（#318 / ランブック §11.7）。`status` を `suspended` にする。
   *
   * **`deleted` にしない。** あちらは「個人情報が落ちている」ことを指す
   * 名前で、落とさずに立てると `purgeUserSql` の `status <> 'deleted'` に
   * 弾かれ、**管理者が二度と落とせなくなる。** しかも `returning` が
   * 0 行を返すので「既に落とした」と区別が付かない。
   *
   * **BAN と同じ状態になる。** 理由の区別は `audit_logs` の
   * `account.closed` が持つ（`status` には持たせない）。
   *
   * 既に `active` でない行には当たらない。二重に退会させても
   * `updated_at` だけが進むのを避ける。
   */
  closeAccount(id: string): Promise<boolean>;
  /**
   * 管理画面の一覧（#375）。**キーセット方式で、OFFSET を使わない。**
   *
   * `limit + 1` 件まで読んで、超えた分で「続きがあるか」を決めるのは
   * **呼ぶ側（UseCase）の仕事**にしてある —— ここで `nextCursor` まで
   * 組み立てると、並び順の決め方が Repository と契約の 2 か所に散る。
   *
   * **並びは `created_at` の降順、同値は `id` の降順。** `id` を混ぜる
   * のは、同じミリ秒に作られた行が 2 つあるとカーソルがそこで止まる
   * ため（テストの seed では実際に起きる）。
   */
  /**
   * 管理者による停止・解除（#375 / ランブック §11.1）。
   *
   * **`deleted` の行には当たらない。** あれは「個人情報が落ちている」
   * ことを指す状態で（§11.6 の表）、**戻せるものではない** ——
   * 落とした情報は戻らないのに `active` に見えるアカウントができる。
   *
   * **`from` を指定させる。** 「いま `active` なものだけ止める」
   * 「いま `suspended` なものだけ戻す」を SQL の条件に入れることで、
   * **読んでから書くまでの間に状態が変わっていたら 0 行**になる。
   * 読み直して分岐すると、その隙間で二重に書ける。
   *
   * 当たらなければ false。呼ぶ側はそれを `conflict` に訳す。
   */
  setStatus(
    id: string,
    change: { readonly from: "active" | "suspended"; readonly to: "active" | "suspended" },
  ): Promise<boolean>;
  listForAdmin(criteria: {
    /** メールアドレスか username の**完全一致**。部分一致は持たない。 */
    readonly query?: string;
    /** 前回の最後の行。**これより古いものを返す。** */
    readonly after?: { readonly createdAt: Date; readonly id: string };
    readonly limit: number;
  }): Promise<readonly User[]>;
  /**
   * 状態ごとの件数（admin-worker のホーム用、#512）。**`listForAdmin` を
   * 全ページ舐めて数えないこと** —— `OAuthClientRepository.count()`
   * （#449）と同じ判断で、`count(*) ... group by status` 1 本で集計する。
   */
  countByStatus(): Promise<{
    readonly active: number;
    readonly suspended: number;
    readonly deleted: number;
  }>;
  /**
   * 行そのものを消す（管理画面からの強制削除、運用者判断 2026-11-08）。
   * **`closeAccount` / `purgeUserSql` とは別物。** あちらは `status` を
   * 変えるだけで行は残す（仕様書 §14.1 決定 7、ただし運用者がこの操作の
   * ために上書きした。改訂の docs は #553）。
   * こちらは `delete from users` そのもので、**戻せない。**
   *
   * **名前を `delete` にしていない。** `status` の列挙には既に `"deleted"`
   * という値があり（`purgeUserSql` が立てる、行は残る）、`delete()` という
   * メソッド名を見ても「行が消えるのか、`status` が変わるのか」が読めない。
   * `deletePermanently` という名前自体に、どちらであるかを書いてある。
   *
   * ## `oauth_clients.owner_user_id` を道連れにする
   *
   * `owner_user_id` は `users.id` を参照するが `onDelete` を持たない
   * （`packages/db/src/schema/oauth.ts` の注釈——決定 7 を前提に、参照先が
   * 消えて空振りする経路は無いはずだった）。そのままでは `delete from users`
   * が FK 違反で落ちる。**クライアントの行は消さない**——持ち主が消えた
   * だけでログインの宛先を失わせる理由が無いので、`owner_user_id` を
   * `null` に戻してから本体を消す。2 文は `d1.batch()` でまとめ、
   * 「owner だけ外れて user は残る」中途半端な状態を作らない。
   *
   * ## 他のテーブルは CASCADE に任せる
   *
   * セッション・Passkey・`user_emails`・認可コード・同意・トークンは
   * すべて `onDelete: "cascade"` を持つので、この 1 文で一緒に消える
   * （`packages/db/src/schema` を参照）。
   *
   * ## 残るもの
   *
   * `audit_logs.user_id` は FK を持たないので残る——**意図的。**
   * 物理削除後に「この id は削除された」と辿れる唯一の手段になる
   * （`purgeUserSql` の JSDoc と同じ理由）。`nfc_cards.owner_user_id` /
   * `admin_approvals.sub` も別 D1 で FK を持たず、ここからは触れない
   * （別の Worker・別のマイグレーションの範囲）。
   *
   * 対象が存在しなければ `false`。呼ぶ側はそれを `not_found` に訳す。
   */
  deletePermanently(id: string): Promise<boolean>;
}

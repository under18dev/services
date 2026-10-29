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
}

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
}

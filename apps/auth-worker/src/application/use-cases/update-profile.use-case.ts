import { Username } from "@u18/domain";
import type { User } from "../../domain/entities/user";
import { hasFreshAuthentication } from "../../domain/services/reauthentication";
import type { AuditLogger } from "../ports/audit-log.port";
import type { Clock } from "../ports/clock.port";
import type { UserRepository } from "../ports/user.repository";
import type { GetSessionUseCase } from "./get-session.use-case";
import { settleSideEffects } from "./side-effects";
import { err, ok, type UseCaseResult } from "./types";

export type UpdateProfileCommand = {
  readonly sessionToken: string;
  readonly displayName?: string | undefined;
  readonly username?: string | undefined;
};

export type UpdateProfileOutput = {
  readonly user: User;
  /** 実際に値が変わった項目。値そのものは返さず、呼び出し元は user を見る。 */
  readonly changedFields: readonly string[];
  /**
   * **このセッションで管理者として振る舞ってよいか**（決定 8 / RR-21）。
   *
   * `user.isAdmin` をそのまま返す応答にすると、Passkey 以外で張られた
   * セッションに対しても旗が立って見える。ここで `GetSessionUseCase` が
   * 出した値を運ぶのは、**Presentation に `user` と認証方式の 2 つを
   * 渡して組み立てさせない**ため —— 組み立てる場所が増えるほど、
   * そのうち 1 か所が `user.isAdmin` を直接読む（`identity.entrypoint.ts`）。
   */
  readonly isAdmin: boolean;
};

export type UpdateProfileDeps = {
  readonly getSession: GetSessionUseCase;
  readonly users: UserRepository;
  readonly clock: Clock;
  readonly audit: AuditLogger;
};

/**
 * displayName の長さ。
 *
 * 下限 1 は「空文字で表示名を消せない」の意味。上限 64 は UI と通知メールで
 * 折り返せる範囲に収めるためで、ここを開けると他人の画面を崩す材料になる。
 */
const DISPLAY_NAME_MAX_LENGTH = 64;

/**
 * 自分のプロフィールを更新する（仕様書 8.1、issue #11）。
 *
 * 変更できるのは displayName と username だけ。email / status / id は
 * この UseCase の入力型に存在しないので、Presentation が余計な項目を
 * 渡してきても届かない（email の変更は所有確認を伴う別の経路の話）。
 *
 * username の変更には再認証を要求する。username は他者から見える呼び名で、
 * なりすましに直結するうえ、変えられた本人は「自分の名前が消えた」ことに
 * すぐ気づけない。セッション Cookie 1 枚で通る操作にはしない。
 */
export class UpdateProfileUseCase {
  constructor(private readonly deps: UpdateProfileDeps) {}

  async execute(command: UpdateProfileCommand): Promise<UseCaseResult<UpdateProfileOutput>> {
    if (command.displayName === undefined && command.username === undefined) {
      return err("invalid_input", "no updatable fields were provided");
    }

    const auth = await this.deps.getSession.execute({ sessionToken: command.sessionToken });
    if (!auth.ok) return auth;
    if (auth.value === null) return err("unauthenticated", "session is not valid");

    const { session, userId } = auth.value;
    const user = await this.deps.users.findById(userId);
    // GetSession が通った直後なので通常は起きない。起きたなら
    // セッションの裏付けが消えているので、認証されていない扱いにする。
    if (user === null) return err("unauthenticated", "session is not valid");

    const changes: { displayName?: string; username?: string } = {};

    if (command.displayName !== undefined) {
      const displayName = command.displayName.trim();
      if (displayName.length === 0 || displayName.length > DISPLAY_NAME_MAX_LENGTH) {
        return err("invalid_input", "displayName is not acceptable");
      }
      if (displayName !== user.displayName) changes.displayName = displayName;
    }

    if (command.username !== undefined) {
      // 予約語・文字種・長さの判定は Value Object に任せる。ここで条件を
      // 書き直すと、登録時と変更時でルールがずれる。
      const username = Username.tryCreate(command.username);
      if (username === null) return err("invalid_input", "username is not acceptable");
      // 大文字小文字だけの違いは「変更なし」。VO が小文字へ正規化し、
      // 一意索引も lower() なので、この 2 つは同じ名前を指している。
      if (username.value !== user.username.toLowerCase()) changes.username = username.value;
    }

    const changedFields = Object.keys(changes);
    // 送られてきた値が現在と同じだった場合。書き込まずに終える。
    // updatedAt を動かすと OIDC の `updated_at` claim が理由なく進み、
    // 監査ログにも「何も変わっていない変更」が積もる。
    if (changedFields.length === 0) return ok({ user, changedFields, isAdmin: auth.value.isAdmin });

    // 再認証の判定は衝突の確認より前に置く。順序を逆にすると、古い
    // セッションしか持たない相手でも応答の違いから「その username は
    // 使われているか」を確かめられてしまう。
    if (changes.username !== undefined && !hasFreshAuthentication(session, this.deps.clock.now())) {
      await this.recordFailure(userId, "stale_authentication", changedFields);
      return err("reauthentication_required", "recent authentication is required");
    }

    const outcome = await this.deps.users.updateProfile(userId, changes);
    if (outcome.kind === "not_found") return err("unauthenticated", "session is not valid");
    if (outcome.kind === "username_taken") {
      await this.recordFailure(userId, "username_taken", changedFields);
      // 「使えない」以上のことを返さない。誰が持っているのか、その相手が
      // 有効なのか停止中なのか削除済みなのかを区別できる応答にすると、
      // username からアカウントの状態を探る手段になる（仕様書 9）。
      return err("conflict", "username is not available");
    }

    await settleSideEffects(
      "profile.updated",
      this.deps.audit.record({
        event: "profile.updated",
        userId,
        outcome: "success",
        // 変更後の値は入れず、どの項目が変わったかだけを残す。
        // 監査ログは users より長く保持され、閲覧できる相手も広い。
        // 表示名・username は利用者本人を指す個人情報で、現在値は users を
        // 引けば分かる以上、同じ値をもう 1 か所に増やす理由がない（仕様書 9 Privacy）。
        metadata: { fields: changedFields },
      }),
    );

    return ok({ user: outcome.user, changedFields, isAdmin: auth.value.isAdmin });
  }

  private async recordFailure(
    userId: string,
    reason: string,
    changedFields: readonly string[],
  ): Promise<void> {
    await settleSideEffects(
      "profile.updated",
      this.deps.audit.record({
        event: "profile.updated",
        userId,
        outcome: "failure",
        reason,
        metadata: { fields: changedFields },
      }),
    );
  }
}

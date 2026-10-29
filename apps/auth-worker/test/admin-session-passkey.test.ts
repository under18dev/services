import { aUser } from "@u18/testing";
import { createExecutionContext, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { User } from "../src/domain/entities/user";
import { IdentityRPC } from "../src/presentation/rpc/identity.entrypoint";
import { resetDatabase } from "./helpers";
import { appEnv, seedLoggedInUser } from "./helpers.oauth";

/**
 * **管理者として振る舞えるのは Passkey で張ったセッションだけ**
 * （仕様書 §14.1 決定 8 / 脅威モデル RR-21）。
 *
 * ## 塞いでいる穴
 *
 * 決定 8 は長らく `IssueSessionUseCase` の入口にしか無かった。管理者の
 * `email_otp` ログインを拒否しているので、**`sessions` に OTP の行が
 * 無いこと**が前提になり、権限の判定はその前提に寄りかかって
 * `users.is_admin` だけを見ていた。
 *
 * ところが権限の付与は 2 文に分かれている（`grantAdminSql` →
 * `revokeNonPasskeySessionsSql`）。その間に張られた OTP セッション、
 * あるいは 2 文目が流れなかった場合に残る OTP セッションは、**前提の外**に
 * 出る。前提が崩れた瞬間、権限の判定は何も守らなくなる。
 *
 * **以前その窓から取れたのはアカウント操作までだった。** 管理用の操作が
 * 乗るほど、同じ窓から取れるものが増える。
 *
 * ## なぜ「再認証の窓に足す」形にしなかったか
 *
 * 素直な直し方は `hasFreshAuthentication` に `authMethod` の条件を足す
 * ことだが、**あれが掛かっていない管理操作には何も起きない。** 再認証を
 * 要求するのは「影響の大きい書き込み」だけで、一覧や参照には掛からない
 * （掛けると確認画面に慣れてしまうので、意図的にそうしてある）。
 * 読める側だけ開いたままになる。
 *
 * それに `hasFreshAuthentication` は `DeletePasskeyUseCase` でも使っており、
 * あちらを Passkey 必須にすると**メール OTP しか持たない利用者が自分の
 * 認証器を外せなくなる**。同じ関数に 2 つの意味を持たせる形になる。
 *
 * そこで**権限が決まる場所そのもの**（`GetSessionUseCase` が返す 1 ビット）
 * を絞る。管理操作は例外なくこのビットを見るので、**あとから足される
 * 管理操作が何も覚えていなくても効く。**
 */

const OTHER_AUTH_METHOD = "email_otp" as const;

let rpc: IdentityRPC;

beforeEach(async () => {
  await resetDatabase();
  rpc = new IdentityRPC(createExecutionContext(), appEnv());
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("User.actsAsAdminWith", () => {
  const admin = User.fromPersistence(aUser({ isAdmin: true }));
  const member = User.fromPersistence(aUser({ isAdmin: false }));

  it("管理者 + passkey だけが true", () => {
    expect(admin.actsAsAdminWith("passkey")).toBe(true);
  });

  it("管理者 + email_otp は false", () => {
    expect(admin.actsAsAdminWith(OTHER_AUTH_METHOD)).toBe(false);
  });

  it("一般利用者は passkey でも false", () => {
    // 認証方式を見るようにしたことで「全員が管理者になる」方向へ
    // 倒れていないこと。条件は && なので片側だけでは通らない。
    expect(member.actsAsAdminWith("passkey")).toBe(false);
  });
});

describe("OTP セッションの管理者には権限が出ない", () => {
  it("getSession の isAdmin が false になる", async () => {
    const user = await seedLoggedInUser({ isAdmin: true, authMethod: OTHER_AUTH_METHOD });

    const result = await rpc.getSession({ sessionToken: user.sessionToken });

    expect(result.ok && result.value?.isAdmin).toBe(false);
  });

  it("同じ利用者でも passkey のセッションなら true になる", async () => {
    // 旗ではなくセッションを見ていることの確認。**これが無いと
    // 「常に false」でもこのファイルは緑になる。**
    const user = await seedLoggedInUser({ isAdmin: true, authMethod: "passkey" });

    const result = await rpc.getSession({ sessionToken: user.sessionToken });

    expect(result.ok && result.value?.isAdmin).toBe(true);
  });

  it("getUserProfile も false", async () => {
    const user = await seedLoggedInUser({ isAdmin: true, authMethod: OTHER_AUTH_METHOD });

    const result = await rpc.getUserProfile({ sessionToken: user.sessionToken });

    expect(result.ok && result.value?.isAdmin).toBe(false);
  });

  it("updateProfile の応答も false（値が変わった経路）", async () => {
    const user = await seedLoggedInUser({ isAdmin: true, authMethod: OTHER_AUTH_METHOD });

    const result = await rpc.updateProfile({
      sessionToken: user.sessionToken,
      displayName: "新しい表示名",
    });

    expect(result.ok && result.value.changedFields).toEqual(["displayName"]);
    expect(result.ok && result.value.profile.isAdmin).toBe(false);
  });

  it("updateProfile の応答も false（何も変わらなかった経路）", async () => {
    // 成功の return が 2 か所あるので、両方を通す。片方だけ直すと
    // 「送った値が現在と同じだったときだけ管理者に見える」形になる。
    const user = await seedLoggedInUser({ isAdmin: true, authMethod: OTHER_AUTH_METHOD });

    const result = await rpc.updateProfile({
      sessionToken: user.sessionToken,
      displayName: user.displayName,
    });

    expect(result.ok && result.value.changedFields).toEqual([]);
    expect(result.ok && result.value.profile.isAdmin).toBe(false);
  });

  it("一般利用者の passkey セッションは false のまま", async () => {
    const user = await seedLoggedInUser({ authMethod: "passkey" });

    const result = await rpc.getSession({ sessionToken: user.sessionToken });

    expect(result.ok && result.value?.isAdmin).toBe(false);
  });
});

describe("権限を伏せたことを黙って済ませない", () => {
  it("OTP セッションの管理者が現れたら Workers のログへ出す", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const user = await seedLoggedInUser({ isAdmin: true, authMethod: OTHER_AUTH_METHOD });

    await rpc.getSession({ sessionToken: user.sessionToken });

    const lines = warn.mock.calls.map(([first]) => String(first));
    const reported = lines.filter((line) => line.includes("admin.session_not_passkey"));
    expect(reported, "伏せたことがどこにも残っていない").toHaveLength(1);
    expect(JSON.parse(reported[0]!)).toMatchObject({
      event: "admin.session_not_passkey",
      userId: user.userId,
      sessionId: user.sessionId,
      authMethod: OTHER_AUTH_METHOD,
    });
  });

  it("一般利用者では出さない", async () => {
    // 権限が無いことは普通の状態である。ここで出すと、ログの中で
    // 「異常」が埋もれる（出しすぎは出さないのと同じになる）。
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const user = await seedLoggedInUser();

    await rpc.getSession({ sessionToken: user.sessionToken });

    const lines = warn.mock.calls.map(([first]) => String(first));
    expect(lines.filter((line) => line.includes("admin.session_not_passkey"))).toEqual([]);
  });

  it("passkey の管理者でも出さない", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const user = await seedLoggedInUser({ isAdmin: true, authMethod: "passkey" });

    await rpc.getSession({ sessionToken: user.sessionToken });

    const lines = warn.mock.calls.map(([first]) => String(first));
    expect(lines.filter((line) => line.includes("admin.session_not_passkey"))).toEqual([]);
  });
});

/**
 * **外へ出す `isAdmin` を Presentation が組み立てない。**
 *
 * 判定は `GetSessionUseCase` の 1 か所にあるが、応答に `isAdmin` を詰める
 * 場所は 3 つある（`getSession` / `getUserProfile` / `updateProfile`）。
 * 実際そのうち 2 つが `user.snapshot()` から直接詰めていた。
 *
 * **型は両方 `boolean` なので、入れ替えても何も言われない。** 上のテストは
 * いま在る 3 つを通すが、4 つ目が足されたときには何も起きない。右辺の
 * 出どころを見る検査をここに置く。
 *
 * **この検査自身の視野の外**: 右辺が `user` / `props` 以外の名前で
 * `users` の行を運んでいる場合（`row.isAdmin` を別名に入れてから詰めるなど）は
 * 拾えない。拾えるのは「いちばんありそうな形」までである。
 */
describe("Presentation が isAdmin を users の行から詰めていない", () => {
  const sources = [...env.TEST_PRESENTATION_IS_ADMIN_SOURCES];

  it("走査が実際に代入を拾っている", () => {
    // **件数を先に見る。** 走査が 0 件を返していると、下の検査は
    // 「違反が無い」ではなく「何も見ていない」で緑になる。
    expect(sources.length, `拾えた代入: ${sources.join(" / ")}`).toBeGreaterThanOrEqual(3);
  });

  it("どれも UseCase の結果から来ている", () => {
    const fromUserRow = sources.filter((expression) => /\b(props|user)\./.test(expression));

    expect(fromUserRow, "users の行から直接詰めている").toEqual([]);
  });
});

import { ACCOUNT_API_ERROR_CODES } from "@u18/contracts";
import { Username } from "@u18/domain";
import { describe, expect, it } from "vitest";
import {
  messageFor,
  PROFILE_FALLBACK,
  PROFILE_MESSAGES,
  REVOKE_FALLBACK,
  REVOKE_MESSAGES,
  USERNAME_REASONS,
} from "../src/presentation/http/ui/client/messages";

/**
 * 利用者に出す文言（#312）。
 *
 * **アイランド本体は DOM を使うので、ここからは動かせない。** 文言だけ
 * `client/messages.ts` へ出してあるので、値として確かめられる
 * （`island-outcome.test.ts` と同じ形）。
 */
describe("操作ごとに文言を分ける", () => {
  it("取り消しとプロフィール更新で conflict の意味が違う", () => {
    // **ここが #312 の本体。** 取り消しの `conflict` は「いまの状態では
    // 取り消せない」で、プロフィール更新の `conflict` は**ユーザー名が
    // 既に使われている**である。1 つの表を使い回すと、「画面を更新して
    // お試しください」と案内することになり、**名前が埋まっている状況では
    // 何も解決しない行動**を指示する。
    expect(PROFILE_MESSAGES.conflict).not.toBe(REVOKE_MESSAGES.conflict);
    expect(PROFILE_MESSAGES.conflict).toContain("ユーザー名");
    // 誰が持っているか・その相手の状態は書かない（仕様書 9）。
    expect(PROFILE_MESSAGES.conflict).not.toMatch(/停止|削除|凍結/);
  });

  it("再認証の案内も操作ごとに違う", () => {
    // ユーザー名の変更にだけ要る。取り消しの文言のままだと、
    // 何の操作に再認証が要るのかが読めない。
    expect(PROFILE_MESSAGES.reauthentication_required).not.toBe(
      REVOKE_MESSAGES.reauthentication_required,
    );
    expect(PROFILE_MESSAGES.reauthentication_required).toContain("ユーザー名");
  });

  it("どちらの表も全コードに文言がある", () => {
    // 網羅は `Record<AccountApiErrorCode, string>` が型で保証しているが、
    // **空文字で埋めれば型は通る。** 契約側のコードを数えて突き合わせる。
    expect(ACCOUNT_API_ERROR_CODES.length).toBeGreaterThan(0);
    for (const code of ACCOUNT_API_ERROR_CODES) {
      expect(REVOKE_MESSAGES[code], `取り消し: ${code}`).not.toBe("");
      expect(PROFILE_MESSAGES[code], `プロフィール: ${code}`).not.toBe("");
    }
    expect(Object.keys(REVOKE_MESSAGES).sort()).toEqual([...ACCOUNT_API_ERROR_CODES].sort());
    expect(Object.keys(PROFILE_MESSAGES).sort()).toEqual([...ACCOUNT_API_ERROR_CODES].sort());
  });

  it("既定の文言も操作ごとに違う", () => {
    expect(PROFILE_FALLBACK).not.toBe(REVOKE_FALLBACK);
  });
});

describe("ユーザー名が使えない理由", () => {
  /**
   * **`Username.reasonFor` が実際に返す値に文言があること。**
   *
   * 型は `Record<InvalidUsernameReason, string>` で網羅を保証するが、
   * それは**列挙が実装と一致している限りの話**である。判定側が返す値を
   * 実際に通して、受け手が持っていることを確かめる。
   */
  it.each([
    ["ab", "短すぎ"],
    ["a".repeat(33), "長すぎ"],
    ["taro!", "使えない文字"],
    ["admin", "予約語"],
  ])("%s に出す文言がある", (raw) => {
    const reason = Username.reasonFor(raw);
    expect(reason, `${raw} は拒否されるはず`).not.toBeNull();
    if (reason === null) return;
    expect(USERNAME_REASONS[reason]).not.toBe("");
  });

  it("4 つの理由すべてを実際に引き当てられる", () => {
    // **1 つも引き当てられなくてもこのファイルは緑になりうる。**
    // 上の `it.each` は「返った理由に文言がある」しか見ていないので、
    // 判定が全部 `null` を返すようになっても落ちない。実際に 4 種類
    // 出ていることを数で固定する。
    const seen = new Set(
      ["ab", "a".repeat(33), "taro!", "admin"].map((raw) => Username.reasonFor(raw)),
    );
    expect(seen.size).toBe(Object.keys(USERNAME_REASONS).length);
  });
});

describe("messageFor", () => {
  const respond = (body: unknown) => ({ json: async () => body });

  it("本文のコードから文言を引く", async () => {
    await expect(
      messageFor(respond({ error: "conflict" }), PROFILE_MESSAGES, PROFILE_FALLBACK),
    ).resolves.toBe(PROFILE_MESSAGES.conflict);
  });

  it("知らないコードは既定に落ちる", async () => {
    await expect(
      messageFor(respond({ error: "teapot" }), PROFILE_MESSAGES, PROFILE_FALLBACK),
    ).resolves.toBe(PROFILE_FALLBACK);
  });

  it("本文が JSON でなくても何か返す", async () => {
    // 502 の HTML など。ここで例外が漏れると、アイランドは
    // **何も表示しないまま**ボタンを戻す。
    const broken = {
      json: async () => {
        throw new SyntaxError("not json");
      },
    };
    await expect(messageFor(broken, PROFILE_MESSAGES, PROFILE_FALLBACK)).resolves.toBe(
      PROFILE_FALLBACK,
    );
  });
});

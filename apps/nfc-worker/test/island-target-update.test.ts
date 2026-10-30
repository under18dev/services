import { describe, expect, it } from "vitest";
import { TARGET_REJECTION_COPY } from "../src/presentation/http/ui/client/messages";
import { readTargetUpdate } from "../src/presentation/http/ui/client/target-update";

/**
 * 遷移先の変更で、応答をどう読むか（#338）。
 *
 * **アイランド本体は DOM を使うのでここから動かせない。** 判断だけを
 * `client/target-update.ts` に出してあるので、**関数として直接確かめる**
 * （dashboard-worker の `island-outcome.test.ts` と同じ形）。
 */
describe("readTargetUpdate", () => {
  it("成功は updated", () => {
    expect(readTargetUpdate({ ok: true, status: 200 }, null)).toEqual({ kind: "updated" });
  });

  it("400 の reason を、そのまま利用者の言葉にする", () => {
    const outcome = readTargetUpdate(
      { ok: false, status: 400 },
      { error: "invalid_target_url", reason: "not_https" },
    );

    expect(outcome).toEqual({ kind: "rejected", message: TARGET_REJECTION_COPY.not_https });
  });

  it("サーバー側の reason が全部ここにある", () => {
    // **`target-url.ts` が理由を増やしたら落ちる。** 文言を足し忘れると
    // 「この URL は設定できません」だけになり、利用者は自分の入力の
    // どこが悪いのか分からないまま同じ操作を繰り返す。
    //
    // 一覧は `domain/services/target-url.ts` の `TargetUrlRejection`。
    // **型は実行時に見られない**ので、ここに書き写してある —— だから
    // この行自体が「書き写しが古くなる」形を抱えている。せめて
    // **数が合っていること**を見る。
    const known = [
      "not_absolute",
      "too_long",
      "not_https",
      "has_credentials",
      "non_default_port",
      "private_host",
      "blocked_host",
    ];

    expect(Object.keys(TARGET_REJECTION_COPY).sort()).toEqual([...known].sort());
  });

  it("知らない reason でも、専用の文言に落とす", () => {
    // **握り潰さない。** サーバー側に理由が増えたとき、画面が黙って
    // 汎用の失敗へ畳むと、利用者は何を直せばよいか分からない。
    const outcome = readTargetUpdate(
      { ok: false, status: 400 },
      { error: "invalid_target_url", reason: "something_new" },
    );

    expect(outcome.kind).toBe("rejected");
    expect(outcome).not.toEqual({ kind: "rejected", message: "" });
  });

  it("本文が読めなくても、400 は rejected として扱う", () => {
    expect(readTargetUpdate({ ok: false, status: 400 }, null).kind).toBe("rejected");
  });

  it("401 / 404 / 503 を言い分ける", () => {
    expect(readTargetUpdate({ ok: false, status: 401 }, null).kind).toBe("failed");
    expect(readTargetUpdate({ ok: false, status: 404 }, null).kind).toBe("failed");
    expect(readTargetUpdate({ ok: false, status: 503 }, null).kind).toBe("failed");

    const messages = new Set(
      [401, 404, 503].map((status) => {
        const outcome = readTargetUpdate({ ok: false, status }, null);
        return outcome.kind === "failed" ? outcome.message : "";
      }),
    );
    // **同じ文言に畳まない。** 畳むと、ログインし直せば済む場合と
    // 待つしかない場合が区別できない。
    expect(messages.size).toBe(3);
  });

  it("404 は「他人のカード」と「存在しない」を言い分けない", () => {
    // `statusFor` が 403 を返さないのと同じ理由。画面でも漏らさない。
    const outcome = readTargetUpdate({ ok: false, status: 404 }, { error: "card_not_found" });

    expect(outcome.kind === "failed" && outcome.message).not.toContain("他人");
    expect(outcome.kind === "failed" && outcome.message).not.toContain("権限");
  });

  it("知らない status を成功と読まない", () => {
    // **ここが一番まずい形。** `ok` が false なら、何であれ成功ではない。
    for (const status of [418, 500, 502]) {
      expect(readTargetUpdate({ ok: false, status }, null).kind).toBe("failed");
    }
  });
});

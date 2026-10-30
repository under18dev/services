import { describe, expect, it } from "vitest";
import { readCardAction } from "../src/presentation/http/ui/client/card-action";
import {
  CARD_ACTION_COPY,
  CARD_ACTION_SHARED_COPY,
} from "../src/presentation/http/ui/client/messages";

/**
 * 片道の操作の応答の読み方（#382）。
 *
 * `target-update.test.ts` と同じ形で、**DOM を使わないのでここから直接
 * 呼べる。** アイランドの中に書くと、バンドルされた文字列を正規表現で
 * 睨むことになる。
 */

const ok = { ok: true, status: 200 };
const status = (code: number) => ({ ok: false, status: code });

describe("片道の操作の応答", () => {
  it.each(["disable", "release"] as const)("%s: 成功は done", (action) => {
    expect(readCardAction(ok, action)).toEqual({ kind: "done" });
  });

  it.each(["disable", "release"] as const)("%s: 401 はログインし直しを促す", (action) => {
    expect(readCardAction(status(401), action)).toEqual({
      kind: "failed",
      message: CARD_ACTION_SHARED_COPY.unauthenticated,
    });
  });

  it.each(["disable", "release"] as const)("%s: 404 で他人のカードを言い分けない", (action) => {
    // `card_not_found` が 403 を返さないのは、他人のカード ID を当てたことを
    // 相手に伝えないためである。**画面でもそこを言い分けない。**
    expect(readCardAction(status(404), action)).toEqual({
      kind: "failed",
      message: CARD_ACTION_SHARED_COPY.notFound,
    });
  });

  it.each(["disable", "release"] as const)("%s: 503 は待つよう伝える", (action) => {
    expect(readCardAction(status(503), action)).toEqual({
      kind: "failed",
      message: CARD_ACTION_SHARED_COPY.unavailable,
    });
  });

  it.each([400, 418, 500] as const)("想定していない %i でも成功とは言わない", (code) => {
    // **「成功したかもしれない」を作らない。** 片道の操作なので、
    // ここを曖昧にすると「押したが止まったか分からない」が残る。
    const outcome = readCardAction(status(code), "disable");

    expect(outcome.kind).toBe("failed");
    expect(outcome).toEqual({ kind: "failed", message: CARD_ACTION_COPY.disable.failed });
  });

  it("失敗の文言が操作ごとに違う", () => {
    // 「できませんでした」だけだと、何ができなかったのか分からない。
    const disable = readCardAction(status(500), "disable");
    const release = readCardAction(status(500), "release");

    expect(disable).not.toEqual(release);
  });
});

describe("確認の文面", () => {
  it.each(["disable", "release"] as const)("%s: どのカードかを出す", (action) => {
    // 押す前に対象が分からないと、違うカードを止めても気づけない。
    expect(CARD_ACTION_COPY[action].confirm("nfc_abc123")).toContain("nfc_abc123");
  });

  it("止めるほうは、戻せないことを言う", () => {
    expect(CARD_ACTION_COPY.disable.confirm("nfc_x")).toContain("元に戻せません");
  });

  it("ゆずるほうは、次にタップした人のものになることを言う", () => {
    // **「あとで取り消せる」と読ませない。** #358 で紐づけコードが
    // 無くなったので、手放した瞬間から誰でも登録できる。
    const text = CARD_ACTION_COPY.release.confirm("nfc_x");

    expect(text).toContain("次にタップした人のもの");
    expect(text).toContain("遷移先も消えます");
  });

  it("Markdown を書かない", () => {
    // `window.confirm` はネイティブのダイアログなので、`**強調**` は
    // そのままアスタリスクとして出る。
    for (const action of ["disable", "release"] as const) {
      expect(CARD_ACTION_COPY[action].confirm("nfc_x")).not.toContain("**");
    }
  });
});

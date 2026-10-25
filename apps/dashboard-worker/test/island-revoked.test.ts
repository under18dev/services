import { describe, expect, it } from "vitest";
import { isRevoked } from "../src/presentation/http/ui/client/revoked";

/**
 * 取り消しの応答を「消えた」と見る条件。
 *
 * **アイランド本体は import できない**（モジュールの先頭で `document` を
 * 触る）ので、判定だけを切り出して本物を呼ぶ。ここで `status === 404` と
 * 書き直すと、検査しているのは「テストの中の判定」になる。
 */
describe("isRevoked", () => {
  it("204 は消えた", () => {
    expect(isRevoked({ ok: true, status: 204 })).toBe(true);
  });

  it("404 も消えた（既に無いものを消そうとしただけ）", () => {
    // 失敗として見せると「消えていないのでは」と思わせる。利用者には
    // 確かめる手段が無く、不安だけが残る。別のタブで取り消した、
    // 期限切れで掃除された、といった経路で普通に起きる。
    expect(isRevoked({ ok: false, status: 404 })).toBe(true);
  });

  it.each([400, 401, 403, 409, 429, 500, 503])("%d は消えていない", (status) => {
    expect(isRevoked({ ok: false, status })).toBe(false);
  });
});

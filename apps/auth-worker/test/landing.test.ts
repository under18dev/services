import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { LOGIN_ISLAND_JS } from "../src/presentation/http/ui/generated/login-island.bundle";
import { sanitizeReturnTo } from "../src/presentation/http/ui/return-to";

/**
 * 認証が済んだあとの着地点（ui/landing.ts）。
 *
 * ## ここが埋めている穴
 *
 * 着地点を決めている場所は 4 つあり、**経路ごとに別々**である ——
 * メール OTP のログイン、メール OTP のサインアップ、ログイン画面が
 * アイランドへ渡す `data-return-to`、アイランド側のフォールバック。
 * 1 つだけ直すと**ログインの仕方によって着地点が違う**状態になり、
 * どちらの経路も単体では動いて見えるので報告されない。
 *
 * 303 の行き先は `login.ui.test.ts` と `signup.ui.test.ts` が見ている。
 * **残りの 2 つ（アイランドへ渡す値と、アイランドが持つ既定値）を
 * 見る場所が無かった**ので、ここで埋める。
 *
 * ## 定数を import して突き合わせていない
 *
 * `DEFAULT_LANDING_PATH` を import すると、定数を書き換えたときに期待値も
 * 一緒に動き、**何を変えても緑のまま**になる。着地点のような「決めごと」は
 * 検査の側に書き写すほかない。4 つの経路が同じ場所へ行くことは、
 * **書き写した 4 つの文字列が一致していること**で決まる。
 */

const BASE = "http://localhost";

/** 着地点。実装の定数を import せず、ここに書き写している（上の理由）。 */
const LANDING = "/account";

function returnToAttributeOf(html: string): string | null {
  const match = /id="passkey-island" data-return-to="([^"]*)"/.exec(html);
  return match?.[1] ?? null;
}

describe("ログイン画面がアイランドへ渡す戻り先", () => {
  it("戻り先が無ければ既定の着地点を書く", async () => {
    const response = await SELF.fetch(`${BASE}/login`);
    const html = await response.text();

    // **属性ごと落とさない。** 落とすとパスキーの着地点が
    // バンドルの中にしか無くなり、描かれた HTML から確かめられない。
    expect(returnToAttributeOf(html)).toBe(LANDING);
  });

  it("戻り先が渡っていればそれをそのまま書く", async () => {
    // `&` を含めない —— HTML 側で `&amp;` に変わり、検査が
    // 「属性に何が入ったか」ではなく「どう符号化されたか」を見てしまう。
    // 符号化は login.ui.test.ts の描画の検査が別に見ている。
    const returnTo = "/oauth/authorize?client_id=demo";
    const response = await SELF.fetch(`${BASE}/login?return_to=${encodeURIComponent(returnTo)}`);
    const html = await response.text();

    // 既定値で上書きしていないこと。認可フローの途中なら元の要求へ戻る。
    expect(returnToAttributeOf(html)).toBe(returnTo);
  });

  it("既定の着地点は、戻り先として渡しても通る値である", () => {
    // 既定値が `sanitizeReturnTo` の許可リストから外れると、
    // 「戻り先として渡すと弾かれるが、既定では行く」という食い違いができる。
    // dashboard / nfc が `/account` へ戻そうとして弾かれる形で出る。
    expect(sanitizeReturnTo(LANDING)).toBe(LANDING);
  });
});

describe("アイランドが持つ既定の着地点", () => {
  /**
   * ブラウザで動く JS からパスのリテラルを拾う。
   *
   * **バンドルそのものを見る。** アイランドは `document` に触る副作用を
   * 持つので workerd の中では読み込めず、ソースを読んでも
   * 「ビルドされた形」とは限らない。配信される文字列が答えである。
   *
   * 拾うのは `/` の後ろに 1 文字以上あるものだけ。hono/jsx/dom の内部に
   * ある裸の `"/"` は遷移先ではないので、この形で落ちる。
   */
  const pathLiterals = [...LOGIN_ISLAND_JS.matchAll(/"(\/[^"]+)"/g)].map((m) => m[1]!);
  const navigable = pathLiterals.filter((path) => !path.startsWith("/api/"));

  it("遷移先として持っているのは既定の着地点だけ", () => {
    // 1 つだけであること。`/login` が残っていれば 2 つになるし、
    // 別の場所へ変えれば中身が変わる。**どちらでも落ちる。**
    expect(navigable).toEqual([LANDING]);
  });
});

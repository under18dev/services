import { describe, expect, it } from "vitest";
import { describeWranglerFailure } from "../scripts/lib/wrangler-failure";

/**
 * 管理権限 CLI が、wrangler の失敗を伝えること（#83）。
 *
 * ## これが無かったせいで何が起きたか
 *
 * 運用者が本番で管理権限を付与できず、手元に出たのはこれだけだった。
 *
 * ```console
 * 付与前の状態:
 * エラー: wrangler が失敗した (exit 1)
 * ```
 *
 * **原因はどこにも残っていなかった。** `--json` を付けた wrangler は
 * **エラーを stdout に JSON で書き、stderr は空**で、CLI はその stdout を
 * pipe で捕まえたうえで**失敗時に捨てていた。**
 *
 * ## なぜ純粋な関数にしたか
 *
 * 元の実装は `throw new Error(...)` の 1 行で、**`spawnSync` の中に
 * 埋まっていた。** テストから触れないので、**「原因を伝える」が
 * 壊れても誰も気づけない。**
 *
 * 組み立てだけを `scripts/lib/wrangler-failure.mjs` に出して、ここが呼ぶ。
 * **呼ぶ側（`spawnSync` の結果を渡すところ）は依然として検査の外**だが、
 * そこは 3 行しかない。
 */

/** 実測した、`--json` での失敗応答。 */
const JSON_FAILURE = `
{
  "error": {
    "text": "Couldn't find a D1 DB with the name or binding 'u18-identity' in your wrangler.jsonc file."
  }
}
`;

describe("wrangler の失敗を伝える", () => {
  it("捕まえた出力を捨てない", () => {
    // **これが今回の本体。** 終了コードだけでは何も分からない。
    const message = describeWranglerFailure({ status: 1, stdout: JSON_FAILURE, remote: true });

    expect(message).toContain("Couldn't find a D1 DB");
  });

  it("読める 1 行を先に出し、生の応答も残す", () => {
    // 先に 1 行出すのは JSON をそのまま読ませないため。生を残すのは、
    // **こちらが想定していない形の失敗を切り捨てないため。**
    const message = describeWranglerFailure({ status: 1, stdout: JSON_FAILURE, remote: false });
    const summary = message.indexOf("Couldn't find a D1 DB");
    const raw = message.indexOf('"error"');

    expect(summary).toBeGreaterThan(-1);
    expect(raw).toBeGreaterThan(summary);
  });

  it("JSON として読めなくても、出力をそのまま残す", () => {
    // **読めなかったことを理由に捨てない。** 握り潰しの再発はここで止める。
    const message = describeWranglerFailure({
      status: 1,
      stdout: "✘ [ERROR] something went sideways",
      remote: false,
    });

    expect(message).toContain("something went sideways");
  });

  it("出力を捕まえていない経路では、端末を見るよう言う", () => {
    // `stdio: "inherit"` の呼び出し（`runSql`）はここへ来る。
    // **「出力が無い」と書くと、上に出ているものを見落とさせる。**
    const message = describeWranglerFailure({ status: 1, stdout: "", remote: false });

    expect(message).toContain("上に出ている");
    expect(message).not.toContain("出力が無い");
  });

  it("--remote のときは口座の指定について助言する", () => {
    // 運用者が詰まったのがここだった。**wrangler の文言に一致させていない**
    // ので、当たっていなくても出る。外れたら読む人が「これではない」と
    // 判断できるほうを採った。
    const message = describeWranglerFailure({ status: 1, stdout: JSON_FAILURE, remote: true });

    expect(message).toContain("CLOUDFLARE_ACCOUNT_ID");
    expect(message).toContain("wrangler whoami");
  });

  it("--local のときは口座の助言を出さない", () => {
    // ローカルの失敗に口座の話を出すと、**関係ない方向へ探させる。**
    const message = describeWranglerFailure({ status: 1, stdout: JSON_FAILURE, remote: false });

    expect(message).not.toContain("CLOUDFLARE_ACCOUNT_ID");
  });

  it("シグナルで落ちた場合も伝える", () => {
    // `spawnSync` はシグナルのとき `status` が null になる。
    // `exit null` と出すと、終了コード 0 と区別しにくい。
    const message = describeWranglerFailure({ status: null, stdout: "", remote: false });

    expect(message).toContain("signal");
    expect(message).not.toContain("exit null");
  });
});

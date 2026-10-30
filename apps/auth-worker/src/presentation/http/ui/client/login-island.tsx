/** @jsxImportSource hono/jsx/dom */
import { render, useState } from "hono/jsx/dom";
// 変換は `@u18/web-ui` に出した（登録側と同じものを使う。#306）。
import {
  supportsPasskey,
  toRequestOptions,
  toResponseJson,
} from "@u18/web-ui/client/webauthn-json";
/*
 * **`getButtonClasses()` を呼ばない。** `cn`（clsx + tailwind-merge）ごと
 * バンドルへ入り、島が 2 倍近くになる（#338 で実測）。リテラルは
 * `@u18/web-ui/kiwa/island-classes` 側にあり、あのファイルは何も
 * import しない（`packages/web-ui/test/island-classes.test.ts` が見ている）。
 */
import { BUTTON_CLASS, ITEM_META_CLASS } from "@u18/web-ui/kiwa/island-classes";
/*
 * **ここも何も引き連れてこない。** `../landing` は import を持たないので、
 * バンドルに入るのは文字列 1 つだけ。着地点をサーバーと共有するのが目的で、
 * 詳しい理由はそのファイルに書いてある。
 */
import { DEFAULT_LANDING_PATH } from "../landing";

/**
 * ログイン画面の Passkey アイランド（仕様書 14-1 の決定 4）。
 *
 * **このファイルだけがブラウザで動く。** 残りのログイン画面はサーバーで
 * レンダリングした HTML と通常の form POST だけで成立する（ui/login-page.tsx）。
 * 認証基盤のログイン画面が JS の読み込み失敗で丸ごと使えなくなるのは避けたいので、
 * JS が必要な範囲を「`navigator.credentials` を呼ぶところ」に閉じ込めている。
 * WebAuthn はブラウザ API を呼ぶ以外に実装しようがないため、ここだけは例外になる。
 *
 * ビルドは scripts/build-client.mjs（esbuild）が行い、
 * ui/generated/login-island.bundle.ts へ文字列として吐く。理由は README 参照。
 *
 * ## アカウント列挙をしない作りになっている理由（変更前に必ず読むこと）
 *
 * `POST /api/auth/passkeys/login/options` に**メールアドレスやユーザー識別子を
 * 渡していない**。これは手抜きではなく、サーバー側の
 * `PasskeyLoginOptionsUseCase` が入力を一切受け取らない設計と対になっている。
 * 識別子を渡して `allowCredentials` を返してもらう作りにすると、応答の差が
 * 「そのアカウントは存在する」という答えになる（仕様書 9 Privacy）。
 * 未成年の利用者を想定している以上、在籍の推測自体を避けたい。
 *
 * そのため、
 *  - どの Credential を使うかはブラウザ / OS の選択 UI に任せる
 *    （`residentKey: "required"` の discoverable credential 前提）
 *  - 失敗しても「このアドレスにはパスキーが登録されていません」とは言わない。
 *    メール OTP へ誘導する中立的な文言だけを出す
 *
 * 「候補を出したほうが親切では」と思ったら、API を緩める側ではなく
 * UX を変える側で解くこと。
 */

type Phase =
  | { readonly kind: "ready" }
  | { readonly kind: "running" }
  /** 失敗の理由は持たない。表示を分岐させる材料をそもそも作らない。 */
  | { readonly kind: "failed" };

type LoginOptionsResponse = {
  readonly challengeId: string;
  readonly options: Record<string, unknown>;
};

/**
 * 既存の認証 API をそのまま叩く。
 *
 * CSRF 対策は Origin 検証（`isAllowedOrigin`）で、同一オリジンの `fetch` には
 * ブラウザが POST に Origin を自動で付ける。form 側の CSRF トークンは
 * ここでは要らない（UI の form だけがトークン方式）。
 */
async function postJson(path: string, body: unknown): Promise<Response> {
  return fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // Cookie を送る。既定は same-origin だが、意図を明示しておく。
    credentials: "same-origin",
    body: JSON.stringify(body),
  });
}

function PasskeyLogin({ returnTo }: { returnTo: string }) {
  const [phase, setPhase] = useState<Phase>({ kind: "ready" });

  const start = async (): Promise<void> => {
    setPhase({ kind: "running" });
    try {
      const optionsResponse = await postJson("/api/auth/passkeys/login/options", {});
      if (!optionsResponse.ok) {
        setPhase({ kind: "failed" });
        return;
      }
      const { challengeId, options } = (await optionsResponse.json()) as LoginOptionsResponse;

      const credential = (await navigator.credentials.get({
        publicKey: toRequestOptions(options),
      })) as PublicKeyCredential | null;
      if (credential === null) {
        setPhase({ kind: "ready" });
        return;
      }

      const verify = await postJson("/api/auth/passkeys/login/verify", {
        challengeId,
        response: toResponseJson(credential),
      });
      if (!verify.ok) {
        setPhase({ kind: "failed" });
        return;
      }

      // セッション Cookie は Set-Cookie で入っている。認可フローの途中なら
      // 元の `/oauth/authorize` へ、そうでなければアカウント画面へ。
      //
      // 戻り先は**サーバーが data 属性に入れた値だけ**を使い、ここでは
      // `location.search` を読まない。クライアント側で URL を解釈すると、
      // サーバーの `sanitizeReturnTo` を迂回してオープンリダイレクトになる
      // （ui/return-to.ts）。属性に入っている時点で検証済み。
      window.location.assign(returnTo);
    } catch {
      // 利用者が選択 UI を閉じた場合も例外になる。理由で分岐しない。
      setPhase({ kind: "failed" });
    }
  };

  return (
    /*
      **包みにクラスを付けていない**（#332）。手書き CSS のころ
      `class="passkey"` と書いていたが、**`styles.ts` に定義が無く、
      何も指していなかった。** 上の余白は罫線（`または`）が、ボタンの
      幅はボタン自身が出している（本番で描いて確かめた）。
      ここで Tailwind に「再現」すると、**元に無かった余白を足すことになる。**
    */
    <div>
      <button
        type="button"
        class={BUTTON_CLASS}
        disabled={phase.kind === "running"}
        onClick={() => void start()}
      >
        {phase.kind === "running" ? "認証器を待っています…" : "パスキーでログイン"}
      </button>
      {phase.kind === "failed" ? (
        // 「登録されていません」とは言わない。失敗の理由を問わず同じ文言にする。
        <p class={ITEM_META_CLASS} role="status">
          パスキーでのログインを完了できませんでした。メールアドレスでのログインをお試しください。
        </p>
      ) : null}
    </div>
  );
}

const mount = document.getElementById("passkey-island");
if (mount !== null && supportsPasskey()) {
  // サーバーが検証済みの戻り先を置いていればそれを使う。
  //
  // **いまのサーバーは戻り先が無いときも既定値を書いて寄こす**ので、
  // ここが使われるのは属性ごと失われた場合だけ。それでも同じ既定値を
  // 持っておく —— 「どこへ飛ぶか分からない」より「サーバーと同じ場所へ
  // 飛ぶ」ほうがよい（ui/landing.ts）。
  const returnTo =
    mount instanceof HTMLElement && typeof mount.dataset["returnTo"] === "string"
      ? mount.dataset["returnTo"]
      : DEFAULT_LANDING_PATH;
  // サーバーが入れておいた「この端末では使えないかもしれない」旨の代替表示を
  // 置き換える。JS が落ちた場合はその代替表示が残る。
  mount.textContent = "";
  render(<PasskeyLogin returnTo={returnTo} />, mount);
}

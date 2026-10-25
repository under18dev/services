import { hc } from "hono/client";
import type { DashboardAppType } from "../../app";

/**
 * アカウント画面のクライアントアイランド。
 *
 * ## 何をするか
 *
 * セッションの失効と連携アプリの取り消しを、**既存の JSON API**
 * （`DELETE /account/api/me/sessions/:id` ほか）へ送る。
 *
 * ## なぜ form POST を並べないのか
 *
 * 既存の API は Origin 検証で守られている。そこへ form POST の経路を
 * 足すと **CSRF トークンの仕組みを別に持つことになり、2 つを同期させ
 * 続ける必要が出る**。本リポジトリで繰り返している「経路が違うと
 * 効かない」（#141 / #151 / #164）がそのまま再現する。
 *
 * 代償は **JS 無しでは失効できない**こと。表示は SSR なので JS 無しでも
 * 見え、操作だけが落ちる。ボタンはこのアイランドが**自分で作る**ので、
 * JS が読み込めなければボタン自体が現れない —— **押せるのに効かない**
 * という最悪の形にはならない。
 *
 * ## `hc` を使う
 *
 * `hc<DashboardAppType>` はサーバーのチェーンに積まれた型をそのまま見る
 * （`app.ts` の `registerRoutes`）。パスやメソッドを間違えると型で落ちる。
 * 空の型に戻ると**補完が消えるだけで型検査は通ってしまう**ので、
 * `test/client-type.test-d.ts` が `@ts-expect-error` で固定している。
 */

const client = hc<DashboardAppType>("", {
  // 同一オリジンへ送る。CSP の `connect-src 'self'` のままで通る。
  init: { credentials: "same-origin" },
});

/** 操作ボタンを挿す位置と、必要な情報を載せた属性。 */
type Target = {
  readonly element: HTMLElement;
  readonly kind: "session" | "grant";
  readonly id: string;
  readonly label: string;
};

function targets(): readonly Target[] {
  return Array.from(document.querySelectorAll<HTMLElement>("[data-revoke-kind]")).flatMap(
    (element) => {
      const kind = element.dataset["revokeKind"];
      const id = element.dataset["revokeId"];
      // 見出しは**画面に出ている文字列をそのまま読む**。属性で渡すと、
      // 要約できない User-Agent のときに同じ文字列が 2 回 HTML に載る
      // （`ui-pages.test.ts` が二重出力を禁じている）。
      const label = element.closest("li")?.querySelector(".item-title")?.textContent ?? "";
      if ((kind !== "session" && kind !== "grant") || id === undefined || id === "") return [];
      return [{ element, kind, id, label }];
    },
  );
}

/**
 * 戻り値に型注釈を付けない。
 *
 * `hc` が返すのは `ClientResponse`（ステータスごとに本文の型が分かれる）で、
 * ブラウザの `Response` とは別物である。ここで `Response` と書くと、
 * **`worker-configuration.d.ts` が入っている都合で Workers の `Response`**
 * として解決され、型が合わなくなる。使うのは `ok` と `status` だけ。
 */
async function revoke(target: Target) {
  if (target.kind === "session") {
    return await client.account.api.me.sessions[":id"].$delete({ param: { id: target.id } });
  }
  return await client.account.api.me.grants[":clientId"].$delete({
    param: { clientId: target.id },
  });
}

/** 行を「取り消し済み」の見た目にする。再読み込みせずに結果を見せる。 */
function markRevoked(target: Target): void {
  const row = target.element.closest("li");
  if (row === null) return;
  row.classList.add("revoked");
  target.element.replaceChildren(document.createTextNode("取り消しました"));
}

function showError(target: Target, message: string): void {
  const notice = document.createElement("p");
  notice.className = "error";
  notice.setAttribute("role", "alert");
  notice.textContent = message;
  target.element.replaceChildren(notice);
}

function attach(target: Target): void {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "button button-danger";
  button.textContent = target.kind === "session" ? "ログアウト" : "連携を解除";
  // 一覧の中でどれを操作するボタンか、読み上げでも分かるようにする。
  button.setAttribute(
    "aria-label",
    `${target.label}${target.kind === "session" ? " をログアウト" : " の連携を解除"}`,
  );

  button.addEventListener("click", () => {
    // 二度押しで 2 回送らない。1 回目が失敗したら下で戻す。
    button.disabled = true;

    void revoke(target)
      .then((response) => {
        // 204 と 404 を同じに扱う。**既に無いものを消そうとした**だけで、
        // 利用者から見た結果（もう使えない）は同じ。失敗として見せると
        // 「消えていないのでは」と思わせる。
        if (response.ok || response.status === 404) {
          markRevoked(target);
          return;
        }
        if (response.status === 401) {
          // セッションが切れている。この画面で直せないので読み込み直す
          // ——サーバーがログイン導線を返す。
          location.reload();
          return;
        }
        button.disabled = false;
        showError(target, "取り消せませんでした。しばらくしてからお試しください。");
      })
      .catch(() => {
        button.disabled = false;
        showError(target, "通信に失敗しました。接続をご確認ください。");
      });
  });

  target.element.replaceChildren(button);
}

for (const target of targets()) attach(target);

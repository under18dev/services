import { CARDS_BASE_PATH } from "../../base-path";
import { STATUS_ERROR_CLASS, STATUS_TEXT_CLASS } from "../island-classes";
import { CARD_ID, TARGET_FORM, TARGET_INPUT, TARGET_SAVE, TARGET_STATUS } from "../island-hooks";
import { createCardsClient } from "./api-client";
import { UPDATE_TARGET_COPY } from "./messages";
import { readTargetUpdate } from "./target-update";

/**
 * カード画面のアイランド（#338）。
 *
 * ## いま叩けるのは 1 本だけ
 *
 * `PUT /account/nfc/cards/:cardId/target`（遷移先の変更）。残り 4 本
 * （紐づけ・無効化・手放す・発行）は Step 2 / Step 3 で入る。
 *
 * **最初に通す 1 本を `target` にしたのは、間違えても戻せるからである。**
 * `disable` は片道、`release` は紐づけコードが 1 回しか返らない。
 *
 * ## 目印は `data-*` で引く
 *
 * 見た目の class（`.item-main` のような）で引かない。**Tailwind の class は
 * 移行のたびに変わる前提のもの**で、しかも `?.` で繋ぐと**一致しなくなっても
 * 例外が出ない** —— エラーは出ず、操作だけが黙って効かなくなる（#341）。
 *
 * ## CSRF トークンは要らない
 *
 * `cards.routes.ts` が `isAllowedOrigin` + `isJsonRequest` の両方を
 * 要求している。ブラウザは**同一オリジンの fetch にも `Origin` を付ける**
 * ので通り、クロスサイトからは `Origin` が合わない。form POST ではないので
 * double-submit cookie の側（#340）は掛からない。
 *
 * ## class をここで組み立てない
 *
 * `cn` を引き込むと**それだけで 27.8 KB**（#341 の実測）。必要な class は
 * `ui/island-classes.ts` の定数で、**サーバーも同じものを描いている。**
 */

const client = createCardsClient(window.location.origin, CARDS_BASE_PATH);

/** 1 枚ぶんの操作を繋ぐ。 */
function attach(form: HTMLElement): void {
  const cardId = form.getAttribute(CARD_ID);
  const input = form.querySelector<HTMLInputElement>(`[${TARGET_INPUT}]`);
  const button = form.querySelector<HTMLButtonElement>(`[${TARGET_SAVE}]`);
  const status = form.querySelector<HTMLElement>(`[${TARGET_STATUS}]`);

  // **揃っていなければ何もしない。** 目印が変わったときに「半分だけ動く」
  // 状態を作らない —— 押せるのに保存されない、が一番たちが悪い。
  if (cardId === null || input === null || button === null || status === null) return;

  const show = (message: string, failed: boolean): void => {
    status.textContent = message;
    status.className = failed ? STATUS_ERROR_CLASS : STATUS_TEXT_CLASS;
    // **読み上げにも出す。** 見えている人にしか結果が伝わらない状態にしない。
    if (failed) status.setAttribute("role", "alert");
    else status.removeAttribute("role");
  };

  button.addEventListener("click", () => {
    const targetUrl = input.value.trim();
    button.disabled = true;
    show("保存しています…", false);

    void (async () => {
      // **URL は `hc` に作らせ、本文は `fetch` で送る。**
      //
      // `$put({ json })` は型が通らない —— `cards.routes.ts` は
      // validator を使わず `c.req.json()` を手で読んでいるので、
      // **Hono のスキーマに入力の型が積まれていない。**（dashboard の
      // `client-type.test-d.ts` が「`hc` が守るのはパスとメソッドだけ」と
      // 書いているのと同じ事情。）
      //
      // **ここで validator を足して型を通す道は採らなかった。** 入力の
      // 検証が手書きから宣言へ移ると、**400 の応答の形が変わる**
      // （`invalid_target_url` / `reason` を自前で返している）。
      // 島を載せる PR で認可と入力検証の挙動を動かさない。
      //
      // `$url()` を通すので、**パスの組み立てだけは型に守られる。**
      const url = client[":cardId"].target.$url({ param: { cardId } });
      const response = await fetch(url, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ targetUrl }),
      });

      // **本文が読めなくても status からは判断する**（`target-update.ts`）。
      const body = await response.json().catch(() => null);
      const outcome = readTargetUpdate(response, body as Record<string, unknown> | null);

      if (outcome.kind === "updated") {
        show(UPDATE_TARGET_COPY.done, false);
      } else {
        show(outcome.message, true);
      }
      button.disabled = false;
    })().catch(() => {
      // 通信が落ちた。**「保存しています…」のまま放置しない。**
      show(UPDATE_TARGET_COPY.unknown, true);
      button.disabled = false;
    });
  });
}

for (const form of document.querySelectorAll<HTMLElement>(`[${TARGET_FORM}]`)) {
  attach(form);
}

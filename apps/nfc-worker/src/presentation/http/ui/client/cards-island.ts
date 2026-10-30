import { CARDS_BASE_PATH } from "../../base-path";
import { ITEM_ERROR_CLASS, ITEM_META_CLASS } from "@u18/web-ui/kiwa/island-classes";
import {
  ACTION_STATUS,
  ACTIONS_ROW,
  CARD_ID,
  DISABLE_BUTTON,
  RELEASE_BUTTON,
  TARGET_FORM,
  TARGET_INPUT,
  TARGET_SAVE,
  TARGET_STATUS,
} from "../island-hooks";
import { createCardsClient } from "./api-client";
import { type CardActionKind, readCardAction } from "./card-action";
import { CARD_ACTION_COPY, UPDATE_TARGET_COPY } from "./messages";
import { readTargetUpdate } from "./target-update";

/**
 * カード画面のアイランド（#338）。
 *
 * ## 3 本叩く
 *
 * `PUT .../target`（遷移先の変更）、`POST .../disable`（止める）、
 * `POST .../release`（人にゆずる）。**発行は管理者だけなので、
 * 利用者のこの画面には来ない**（運営の画面は `admin-page.tsx`）。
 *
 * **紐づけもここに来ない**（#358）。カードをタップした人が
 * `/account/nfc/claim` の form で登録する —— **JavaScript 無しで通る必要が
 * あるので、島にしていない**（`presentation/http/csrf.ts` に理由）。
 *
 * ## 片道の 2 本には確認を挟む
 *
 * `target` は何度でもやり直せるので確認を出さない。**`disable` は片道で、
 * `release` は戻せるが手放した瞬間に次にタップした人のものになる**
 * （#358 で紐づけコードが無くなった）。**戻せないものに、戻せるものと
 * 同じ形を使わない。**
 *
 * 確認は `window.confirm` —— dashboard-worker の取り消しと同じ作法で、
 * **何が起きるかを書く**（`client/messages.ts`）。
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
    status.className = failed ? ITEM_ERROR_CLASS : ITEM_META_CLASS;
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

/**
 * 片道の操作を繋ぐ（#382）。
 *
 * ## 成功したら読み込み直す
 *
 * **止めると状態が変わり、手放すと一覧から消える。** 島が行を書き換えると、
 * サーバーが描いている形を 2 つ目の実装として持つことになる
 * （`cards-page.tsx` の「操作の入口はサーバーが描く」と同じ理由）。
 *
 * **確認のダイアログで何が起きるかは既に伝えてある**ので、
 * 読み込み直したあとの一覧がそのまま結果になる。
 */
function attachActions(row: HTMLElement): void {
  const cardId = row.getAttribute(CARD_ID);
  const status = row.querySelector<HTMLElement>(`[${ACTION_STATUS}]`);
  if (cardId === null || status === null) return;

  const show = (message: string): void => {
    status.textContent = message;
    status.className = ITEM_ERROR_CLASS;
    // 失敗しか出さない行なので、常に読み上げる。
    status.setAttribute("role", "alert");
  };

  /**
   * @param buildUrl **チェーンをリテラルで書くこと。**
   *   `client[":cardId"][path]` のように変数で組むと、
   *   `test/route-reachability.test.ts` の走査が**入口を見つけられない**
   *   （あれは出荷物の文字列を読む）。実際この形で 1 度落とした ——
   *   **「入口があるのに無いと言われる」ほうに倒れるので、見つかる。**
   */
  const bind = (
    attribute: string,
    action: CardActionKind,
    buildUrl: (cardId: string) => string,
  ): void => {
    const button = row.querySelector<HTMLButtonElement>(`[${attribute}]`);
    // **揃っていなければ何もしない。** 押せるのに効かない状態を作らない。
    if (button === null) return;

    button.addEventListener("click", () => {
      if (!window.confirm(CARD_ACTION_COPY[action].confirm(cardId))) return;

      button.disabled = true;
      void (async () => {
        const response = await fetch(buildUrl(cardId), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          // **本文を送る。** `cards.routes.ts` の門番が `Content-Type` を
          // 見るので、空の POST でも JSON であることを示す必要がある。
          body: "{}",
        });

        const outcome = readCardAction(response, action);
        if (outcome.kind === "done") {
          window.location.reload();
          return;
        }
        show(outcome.message);
        button.disabled = false;
      })().catch(() => {
        // 通信が落ちた。**「押したけど何も起きない」で放置しない。**
        show(CARD_ACTION_COPY[action].failed);
        button.disabled = false;
      });
    });
  };

  bind(DISABLE_BUTTON, "disable", (id) =>
    client[":cardId"].disable.$url({ param: { cardId: id } }).toString(),
  );
  bind(RELEASE_BUTTON, "release", (id) =>
    client[":cardId"].release.$url({ param: { cardId: id } }).toString(),
  );
}

for (const form of document.querySelectorAll<HTMLElement>(`[${TARGET_FORM}]`)) {
  attach(form);
}

for (const row of document.querySelectorAll<HTMLElement>(`[${ACTIONS_ROW}]`)) {
  attachActions(row);
}

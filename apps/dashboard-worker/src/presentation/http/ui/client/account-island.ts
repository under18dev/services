import type { AccountApiErrorCode } from "@u18/contracts";
import {
  supportsPasskey,
  toCreationOptions,
  toResponseJson,
} from "@u18/web-ui/client/webauthn-json";
import { createApiClient } from "./api-client";
import { isRemoved } from "./outcome";

/**
 * アカウント管理画面の取り消し操作（#9 / 仕様書 §14.1 決定 16）。
 *
 * **このファイルだけがブラウザで動く。** 一覧の表示はサーバーが返した
 * HTML だけで成立している（`ui/*-page.tsx`）。JS が要るのは
 * `DELETE` / `PATCH` を送るところだけで、**HTML の form はこれらを送れない**
 * （form が出せるのは GET と POST だけ）。
 *
 * ## 書き込み経路を 2 本持たない（決定 16、決定 4 の延長）
 *
 * `POST /account/sessions/:id/revoke` のような form 用の経路を**作らない。**
 * 作れば JS 無しでも取り消せるが、**同じ操作に認可の入口が 2 つできる。**
 * このリポジトリが繰り返し踏んでいるのは「2 箇所を同期させ続ける」形
 * （#88 / #96 / #122 / #164）で、認可の入口でそれをやると、片方だけ
 * 緩める変更が通る。
 *
 * **代償: 取り消しには JS が要る。** 画面には `<noscript>` でそう書き、
 * JS 無しでもできる代替（全端末からのログアウト）へ案内している。
 *
 * ## ボタンはこのスクリプトが作る
 *
 * サーバーが描いた HTML にボタンは無い。**「押しても効かないボタン」を
 * 作らないため。** JS が無効でも、読み込みに失敗しても、CSP で弾かれても、
 * 結果は同じ「ボタンが出ない」になる。サーバー側で描いて JS で有効化する
 * 形だと、**読み込み失敗のときだけ死んだボタンが残る**（`<noscript>` も
 * 出ない —— あれは JS が無効なときにしか出ない）。
 *
 * ## CSRF
 *
 * 追加のトークンを持たない。サーバーは `Origin` が自分と一致することを
 * 要求する（`app.ts` の `hasTrustedOrigin`）。**同一オリジンでも
 * GET / HEAD 以外には `Origin` が必ず付く**ので、この fetch は通り、
 * 他オリジンからの fetch は付く `Origin` が違うので通らない。
 */

// 組み立ては `api-client.ts`。理由（テストから同じ関数を呼べるように）はそちら。
const client = createApiClient(location.origin);

/**
 * このアイランドが応答から使うものだけ。
 *
 * **`Response` と書かない。** この tsconfig は `worker-configuration.d.ts` を
 * 読んでいる（`DashboardAppType` が `Env` に触れるため）ので、`Response` は
 * workerd のもの（`cf` / `webSocket` を持つ）に解決され、`hc` が返す
 * `ClientResponse` と噛み合わない。
 *
 * 必要なのは `ok` と `json()` だけなので、**そう書く。** どちらの `Response`
 * が見えているかに依存しなくなり、このアイランドが応答の何に頼っているかも
 * 1 行で読める。
 */
type ApiResponse = {
  readonly ok: boolean;
  /** 404 を成功として扱うために要る（`outcome.ts`）。 */
  readonly status: number;
  readonly json: () => Promise<unknown>;
};

/**
 * 失敗したときに出す文言。
 *
 * **`Record<AccountApiErrorCode, string>` にしてある。** 契約側
 * （`packages/contracts/src/errors.ts`）にコードを 1 つ足すと、ここが
 * ビルドで落ちて文言を書くまで通らない。実行時に「知らないコードが来た」で
 * 既定の文言に落ちるのではなく、**足した人の手元で止まる。**
 *
 * auth-worker の `message` は受け取っていない（決定: 文言は表示側の責務）。
 * 英語で利用者向けに書かれていないうえ、通すと「UI が知らなくても何か出る
 * から気づかない」経路ができる。
 */
const MESSAGES: Record<AccountApiErrorCode, string> = {
  unauthenticated: "ログインの有効期限が切れました。ログインし直してください。",
  forbidden: "この操作は許可されていません。",
  // `forbidden` と同じ 403 だが、利用者の次の行動が違う。
  reauthentication_required: "安全のため、もう一度ログインしてからお試しください。",
  conflict: "いまの状態では取り消せません。画面を更新してお試しください。",
  // **この画面では出ない**（404 は成功として扱う。`outcome.ts`）。
  // 契約の網羅を保つために残してある —— 消すと `Record` が埋まらない。
  not_found: "すでに取り消されています。画面を更新してください。",
  invalid_input: "操作を受け付けられませんでした。画面を更新してお試しください。",
  identity_unavailable: "いま処理できません。しばらく待ってからお試しください。",
};

const FALLBACK = "取り消せませんでした。しばらく待ってからお試しください。";

/** 応答の本文から文言を決める。本文が読めなくても必ず何か返す。 */
async function messageFor(response: ApiResponse): Promise<string> {
  try {
    const body = await response.json();
    const code = (body as { error?: unknown } | null)?.error;
    if (typeof code === "string" && code in MESSAGES) {
      return MESSAGES[code as AccountApiErrorCode];
    }
  } catch {
    // 本文が JSON でない（502 の HTML など）。下の既定に落とす。
  }
  return FALLBACK;
}

/**
 * 取り消しの種類。
 *
 * `confirm` の文言を種類ごとに分けている。**「本当によろしいですか」だけ
 * では何が消えるか分からない**ので、消える対象と結果を書く。
 */
type Action = {
  /** `<li>` から ID を読む属性名。 */
  readonly idAttribute: string;
  readonly buttonLabel: string;
  readonly confirm: (label: string) => string;
  readonly send: (id: string) => Promise<ApiResponse>;
};

const ACTIONS: Record<string, Action> = {
  session: {
    idAttribute: "data-session-id",
    buttonLabel: "ログアウト",
    confirm: (label) => `${label} をログアウトします。この端末からは再度ログインが必要になります。`,
    send: (id) => client.account.api.me.sessions[":id"].$delete({ param: { id } }),
  },
  passkey: {
    idAttribute: "data-passkey-id",
    buttonLabel: "削除",
    confirm: (label) =>
      `パスキー「${label}」を削除します。この認証器ではログインできなくなります。`,
    send: (id) => client.account.api.me.passkeys[":id"].$delete({ param: { id } }),
  },
  grant: {
    idAttribute: "data-grant-client-id",
    buttonLabel: "連携を解除",
    confirm: (label) =>
      `${label} との連携を解除します。このアプリはあなたの情報を読めなくなります。`,
    send: (clientId) => client.account.api.me.grants[":clientId"].$delete({ param: { clientId } }),
  },
};

/** 行に文言を出す。既にあれば差し替える。 */
function showError(item: HTMLElement, text: string): void {
  const existing = item.querySelector(".item-error");
  const node = existing ?? document.createElement("p");
  node.className = "item-error";
  node.textContent = text;
  node.setAttribute("role", "alert");
  if (existing === null) item.querySelector(".item-main")?.append(node);
}

/**
 * 行を消す。最後の 1 件なら「ありません」の表示へ差し替える。
 *
 * 画面を再読み込みしない —— 取り消しは複数まとめて行うことがあり、
 * 1 件ごとに先頭へ戻されるとやり直しになる。
 */
function removeItem(item: HTMLElement): void {
  const list = item.parentElement;
  item.remove();
  if (list === null || list.children.length > 0) return;

  const empty = document.createElement("p");
  empty.className = "empty";
  empty.textContent = list.getAttribute("data-empty-text") ?? "ありません。";
  list.replaceWith(empty);
}

function attach(item: HTMLElement, kind: string, action: Action): void {
  const id = item.getAttribute(action.idAttribute);
  if (id === null || id === "") return;

  const button = document.createElement("button");
  button.type = "button";
  button.className = "button button-secondary button-small button-danger";
  button.textContent = action.buttonLabel;

  // 読み上げで「削除」だけが並ばないように、対象を名前で言う。
  const label = item.querySelector(".item-title")?.textContent?.trim() ?? "この項目";
  button.setAttribute("aria-label", `${label} を${action.buttonLabel}`);

  button.addEventListener("click", () => {
    if (!window.confirm(action.confirm(label))) return;

    button.disabled = true;
    const original = button.textContent;
    button.textContent = "処理中…";

    void action
      .send(id)
      .then(async (response) => {
        // 「消えた」の判断は `outcome.ts`（404 を含める理由もそちら）。
        if (isRemoved(response)) {
          // 自分自身のセッションを切った場合はサーバーが Cookie を落として
          // いる。そのまま一覧を触らせても次の操作が全部 401 になるので、
          // ログイン画面へ送る。
          if (kind === "session" && item.getAttribute("data-current") === "true") {
            location.assign("/login");
            return;
          }
          removeItem(item);
          return;
        }
        showError(item, await messageFor(response));
        button.disabled = false;
        button.textContent = original;
      })
      .catch(() => {
        // 通信そのものが失敗した。応答が無いので種類を分けようがない。
        showError(item, FALLBACK);
        button.disabled = false;
        button.textContent = original;
      });
  });

  const actions = document.createElement("div");
  actions.className = "item-actions";
  actions.append(button);
  item.append(actions);
}

for (const [kind, action] of Object.entries(ACTIONS)) {
  for (const item of document.querySelectorAll<HTMLElement>(`li[${action.idAttribute}]`)) {
    attach(item, kind, action);
  }
}

/**
 * パスキーの登録（#306）。
 *
 * ## なぜここに置くか
 *
 * 一覧と削除はこの画面にあったが、**登録だけ入口が無かった。** API
 * （`POST /api/auth/passkeys/register/options` と `/verify`）は auth-worker に
 * 実装済みで、本物の認証器を相手にしたテストも通っていたのに、
 * **呼ぶ UI がどこにも無かった。**
 *
 * ## auth-worker の API を直接叩く
 *
 * 上の取り消し操作は dashboard の BFF（`/account/api/me/*`）を通すが、
 * ここは **auth-worker の `/api/auth/passkeys/*` を直接呼ぶ。**
 *
 * - **同一オリジンである。** 本番は `auth.under18.dev` に両方が載っており
 *   （`/account/*` が dashboard、残りが auth）、`__Host-` のセッション
 *   Cookie はそのまま送られる。CSP も `connect-src 'self'` で通る
 * - **BFF を 1 本増やす理由が無い。** 中継しても challenge を右から左へ
 *   渡すだけで、**同じ操作に入口が 2 つできる**（取り消し経路を 2 本
 *   持たないのと同じ判断）
 *
 * ## ボタンを出さない条件
 *
 * `supportsPasskey()` が false（認証器が無い・`PublicKeyCredential` が無い）
 * なら**最初から描かない。** 押しても `navigator.credentials` が無いので、
 * 出すと必ず失敗するボタンになる。
 */

/** Origin 検証で通る fetch。CSRF トークンは要らない（同一オリジンの POST には Origin が付く）。 */
async function postJson(path: string, body: unknown): Promise<Response> {
  return fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify(body),
  });
}

type RegisterOptionsResponse = {
  readonly challengeId: string;
  readonly options: Record<string, unknown>;
};

/** 登録した 1 件を一覧へ足す。再読み込みしない（取り消しと同じ方針）。 */
function appendPasskey(label: string): void {
  const list = document.querySelector<HTMLElement>("ul[data-empty-text]");
  const empty = document.querySelector<HTMLElement>("p.empty");

  const item = document.createElement("li");
  const main = document.createElement("div");
  main.className = "item-main";
  const title = document.createElement("div");
  title.className = "item-title";
  title.textContent = label;
  const meta = document.createElement("p");
  meta.className = "item-meta";
  meta.textContent = "登録しました。詳細は再読み込みで表示されます。";
  main.append(title, meta);
  item.append(main);

  if (list !== null) {
    list.append(item);
    return;
  }
  // **一覧がまだ無い（0 件だった）。** `<p class="empty">` を一覧へ差し替える。
  if (empty === null) return;
  const created = document.createElement("ul");
  created.className = "list";
  created.setAttribute("data-empty-text", "登録されているパスキーはありません。");
  created.append(item);
  empty.replaceWith(created);
}

function attachRegister(mount: HTMLElement): void {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "button button-secondary";
  button.textContent = "パスキーを登録";

  const status = document.createElement("p");
  status.className = "item-meta";

  const fail = (text: string): void => {
    status.className = "item-error";
    status.setAttribute("role", "alert");
    status.textContent = text;
    button.disabled = false;
    button.textContent = "パスキーを登録";
  };

  button.addEventListener("click", () => {
    button.disabled = true;
    button.textContent = "認証器を待っています…";
    status.textContent = "";
    status.className = "item-meta";
    status.removeAttribute("role");

    void (async () => {
      const optionsResponse = await postJson("/api/auth/passkeys/register/options", {});
      if (!optionsResponse.ok) {
        fail(
          optionsResponse.status === 401
            ? "ログインの有効期限が切れています。ログインし直してください。"
            : "登録を開始できませんでした。しばらくしてからもう一度お試しください。",
        );
        return;
      }

      const { challengeId, options } = (await optionsResponse.json()) as RegisterOptionsResponse;
      const credential = (await navigator.credentials.create({
        publicKey: toCreationOptions(options),
      })) as PublicKeyCredential | null;
      // 利用者が取り消した。エラーにしない。
      if (credential === null) {
        fail("登録を取り消しました。");
        return;
      }

      const label = `${navigator.platform || "この端末"} のパスキー`.slice(0, 64);
      const verify = await postJson("/api/auth/passkeys/register/verify", {
        challengeId,
        response: toResponseJson(credential),
        label,
      });
      if (!verify.ok) {
        fail(
          verify.status === 409
            ? "この認証器は既に登録されています。"
            : "登録を完了できませんでした。もう一度お試しください。",
        );
        return;
      }

      appendPasskey(label);
      button.disabled = false;
      button.textContent = "パスキーを登録";
      status.textContent = "登録しました。";
    })().catch(() => {
      // 認証器が拒否した・利用者が閉じた・通信が落ちた。区別が付かない。
      fail("登録できませんでした。もう一度お試しください。");
    });
  });

  mount.append(button, status);
}

const registerMount = document.querySelector<HTMLElement>("[data-passkey-register]");
if (registerMount !== null && supportsPasskey()) attachRegister(registerMount);

import type { AccountApiErrorCode } from "@u18/contracts";
import type { InvalidUsernameReason } from "@u18/domain";

/**
 * 利用者に出す文言（#9 / #312）。
 *
 * ## なぜアイランドの中に書かないのか
 *
 * **アイランドは DOM を使うので Worker 上の vitest から動かせない。**
 * 文言だけここへ出せば、バンドルされた文字列を正規表現で睨むのではなく
 * **値として直接確かめられる**（`test/island-messages.test.ts`）。
 * `outcome.ts` / `api-client.ts` を出したのと同じ理由である。
 *
 * ## 操作ごとに表を分ける
 *
 * **同じエラーコードでも、操作によって意味が変わる。** 取り消しの
 * `conflict` は「いまの状態では取り消せない」、プロフィール更新の
 * `conflict` は**ユーザー名が既に使われている**である。1 つの表を使い回すと
 * **利用者が次にやるべきことを間違って案内する** —— 「画面を更新して
 * お試しください」は、名前が埋まっている状況では何も解決しない。
 *
 * ## `Record<AccountApiErrorCode, string>` にしてある理由
 *
 * 契約側（`packages/contracts/src/errors.ts`）にコードを 1 つ足すと、
 * **ここがビルドで落ちて文言を書くまで通らない。** 実行時に「知らない
 * コードが来た」で既定の文言に落ちるのではなく、**足した人の手元で止まる。**
 *
 * auth-worker の `message` は受け取っていない（決定: 文言は表示側の責務）。
 * 英語で利用者向けに書かれていないうえ、通すと「UI が知らなくても何か出る
 * から気づかない」経路ができる。
 */

/** 取り消し（ログアウト・パスキー削除・連携解除）。 */
export const REVOKE_MESSAGES: Record<AccountApiErrorCode, string> = {
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

export const REVOKE_FALLBACK = "取り消せませんでした。しばらく待ってからお試しください。";

/**
 * プロフィールの更新（`PATCH /api/me`）。
 *
 * `conflict` に「使えない」以上のことを書かない —— 誰が持っているのか、
 * その相手が有効か停止中か削除済みかを区別できる応答にすると、ユーザー名から
 * アカウントの状態を探る手段になる（仕様書 9。`update-profile.use-case.ts` が
 * 応答側で同じ配慮をしている）。
 */
export const PROFILE_MESSAGES: Record<AccountApiErrorCode, string> = {
  unauthenticated: "ログインの有効期限が切れました。ログインし直してください。",
  forbidden: "この操作は許可されていません。",
  // **ユーザー名の変更にだけ出る。** 表示名の変更では再認証は要らない。
  reauthentication_required:
    "ユーザー名の変更には、もう一度ログインが必要です。ログインし直してからお試しください。",
  conflict: "そのユーザー名は使われています。別の名前をお試しください。",
  // この経路では返らない（更新対象が無ければ `unauthenticated` になる）。
  // 契約の網羅を保つために残してある。
  not_found: "アカウントが見つかりませんでした。ログインし直してください。",
  invalid_input: "入力を受け付けられませんでした。内容を確認してお試しください。",
  identity_unavailable: "いま保存できません。しばらく待ってからお試しください。",
};

export const PROFILE_FALLBACK = "保存できませんでした。しばらく待ってからお試しください。";

/**
 * ユーザー名が使えない理由。
 *
 * **`Record<InvalidUsernameReason, string>` にしてある。** `packages/domain`
 * に理由を 1 つ足すと、ここが埋まるまでビルドが通らない。
 *
 * **判定そのものは書き写していない。** 画面は `Username.reasonFor` を呼ぶので、
 * 規則は `packages/domain` の 1 箇所にしかない。画面で先に弾くのは往復を
 * 減らすためで、**正本はサーバー**（`UpdateProfileUseCase` が同じ VO を通す）。
 */
export const USERNAME_REASONS: Record<InvalidUsernameReason, string> = {
  too_short: "ユーザー名が短すぎます。",
  too_long: "ユーザー名が長すぎます。",
  disallowed_characters:
    "ユーザー名に使えない文字が含まれています。英小文字・数字・_ と - が使えます（記号で始めたり終えたりはできません）。",
  reserved: "このユーザー名は使えません。別の名前をお試しください。",
};

/**
 * 応答の本文から文言を決める。本文が読めなくても必ず何か返す。
 *
 * 表を引数で受け取るのは上記のとおり、**操作ごとに意味が変わる**ため。
 */
export async function messageFor(
  response: { readonly json: () => Promise<unknown> },
  messages: Record<AccountApiErrorCode, string>,
  fallback: string,
): Promise<string> {
  try {
    const body = await response.json();
    const code = (body as { error?: unknown } | null)?.error;
    if (typeof code === "string" && code in messages) {
      return messages[code as AccountApiErrorCode];
    }
  } catch {
    // 本文が JSON でない（502 の HTML など）。下の既定に落とす。
  }
  return fallback;
}

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

/**
 * 退会（`DELETE /api/me`）が失敗したときの文言。
 *
 * **`reauthentication_required` がこの操作の主役である。** 置き忘れた端末で
 * 他人がアカウントを閉じられないよう、auth-worker が直近の本人確認を要求する
 * （`hasFreshAuthentication`）。利用者の手順は「ログインし直してからもう一度」
 * なので、そう書く。
 */
export const CLOSE_MESSAGES: Record<AccountApiErrorCode, string> = {
  unauthenticated: "ログインの有効期限が切れました。ログインし直してください。",
  forbidden: "この操作は許可されていません。",
  reauthentication_required:
    "安全のため、ログインし直してからもう一度お試しください。置き忘れた端末から操作されるのを防ぐためです。",
  // `active` でなかった。既に退会済みか、運用側で停止されている。
  conflict: "このアカウントは既に利用できません。",
  // この経路では返らない（対象が無ければ `unauthenticated` になる）。
  not_found: "アカウントが見つかりませんでした。ログインし直してください。",
  invalid_input: "操作を受け付けられませんでした。画面を更新してお試しください。",
  identity_unavailable: "いま処理できません。しばらく待ってからお試しください。",
};

export const CLOSE_FALLBACK = "退会できませんでした。しばらく待ってからお試しください。";

/**
 * 退会（#318）の文言。**ここ 1 箇所に寄せてある。**
 *
 * ## 何と呼ぶかは決まった（2026-10-30）
 *
 * > 退会に関しては、**退会しましたというふうに**お願いします
 *
 * **こちらが並べた選択肢はどれも「データをどうしたか」の言葉だった** ——
 * 「無効化しました」「削除しました」、あるいは purge まで走らせてから
 * 「削除しました」。返ってきたのはそのどれでもなく、**「利用者との関係が
 * どうなったか」**の言葉だった。
 *
 * **これはランブック §11.7 の原則（実際にやったことだけを言う）と
 * ぶつからない。** 実装は凍結しかしないが、**会員でなくなったことは本当**
 * である。「削除しました」が嘘になるのは個人情報が残るからで、
 * 「退会しました」はその点について何も主張していない。
 *
 * ## 言わないことで嘘になる部分は、引き続き書く
 *
 * **「同じアドレスで登録し直せない」を落とさないこと。** `primary_email`
 * が残って一意制約で弾かれる以上、**「退会しました」とだけ言って再登録
 * できると思わせるのは、言葉を変えても同じ嘘**になる。
 *
 * ## なぜ 1 箇所なのか
 *
 * 画面・確認ダイアログ・完了文に散らすと、**片方だけ古い言葉で残る。**
 * この PR は元々「無効化」で書かれていて、決まった後に 5 箇所（ここ 4 つと
 * `CLOSE_FALLBACK`）を同時に直している。**1 箇所に寄せていなければ、
 * どれかが「無効化」のまま出ていた。**
 */
export const CLOSE_ACCOUNT_COPY = {
  panelTitle: "退会する",
  /**
   * **何が起きて、何が起きないかを両方書く。**
   *
   * 「同じアドレスで登録し直せない」は隠さない —— `primary_email` が
   * 残って一意制約で弾かれるので、管理者が §11.6 を回すまでそうである。
   */
  panelDescription:
    "退会すると、ログインできなくなり、すべての端末からログアウトされます。登録した表示名・ユーザー名・メールアドレスは残るため、同じメールアドレスで登録し直すことはできません。元に戻すには問い合わせが必要です。",
  buttonLabel: "退会する",
  /**
   * 確認。**ここにも再登録できないことを書く。**
   *
   * パネルの説明を読まずにボタンを押す人がいる。**押す直前にもう一度
   * 言わないと、いちばん戻れない条件だけが読まれないまま通る。**
   */
  confirm:
    "退会します。ログインできなくなり、すべての端末からログアウトされます。同じメールアドレスで登録し直すことはできません。元に戻すには問い合わせが必要です。",
  /** 完了。**「削除しました」とは言わない。** 個人情報は残っているため。 */
  done: "退会しました。ログイン画面へ移動します。",
} as const;

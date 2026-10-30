/**
 * 画面に出す文言（#338）。
 *
 * **1 箇所に寄せる。** dashboard-worker の `CLOSE_ACCOUNT_COPY` と同じ形で、
 * アイランドの各所に散らすと**同じことを別の言い方で伝える**状態になる。
 * 後から言い回しを変えるときも、ここだけを見ればよい。
 *
 * **DOM に触れない。** だからテストから直接引ける。
 */

/**
 * 遷移先が弾かれた理由（`domain/services/target-url.ts` の `TargetUrlRejection`）。
 *
 * **ここだけは理由を具体的に出す。** `cards.routes.ts` の `bodyFor()` が
 * `invalid_target_url` にだけ `reason` を載せているのは、**所有者本人が
 * 自分の入力を直せる場合だけ詳細を返す**という判断による。その判断を
 * 画面側で薄めない。
 */
export const TARGET_REJECTION_COPY: Readonly<Record<string, string>> = {
  not_absolute: "URL は https:// から始まる絶対 URL で入力してください。",
  too_long: "URL が長すぎます。短いものをお使いください。",
  not_https: "https:// の URL だけを設定できます。",
  has_credentials: "URL にユーザー名やパスワードを含めることはできません。",
  non_default_port: "ポート番号付きの URL は設定できません。",
  private_host: "このホスト名は設定できません（内部向けのアドレスです）。",
  blocked_host: "このホスト名は設定できません。",
};

/**
 * 理由が分からないときの文言。
 *
 * **`reason` が知らない値でも、黙って握り潰さない。** サーバー側に理由が
 * 増えたとき、画面が**何も言わずに汎用の失敗へ畳む**と、利用者は自分の
 * 入力のどこが悪いのか分からないまま同じ操作を繰り返す。
 */
export const TARGET_REJECTED_FALLBACK = "この URL は設定できません。";

/** 遷移先の変更にまつわる文言。 */
export const UPDATE_TARGET_COPY = {
  /** 成功。 */
  done: "遷移先を変更しました。",
  /** セッションが切れた。ログインし直す以外にできることが無い。 */
  unauthenticated: "ログインの有効期限が切れています。ログインし直してください。",
  /** 他人のカード、または存在しないカード。**どちらかを言い分けない。** */
  notFound: "このカードは見つかりません。",
  /** auth-worker が落ちている。利用者には待つ以外にできることが無い。 */
  unavailable: "しばらくしてからもう一度お試しください。",
  /** 想定していない応答。**「成功したかもしれない」と思わせない。** */
  unknown: "変更できませんでした。もう一度お試しください。",
} as const;

/**
 * 片道の操作の文言（#382）。
 *
 * ## 確認に「本当によろしいですか」と書かない
 *
 * dashboard-worker の `ACTIONS` と同じ方針で、**何が起きるかを書く。**
 * 「本当によろしいですか」だけでは、押す人は**何を失うのか分からないまま
 * 判断する**ことになる。
 *
 * ## 2 つは戻せ方が違う。文言も分ける
 *
 * **止める**のは片道で、本人には戻す手段が無い。
 * **ゆずる**のは戻せるが、**手放した瞬間に次にタップした人のものになる**
 * （#358 で紐づけコードが無くなった）。**「あとで取り消せる」と読ませない。**
 *
 * ## `confirm` の文面に Markdown を書かないこと
 *
 * `window.confirm` はネイティブのダイアログで、**`**強調**` はそのまま
 * アスタリスクとして出る。** このファイルの他の文言（画面に出すもの）とは
 * 扱いが違う。改行は `\n` で入れる。
 */
export const CARD_ACTION_COPY = {
  disable: {
    label: "このカードを止める",
    /** @param cardId 押す前に、どのカードかを見せる。 */
    confirm: (cardId: string) =>
      `カード ${cardId} を止めます。\n\n` +
      "タップしてもどこへも飛ばなくなります。\n" +
      "自分では元に戻せません。戻すには運営への連絡が必要です。",
    failed: "このカードを止められませんでした。もう一度お試しください。",
  },
  release: {
    label: "人にゆずる",
    confirm: (cardId: string) =>
      `カード ${cardId} を手放します。\n\n` +
      "あなたのものではなくなり、次にタップした人のものになります。\n" +
      "設定していた遷移先も消えます。\n\n" +
      "渡す相手が決まっていて、いま手渡せるときだけ実行してください。",
    failed: "このカードを手放せませんでした。もう一度お試しください。",
  },
} as const;

/** 片道の操作に共通の失敗。`UPDATE_TARGET_COPY` と同じ語彙に揃える。 */
export const CARD_ACTION_SHARED_COPY = {
  unauthenticated: UPDATE_TARGET_COPY.unauthenticated,
  notFound: UPDATE_TARGET_COPY.notFound,
  unavailable: UPDATE_TARGET_COPY.unavailable,
} as const;

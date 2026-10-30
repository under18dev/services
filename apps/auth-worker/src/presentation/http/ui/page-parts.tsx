import type { FC } from "hono/jsx";

/**
 * auth-worker の画面が共有する小さな部品（#332 の P2）。
 *
 * **ここに置いてあるのは「2 つ以上の画面が同じ見た目で出すもの」だけ**で、
 * `@u18/web-ui/kiwa/island-classes` が Worker をまたぐものを持っているのと
 * 同じ切り分けである。違いは**使う側がこの Worker の中にしかいない**こと。
 *
 * ## なぜ文字列を写さずに部品にしたか
 *
 * ログイン画面と同意画面の両方が「枠付きの赤い 1 行」を出す。class を
 * 両方に書くと**片方だけ直される**し、写し間違えても誰も言わない ——
 * `kiwa-stylesheet.test.ts` は「CSS に無い class」を見るので、
 * **両方に CSS のある class が揃っていれば、見た目が違っても緑**である。
 * `island-classes.ts` が「目で写した 7 本のうち 4 本が外れた」と書いている
 * のと同じ話で、あちらが突き合わせの検査で塞いでいるのに対し、
 * こちらは**そもそも 1 つしか無い**形にした（島ではないので、できる）。
 */

/**
 * 失敗の文言。**読み上げへ届かせるため `role="alert"` と対で使う。**
 *
 * 文言そのものは中立に保つこと —— ログイン画面では「そのアドレスは
 * 登録されていない」と読める書き方が列挙の材料になり、同意画面では
 * 入力された文字列をそのまま戻すと反射型のコンテンツ注入になる。
 */
export const ErrorMessage: FC<{ message: string | null }> = ({ message }) =>
  message === null ? null : (
    <p
      class="rounded-lg border border-destructive/40 bg-background-subtle px-3 py-2.5 text-sm text-destructive"
      role="alert"
    >
      {message}
    </p>
  );

/**
 * 画面の下に置く案内のリンク（手書き CSS の `.links`）。
 *
 * 下線は `[&_a]` で子の `<a>` へ当てる。**リンク側に class を書かない**の
 * は、文中に 2 本目のリンクが足されたときに片方だけ素のままになるため。
 */
export const LINK_TEXT_CLASS =
  "text-sm text-foreground-muted [&_a:hover]:text-foreground [&_a]:underline [&_a]:underline-offset-4";

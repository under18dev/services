/**
 * 画面が吐いた class と、配信する CSS を突き合わせるための道具（#332 / #338）。
 *
 * ## なぜ共有しているのか
 *
 * dashboard-worker と nfc-worker が**別々に Tailwind を走らせている**
 * （走査対象が違うので出力も違う）。検査は両方に要るが、**中身を 2 つ
 * 持つと片方だけ間違う。**
 *
 * 実際に間違えた。最初は各 Worker に書いていて、`classesIn` が
 * `&amp;` しか戻していなかった —— hono/jsx は `>` も `&gt;` にするので、
 * `[&>a]:underline` のようなクラスが**「CSS に無い」と誤報する。**
 * dashboard 側は**たまたま緑だった**（`>` を含む class を持つ primitive
 * が、あの画面では描かれない枝にしかなかった）。
 *
 * **片方だけが落ちて、もう片方は黙っている。** このリポジトリが
 * 繰り返している形なので、1 つに寄せた。
 *
 * ## 何を防いでいるか
 *
 * #320 は、インライン `style=` が CSP に捨てられて**本番でだけ**見た目が
 * 崩れた事故だった。Tailwind でも同じ形が作れる —— `@theme` にトークンが
 * 無い / `@source` の走査から漏れた / 綴りを間違えた、どれも
 * **class は HTML に出るのに CSS が無い**で、静かに効かないだけである。
 */

/**
 * HTML の属性値に入った実体参照を戻す。
 *
 * **`&amp;` を最後に戻す。** 先に戻すと `&amp;gt;`（文字どおりの
 * `&gt;`）まで `>` になり、**元に無かった文字を作る。**
 */
function decodeAttribute(value: string): string {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&amp;", "&");
}

/**
 * `md:w-64` -> `.md\:w-64`。
 *
 * Tailwind の出力では class 名がセレクタに**そのまま**入り、
 * `:` `/` `[` `.` のような記号は `\` で逃がされる。同じ逃がし方をして
 * `.` を頭に付ける。
 *
 * **CSS を構文解析していない。** 将来 Tailwind が出力の形を変えたら
 * ここは誤検知しうる。そのときは「落ちた」側から気づける。
 */
export function classSelector(name: string): string {
  return `.${name.replace(/[^A-Za-z0-9_-]/g, (ch) => `\\${ch}`)}`;
}

/** HTML が使っている class を、重複を畳んで返す。 */
export function classesIn(html: string): readonly string[] {
  const raw = [...html.matchAll(/class="([^"]*)"/g)].flatMap((m) => (m[1] ?? "").split(/\s+/));
  return [...new Set(raw.filter(Boolean).map(decodeAttribute))];
}

/** `html` が使っていて `css` に無い class。空なら全部ある。 */
export function classesMissingFrom(html: string, css: string): readonly string[] {
  return classesIn(html).filter((name) => !css.includes(classSelector(name)));
}

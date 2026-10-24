/**
 * JSONC（コメントと末尾カンマを許す JSON）を素の JSON として読む。
 *
 * `wrangler.jsonc` をテストから読むためだけのもの。**文字列の中は触らない**
 * ようにしてあるのが肝で、素朴な正規表現で `//` を消すと
 * `"http://localhost:8787"` のような値が壊れる（このファイルには実際にある）。
 */
export function parseJsonc(source: string): unknown {
  let out = "";
  let i = 0;

  while (i < source.length) {
    const ch = source[i];

    if (ch === '"') {
      // 文字列はそのまま写す。エスケープされた引用符で抜けないこと。
      out += ch;
      i += 1;
      while (i < source.length) {
        out += source[i];
        if (source[i] === "\\") {
          out += source[i + 1] ?? "";
          i += 2;
          continue;
        }
        if (source[i] === '"') {
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }

    if (ch === "/" && source[i + 1] === "/") {
      while (i < source.length && source[i] !== "\n") i += 1;
      continue;
    }

    if (ch === "/" && source[i + 1] === "*") {
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }

    out += ch;
    i += 1;
  }

  // 末尾カンマを落とす。ここまで来ればコメントは消えているので、
  // 「閉じ括弧の直前のカンマ」だけを見ればよい。
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

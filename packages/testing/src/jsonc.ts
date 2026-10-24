/**
 * JSONC（コメントと末尾カンマを許す JSON）を素の JSON として読む。
 *
 * `wrangler.jsonc` をテストから検査するためにある。**設定とコードのずれは
 * 型でもテストでも止まらず、デプロイするまで表に出ない。**
 *
 *  - `ratelimits` を `env.production` に書き忘れると、本番だけ binding が
 *    無く 429 ではなく 500 になる（#21）
 *  - route の接頭辞とハンドラのパスがずれると、本番で 1 つも叩けない（#106）
 *
 * どちらも設定そのものを読んで突き合わせるしか止める手が無く、そのために
 * パーサが要る。auth-worker と dashboard-worker の両方が使うのでここに置く。
 *
 * **文字列の中は触らない**ようにしてあるのが肝。素朴な正規表現で `//` を
 * 消すと `"http://localhost:8787"` のような値が壊れる（wrangler.jsonc に
 * 実在する）。
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

/**
 * `minimumReleaseAge` の設定を読む（#101）。
 *
 * ## なぜ検査が要るのか
 *
 * **除外リストだけが置いてあり、肝心の `minimumReleaseAge` がどこにも
 * 無かった。** 何からも除外されていない除外リスト、という状態である。
 * インストールは通るし CI も緑なので、**誰も気づかないまま
 * 「release age の対策は入れてある」と読める。**
 *
 * このリポジトリで繰り返している「宣言はあるが発動しない」
 * （#88 / #96 / #122 / #164 / #236）と同じ形で、しかも**普通の検査では
 * 絶対に捕まらない** —— 設定が無くても何も落ちないからである。
 * だから設定そのものを見る。
 *
 * ## YAML パーサを足していない
 *
 * `pnpm-workspace.yaml` のこの部分はスカラ 1 つと文字列のリストだけで、
 * ネストもアンカーも無い。`shell-exit-status.mjs` が `run:` ブロックを
 * 行で拾っているのと同じ理由で、依存を 1 つ増やすほどではない。
 */

/**
 * `pnpm-workspace.yaml` から release age の設定を取り出す。
 *
 * @param {string} source
 * @returns {{ minimumReleaseAge: number | null, exclude: string[] }}
 */
export function parseReleaseAgePolicy(source) {
  const lines = source.split("\n");

  /** @type {number | null} */
  let minimumReleaseAge = null;
  /** @type {string[]} */
  const exclude = [];
  let inExclude = false;

  for (const line of lines) {
    const age = /^minimumReleaseAge:\s*(\d+)\s*(?:#.*)?$/.exec(line);
    if (age?.[1] !== undefined) {
      minimumReleaseAge = Number(age[1]);
      inExclude = false;
      continue;
    }

    if (/^minimumReleaseAgeExclude:\s*(?:#.*)?$/.test(line)) {
      inExclude = true;
      continue;
    }

    if (inExclude) {
      const item = /^\s+-\s*"?([^"#]+?)"?\s*(?:#.*)?$/.exec(line);
      if (item?.[1] !== undefined) {
        exclude.push(item[1]);
        continue;
      }
      // インデントのある行が続く限りリストの中。それ以外で抜ける。
      if (line.trim() !== "") inExclude = false;
    }
  }

  return { minimumReleaseAge, exclude };
}

/**
 * 除外に書かれた名前が、実際にツリーにあるか。
 *
 * **死んだ除外を溜めない。** 依存を消したのに除外を残すと、次に同じ名前の
 * パッケージが入ったとき**黙って守りが外れる。** これは #101 の逆向きで、
 * あちらは「除外だけあって本体が無い」、こちらは「除外だけ残って対象が無い」。
 *
 * @param {string[]} exclude 除外に書かれた名前（バージョン指定を含みうる）
 * @param {string} lockfile `pnpm-lock.yaml` の中身
 * @returns {string[]} ツリーに見つからなかった名前
 */
export function findStaleExclusions(exclude, lockfile) {
  return exclude.filter((entry) => {
    // `name@version` 形式ならバージョンまで含めて探す。バレ名なら名前だけ。
    const name = entry.startsWith("@")
      ? entry.split("@").slice(0, 2).join("@")
      : (entry.split("@")[0] ?? entry);
    // lockfile では `  name@version:` の形で現れる。
    return !lockfile.includes(`${name}@`);
  });
}

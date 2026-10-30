// @ts-check

/**
 * ダッシュボードのアプリカタログ（`ui/app-catalog.ts`）が書いている
 * **`/` 始まりの行き先が、本当にどれかの Worker に届くか**を突き合わせる。
 *
 * ## なぜ要るのか
 *
 * カタログの `/account/nfc` は **dashboard-worker の画面ではない。**
 * 答えるのは nfc-worker で、あちらの `wrangler.jsonc` に
 * `auth.under18.dev/account/nfc` という production route があるから届く。
 *
 * **つまり 2 つのリポジトリ内 Worker にまたがった手書きの一致である。**
 * nfc 側が route を動かしても dashboard 側のテストは落ちない ——
 * `route-inventory.test.ts` は自分の Worker に登録したルートしか見ず、
 * `ui-pages.test.ts` の「サイドバーの行き先がすべて実在する」は
 * **サイドバーの href しか見ない**（カタログの url は通らない）。
 *
 * **#211 と同じ家系である。** auth-worker の CSS を dashboard が借りて
 * いて、両側のテストが自分の Worker の内側に閉じていたせいで、
 * ハッシュ化した瞬間に片方が 404 を踏んだ。`asset-paths.ts` にその顛末が
 * 長々と書いてあるファイルで、同じ形を 1 件増やしている。
 *
 * ## route を覆っているかだけでは足りない
 *
 * **最初にそう書いて、検査が素通りした。** `/account/nfc` は
 * dashboard-worker 自身の `auth.under18.dev/account/*` にも一致するので、
 * nfc 側が route を `/account/tag` へ動かしても「どれかが覆っている」は
 * 成り立ったままだった。**守りたいものを一度も守っていない検査**である。
 *
 * Cloudflare は**最長の pattern を選ぶ**（nfc の `wrangler.jsonc` にも
 * 「こちらのほうが dashboard の `/account/*` より長いので、両方に一致する
 * パスはこちらへ来る」と書いてある）。なので 2 段で見る:
 *
 *  1. production の route のうち**どれが勝つか**を決め、その Worker を得る
 *  2. **その Worker の `test/route-inventory.ts` にそのパスがあるか**を見る
 *
 * 2 が要るのは、route が届いても Worker 側に登録が無ければ 404 だからで
 * ある。nfc が route を動かすと勝者が dashboard-worker へ移り、あちらの
 * 一覧に `/account/nfc` は無いので落ちる。`route-inventory.ts` は
 * **実行時のルートと突き合わせ済み**（#275）なので、一覧を正本にしてよい。
 *
 * ## 何と何を突き合わせるか
 *
 * - **カタログ側**: `app-catalog.ts` の `APP_CATALOG` にある `url` のうち
 *   `/` 始まりのもの。`https://` の外部リンクは対象外 —— あれは他人の
 *   ホストで、こちらの `wrangler.jsonc` には出てこない。
 * - **route 側**: 全 Worker の **production env** の route pattern。
 * - **登録側**: 勝った Worker の `test/route-inventory.ts`。
 *
 * ## 0 件は故障として扱う
 *
 * カタログが空になるのは設計上ありうる（画面は「まだありません」を出す）。
 * **だが「読めたが 0 件」と「読めなかったので 0 件」は別物**なので、
 * 解析に失敗したら `null` を返して呼び出し側に落とさせる。
 */

/**
 * `APP_CATALOG` の配列リテラルから `url` を拾う。
 *
 * **TypeScript を実行せずに読む。** 他の検査（`asset-probe-pages.mjs` が
 * `route-inventory.ts` を読むのと同じ）に揃えてある。トランスパイルを
 * 挟むと、検査が壊れたのかコードが壊れたのかが分かれなくなる。
 *
 * @param {string} text `app-catalog.ts` の中身
 * @returns {string[] | null} 読めなければ `null`
 */
export function readCatalogUrls(text) {
  const block = /export const APP_CATALOG[^=]*=\s*\[([\s\S]*?)\n\];/.exec(text);
  if (block === null) return null;

  const body = block[1];
  // 要素が 1 つも無い（`[]`）のは正当な状態。空配列として返す。
  if (body.trim() === "") return [];

  const urls = [...body.matchAll(/^\s*url:\s*([A-Za-z_$][\w$]*|"([^"]*)")\s*,/gm)].map(
    ([, raw, quoted]) => (quoted === undefined ? { identifier: raw } : { literal: quoted }),
  );

  // **要素の数と url の数が合わなければ読めていない。** `id:` を数えて
  // 突き合わせる。片方だけ拾えた状態で通すと、拾い漏れた行が
  // 「検査対象ゼロ」として静かに抜ける。
  const entryCount = [...body.matchAll(/^\s*id:\s*"/gm)].length;
  if (entryCount === 0 || urls.length !== entryCount) return null;

  /** @type {string[]} */
  const resolved = [];
  for (const u of urls) {
    if ("literal" in u) {
      resolved.push(u.literal);
      continue;
    }
    // `url: NFC_CARDS_PATH` のような定数参照。`asset-paths.ts` 側で
    // 解決するので、ここでは名前を返して呼び出し側に引かせる。
    resolved.push(`@${u.identifier}`);
  }
  return resolved;
}

/**
 * `asset-paths.ts` から `export const NAME = "..."` を拾う。
 *
 * **テンプレートリテラルで組んだものは拾わない。** `${ACCOUNT_BASE_PATH}`
 * のような形は、この Worker 自身の画面であって別 Worker 宛てではない。
 * カタログが参照するのは別 Worker 宛ての素のリテラルだけなので、
 * 拾えないものは呼び出し側が「解決できない」として落とす。
 *
 * @param {string} text
 * @returns {Record<string, string>}
 */
export function readStringConstants(text) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const [, name, value] of text.matchAll(
    /^export const ([A-Z][A-Z0-9_]*)\s*=\s*"([^"]*)"\s*;/gm,
  )) {
    out[name] = value;
  }
  return out;
}

/**
 * route pattern がそのパスに届くか。
 *
 * pattern は `host/path` か `host/path/*`。ホスト部分は見ない ——
 * カタログの url はパスだけで、どのホストで開くかは利用者のいる
 * オリジンが決める。**同じパスを別ホストが持っていてもよい。**
 *
 * @param {string} pattern
 * @param {string} path
 */
export function patternCovers(pattern, path) {
  const slash = pattern.indexOf("/");
  if (slash === -1) return false;
  const patternPath = pattern.slice(slash);

  if (patternPath === "/*") return true;
  if (patternPath.endsWith("/*")) {
    const prefix = patternPath.slice(0, -2);
    return path === prefix || path.startsWith(`${prefix}/`);
  }
  return patternPath === path;
}

/**
 * そのパスに答える Worker を決める。**Cloudflare は最長の pattern を選ぶ。**
 *
 * 長さが並んで Worker が割れたら、どちらが勝つかをここで決めない
 * （`ambiguous`）。**推測して通すと、推測が外れたときに検査が「問題なし」
 * と言う。** 呼び出し側が落とす。
 *
 * @param {{worker: string, pattern: string}[]} routes
 * @param {string} path
 * @returns {{worker: string, pattern: string} | {ambiguous: string[]} | null}
 */
export function resolveOwner(routes, path) {
  const matches = routes.filter((r) => patternCovers(r.pattern, path));
  if (matches.length === 0) return null;

  const longest = Math.max(...matches.map((r) => r.pattern.length));
  const top = matches.filter((r) => r.pattern.length === longest);
  const workers = [...new Set(top.map((r) => r.worker))];

  return workers.length > 1 ? { ambiguous: workers.sort() } : top[0];
}

/**
 * `route-inventory.ts` から GET のパスを拾う。
 *
 * メソッドは見ない —— カタログのリンクはブラウザの GET だが、一覧の
 * 書き方（`{ method: "GET", path: "..." }`）に依存して正規表現を
 * 複雑にするより、**パスが登録されているか**だけを見るほうが壊れにくい。
 * パスがあってメソッドが違う状況はこのリポジトリに無い。
 *
 * @param {string} text
 * @returns {string[]}
 */
export function readInventoryPaths(text) {
  return [...text.matchAll(/path:\s*"([^"]*)"/g)].map((m) => m[1]);
}

/**
 * `ACCOUNT_NAV_GROUPS` から `href` を拾う（#338）。
 *
 * **カタログと同じ罠にかかる 2 本目のリストである。** サイドバーの
 * `/account/nfc` に答えるのは nfc-worker で、dashboard-worker の
 * テストは何も言わない。あちらが route を動かした瞬間、ダッシュボードの
 * サイドバーに 404 のリンクが並ぶ。
 *
 * **`readCatalogUrls` と違い定数参照を解かない。** 並びは
 * `@u18/contracts` にあり、Worker ごとの接頭辞から組み立てられない
 * （持ち主が 2 人いる）ので、**値は必ずリテラルで書かれている。**
 * 定数参照が現れたら、それは「組み立ててしまった」ということなので、
 * ここで拾えずに 0 件になる —— 下の「0 件は読めていない」が落とす。
 *
 * @param {string} text `account-nav.ts` の中身
 * @returns {string[] | null} 読めなければ `null`
 */
export function readNavHrefs(text) {
  const block = /export const ACCOUNT_NAV_GROUPS[^=]*=\s*\[([\s\S]*?)\n\];/.exec(text);
  if (block === null) return null;

  const hrefs = [...block[1].matchAll(/href:\s*"([^"]*)"/g)].map((m) => m[1]);
  const keys = [...block[1].matchAll(/key:\s*"([^"]*)"/g)].length;

  // **項目の数と href の数が合わなければ読めていない。** 書き方が
  // 変わって片方だけ拾えなくなると、**検査は緑のまま本番だけが 404**
  // を出す（`readCatalogUrls` と同じ理由）。
  if (keys === 0 || hrefs.length !== keys) return null;

  return hrefs;
}

/**
 * 突き合わせ本体。
 *
 * @param {string[]} paths カタログの `/` 始まりの url
 * @param {{worker: string, pattern: string}[]} routes 全 Worker の production route
 * @param {(worker: string) => string[] | null} inventoryOf その Worker の
 *   登録済みパス。読めなければ `null`。
 * @returns {{path: string, reason: string}[]} 届かないものと、その理由
 */
export function unreachablePaths(paths, routes, inventoryOf) {
  const problems = [];

  for (const path of paths) {
    const owner = resolveOwner(routes, path);

    if (owner === null) {
      problems.push({ path, reason: "no production route covers it" });
      continue;
    }
    if ("ambiguous" in owner) {
      problems.push({
        path,
        reason:
          `two Workers (${owner.ambiguous.join(", ")}) have equally specific routes, so which ` +
          `one answers is not decidable from the configuration`,
      });
      continue;
    }

    const registered = inventoryOf(owner.worker);
    if (registered === null) {
      problems.push({
        path,
        reason: `"${owner.pattern}" sends it to ${owner.worker}, but that Worker's test/route-inventory.ts could not be read`,
      });
      continue;
    }
    if (!registered.includes(path)) {
      problems.push({
        path,
        reason:
          `"${owner.pattern}" sends it to ${owner.worker}, but ${owner.worker} does not register ` +
          `it (not in its test/route-inventory.ts), so it 404s`,
      });
    }
  }

  return problems;
}

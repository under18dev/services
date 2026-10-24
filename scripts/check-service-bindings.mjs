/**
 * Service Binding の宛先が、同じ env でデプロイされる Worker の名前と
 * 一致しているかを静的に検査する（#57 の項目 2 / #42）。
 *
 * ## なぜ要るのか
 *
 * `wrangler deploy --dry-run` はリモートを一切参照しないので、
 * `services[].service` が存在しない Worker を指していても正常終了する。
 * #42 はまさにこれで、本番の dashboard-worker が `u18-auth-production`
 * ではなく `u18-auth` を指していた。発見経路はレビューであって CI ではない。
 *
 * この取り違えは静かに壊れる。本番の dashboard が development 設定の
 * auth-worker に繋がり、OTP がログに出て、Cookie から __Host- と Secure
 * が外れる。どちらの Worker も「正常に」起動するので気づけない。
 *
 * ## なぜ名前を自前で組み立てないのか
 *
 * `wrangler deploy --env production` は Worker 名を `<name>-<env>` に
 * 派生させる。ただしこれは既定の規則にすぎず、env ブロックに明示的な
 * `name` を書けばそちらが優先される。
 *
 * ここで `"u18-auth-production"` という literal を書いたり、自分で
 * `name + "-" + env` を組み立てたりすると、将来 env.production に
 * 明示 `name` が足された瞬間に、**検査だけが古い前提のまま緑を返す**。
 * 検査が壊れたことは誰にも見えない。
 *
 * そうならないよう、名前の解決は wrangler 自身の `unstable_readConfig`
 * に任せる。deploy が使うのと同じ解決器なので、規則が変わっても追従する。
 *
 * ## wrangler の解決には各アプリの node_modules を使う
 *
 * wrangler はルートの devDependency ではなく各アプリが持っている。
 * ルートに別途足すとバージョンがずれ、「deploy とは違う wrangler で
 * 検査する」状態になりうるので、アプリ自身が持つものを解決して使う。
 */
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { readdirSync, existsSync } from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const appsDir = path.join(repoRoot, "apps");

/**
 * このリポジトリの外にある Worker への Service Binding をここに書く。
 *
 * 空のまま運用する前提で、「宛先はすべてこのリポジトリ内に存在する」を
 * 不変条件として扱う。外部 Worker を束縛するときだけ、なぜ外部なのかを
 * 添えて足すこと。素通しにしないのは、`u18-auth-prod` のような
 * どのワーカーにも一致しない typo を黙って通さないため。
 */
const EXTERNAL_SERVICES = new Set();

/** apps/ 配下の Worker 設定をすべて拾う。列挙しないのは Worker が増えたときに漏らさないため。 */
function findWorkerConfigs() {
  if (!existsSync(appsDir)) return [];
  return readdirSync(appsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => ({ app: e.name, config: path.join(appsDir, e.name, "wrangler.jsonc") }))
    .filter((w) => existsSync(w.config));
}

/** アプリ自身の node_modules から wrangler を読む。 */
function loadWrangler(appDir) {
  const require = createRequire(pathToFileURL(path.join(appDir, "_")).href);
  return import(pathToFileURL(require.resolve("wrangler")).href);
}

const workers = findWorkerConfigs();

if (workers.length === 0) {
  // glob が外れただけなのに「問題なし」と報告してしまうのが一番まずい。
  console.error(
    "::error::No apps/*/wrangler.jsonc found, so no service binding was checked. This is a bug in the check, not a clean repository.",
  );
  process.exit(1);
}

/** env 名 -> (Worker 名 -> そのデプロイ元アプリ) */
const deployedNames = new Map();
/** { app, env, binding, service, entrypoint } の一覧 */
const bindings = [];

for (const { app, config } of workers) {
  const appDir = path.join(appsDir, app);
  const wrangler = await loadWrangler(appDir);

  // 宣言されている env を列挙する。production を決め打ちにすると、
  // 将来 staging を足したときにそこだけ検査されない。
  const raw = wrangler.experimental_readRawConfig({ config });
  const envNames = Object.keys(raw.rawConfig?.env ?? {});

  for (const env of [undefined, ...envNames]) {
    const resolved = wrangler.unstable_readConfig({ config, env });
    const envKey = env ?? "(default)";

    if (!deployedNames.has(envKey)) deployedNames.set(envKey, new Map());
    deployedNames.get(envKey).set(resolved.name, app);

    for (const s of resolved.services ?? []) {
      bindings.push({
        app,
        env: envKey,
        binding: s.binding,
        service: s.service,
        entrypoint: s.entrypoint,
      });
    }
  }
}

console.log(`Resolved deployed Worker names (via wrangler's own config resolver):`);
for (const [env, names] of deployedNames) {
  for (const [name, app] of names) {
    console.log(`  ${env.padEnd(12)} ${app.padEnd(18)} -> ${name}`);
  }
}
console.log("");

let failures = 0;

for (const b of bindings) {
  const label = `${b.app} (env ${b.env}) binding ${b.binding}`;

  if (EXTERNAL_SERVICES.has(b.service)) {
    console.log(`  ${label}: "${b.service}" is an allow-listed external Worker; skipped.`);
    continue;
  }

  const sameEnv = deployedNames.get(b.env);
  if (sameEnv?.has(b.service)) {
    console.log(`  ${label}: "${b.service}" OK`);
    continue;
  }

  // 宛先が「別の env の名前」に一致するなら、それは #42 と同じ取り違え。
  // どの env と取り違えたのかまで出す。これを出さないと、読んだ人は
  // 正しい名前を自分で導出する羽目になり、そこでまた間違える。
  const otherEnv = [...deployedNames.entries()].find(
    ([env, names]) => env !== b.env && names.has(b.service),
  );

  if (otherEnv) {
    const [wrongEnv] = otherEnv;
    const expected = [...sameEnv.entries()].find(([, app]) => app === otherEnv[1].get(b.service));
    failures++;
    console.error(
      `::error::${label} points at "${b.service}", which is the name that Worker gets in the "${wrongEnv}" environment, not "${b.env}". ` +
        (expected
          ? `Use "${expected[0]}".`
          : `That Worker has no name in the "${b.env}" environment.`) +
        ` A deploy succeeds either way and both Workers boot, so nothing fails until the wrong one serves traffic (#42).`,
    );
    continue;
  }

  failures++;
  console.error(
    `::error::${label} points at "${b.service}", which is not a Worker deployed from this repository in the "${b.env}" environment. ` +
      `Known names: ${[...(sameEnv?.keys() ?? [])].join(", ") || "(none)"}. ` +
      `If this is intentional, add it to EXTERNAL_SERVICES in scripts/check-service-bindings.mjs with a reason.`,
  );
}

console.log("");

if (bindings.length === 0) {
  // 「宛先ゼロ件なので全件一致」で緑にしない。検査しなかったことを明示する。
  console.log("No service bindings are declared in any worker. Nothing to check.");
} else if (failures === 0) {
  console.log(
    `All ${bindings.length} service binding(s) point at a Worker deployed from this repository.`,
  );
}

process.exit(failures === 0 ? 0 : 1);

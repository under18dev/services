// @ts-check
/**
 * `RP_ID` と `WEBAUTHN_ORIGIN` が噛み合っているかを、全 Worker の全 env で見る。
 *
 * 判定そのものは `lib/webauthn-origin.mjs`（理由もそちらに書いた）。
 * ここは設定を集めて回すだけ。
 */
import { checkWebAuthnVars } from "./lib/webauthn-origin.mjs";
import { eachWorkerEnv } from "./lib/wrangler-configs.mjs";

let checked = 0;
let failed = false;

for await (const { app, env, config } of eachWorkerEnv()) {
  const vars = config?.vars ?? {};
  // Passkey を持たない Worker は vars にどちらも持たない。数えない。
  if (!vars.RP_ID && !vars.WEBAUTHN_ORIGIN) continue;
  checked += 1;
  for (const problem of checkWebAuthnVars(vars)) {
    failed = true;
    console.error(`::error::${app} (env ${env}): ${problem}`);
  }
}

if (checked === 0) {
  // **「0 件を調べて問題なし」が一番まずい。** auth-worker は実際に
  // Passkey を持っているので、0 件は設定の読み方が変わった合図である。
  console.error(
    "::error::No worker env declares RP_ID / WEBAUTHN_ORIGIN, so nothing was checked. This is a bug in the check, not a clean repository.",
  );
  process.exit(1);
}

if (failed) process.exit(1);

console.log(`check-webauthn-origin: ${checked} 個の env を見て、問題なし。`);

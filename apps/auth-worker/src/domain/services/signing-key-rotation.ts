/**
 * 署名鍵のローテーション判定（#23 / 仕様書 5.4）。
 *
 * ## なぜ Domain に置くのか
 *
 * 「いまどの鍵で新規署名してよいか」「Workers Secret の中身と
 * `signing_key_metadata` が食い違っていないか」は、`jose` にも D1 にも
 * Workers ランタイムにも依存しない純粋な判定である。ここに置いてあるので、
 * **Worker 本体（`infrastructure/crypto/jose-signing-key.ts`）と運用スクリプト
 * （`scripts/signing-key.mjs`）が文字どおり同じ関数を呼べる**。
 *
 * これは docs/runbook.md 4.1 の制約 3（DB と Secret の不一致を誰も検知できない）
 * にとって本質的な性質である。検査を別コードで書くと「スクリプトは OK と言った
 * のに Worker は署名できない」が起こりうる。同じ関数を通すことで、検査の結論は
 * 「この Secret を入れたら Worker はこの kid で署名する」そのものになり、
 * 検査と実態がずれる余地が無くなる。
 *
 * ## Secret の形式を JWK Set にした理由
 *
 * `SIGNING_KEY_JWK` は単一 JWK でも **JWK Set（`{"keys":[...]}`）** でも受ける。
 * 新旧 2 鍵を 1 つの Secret に同居させられるようにしたのがこの変更の本体で、
 * 候補を 2 本以上持てると「どちらで署名するか」を Secret ではなく
 * `signing_key_metadata` の `active_from` / `active_until` が決められる。
 *
 * 代案だった `SIGNING_KEY_JWK_NEXT` を足す形を採らなかったのは、
 * **鍵の切り替えが「複数の Secret を矛盾なく更新する」操作のままになる**ため。
 * 旧実装では `SIGNING_KEY_JWK` と `SIGNING_KEY_KID` の 2 本を数秒以内に
 * 更新しろと runbook が指示していた（その間に発行されたトークンは
 * 「旧 kid を名乗る新鍵署名」になり全 RP で検証に失敗する）。Secret を増やすと
 * この窓が増える。JWK Set なら切り替えは「DB の 1 回の UPDATE」で済み、
 * Secret の更新は**鍵を足す / 外すだけの、いつやってもよい操作**になる。
 */

/** `signing_key_metadata` の 1 行のうち、鍵の寿命判定に要る列。 */
export type SigningKeyLifecycle = {
  readonly kid: string;
  readonly algorithm: string;
  /** JWKS に載せる公開鍵（JWK の JSON 文字列）。 */
  readonly publicJwk: string;
  readonly activeFrom: Date;
  readonly activeUntil: Date | null;
  readonly retiresAt: Date | null;
};

/** `SIGNING_KEY_JWK` に入っていた鍵 1 本。 */
export type SecretSigningKey = {
  readonly kid: string;
  /** JWK そのもの。`d`（秘密鍵成分）を含む。 */
  readonly jwk: Record<string, unknown>;
};

export type SigningKeySecretParseResult =
  | { readonly ok: true; readonly keys: readonly SecretSigningKey[] }
  | { readonly ok: false; readonly reason: string };

/**
 * Secret と DB の突き合わせで見つかる不整合の種類。
 *
 * ローテーション中に**正常に現れる**もの（`not-yet-active` /
 * `no-longer-signing`）と、**運用ミス**（`no-row` / `public-key-mismatch` /
 * `missing-from-secret` / `metadata-malformed` / `retired`）が混ざっている。
 * 区別は `isMisconfiguration()` が持つ。呼び出し側ごとに「どれが異常か」を
 * 書くと、Worker と運用スクリプトで判断がずれる。
 */
export type SigningKeyProblem =
  | "no-row"
  | "not-yet-active"
  | "no-longer-signing"
  | "retired"
  | "metadata-malformed"
  | "public-key-mismatch"
  | "missing-from-secret";

export type SigningKeyIssue = {
  readonly kid: string;
  readonly problem: SigningKeyProblem;
  /** 運用者が読む 1 行。ログにもエラーメッセージにもそのまま出る。 */
  readonly detail: string;
};

export type SigningKeySecretAudit = {
  /** Secret に入っていた kid（入っていた順）。 */
  readonly secretKids: readonly string[];
  /** いま新規署名に使われる kid。使える鍵が無ければ null。 */
  readonly signingKid: string | null;
  readonly issues: readonly SigningKeyIssue[];
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/**
 * Secret に入ってよい鍵かを見る。
 *
 * `d` の有無をここで見るのは、公開鍵を `SIGNING_KEY_JWK` に貼る取り違えが
 * 実際に起きるため（docs/runbook.md 2.4.1 が警告しているケース）。
 * 署名の瞬間まで気付けないと、気付くのは RP からの問い合わせになる。
 */
function rejectUnusableJwk(jwk: Record<string, unknown>, label: string): string | null {
  // MVP の署名アルゴリズムは ES256 固定で、Discovery もそれしか広告していない（仕様書 5.1）。
  if (jwk["kty"] !== "EC" || jwk["crv"] !== "P-256") {
    return `${label} is not an ES256 key (kty must be "EC" and crv must be "P-256")`;
  }
  if (typeof jwk["d"] !== "string") {
    return `${label} has no private component (d)`;
  }
  return null;
}

/**
 * `SIGNING_KEY_JWK` を鍵の配列へ開く。
 *
 * **壊れた 1 本があったら全体を失敗させる。** JWKS の方（`getPublicJwks`）は
 * 壊れた行を飛ばして残りを配り続けるが、こちらは逆にする。Secret は運用者が
 * 直接書く値で、壊れているのは常に書き間違いである。黙って 1 本飛ばすと
 * 「いま足したはずの新鍵が無視され、旧鍵で署名が続く」という、
 * ローテーションしたつもりの状態が一番起きやすい。
 *
 * @param legacyKid `SIGNING_KEY_KID`。単一 JWK 形式のときだけ使う。
 */
export function parseSigningKeySecret(
  json: string,
  legacyKid: string | null,
): SigningKeySecretParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return { ok: false, reason: "SIGNING_KEY_JWK is not valid JSON" };
  }

  const root = asRecord(raw);
  if (root === null) return { ok: false, reason: "SIGNING_KEY_JWK is not valid JSON" };

  const entries = root["keys"];
  if (Array.isArray(entries)) return parseJwkSet(entries);

  // --- 単一 JWK 形式（#23 以前からの形）。後方互換のためこちらを残す。 ---
  //
  // kid は `SIGNING_KEY_KID` を優先する。JWK 自身の `kid` を優先すると、
  // 既存環境で 2 つが食い違っていた場合に、Secret を一切触っていないのに
  // 署名する kid が変わってしまう。
  const normalizedLegacy = legacyKid !== null && legacyKid !== "" ? legacyKid : null;
  const embedded = typeof root["kid"] === "string" && root["kid"] !== "" ? root["kid"] : null;
  const kid = normalizedLegacy ?? embedded;
  if (kid === null) {
    return {
      ok: false,
      reason: 'SIGNING_KEY_KID is not set and SIGNING_KEY_JWK has no "kid"',
    };
  }

  const unusable = rejectUnusableJwk(root, "SIGNING_KEY_JWK");
  if (unusable !== null) return { ok: false, reason: unusable };

  return { ok: true, keys: [{ kid, jwk: root }] };
}

function parseJwkSet(entries: readonly unknown[]): SigningKeySecretParseResult {
  if (entries.length === 0) {
    return { ok: false, reason: "SIGNING_KEY_JWK is an empty JWK Set" };
  }

  const keys: SecretSigningKey[] = [];
  const seen = new Set<string>();

  for (const [index, entry] of entries.entries()) {
    const jwk = asRecord(entry);
    if (jwk === null) {
      return { ok: false, reason: `SIGNING_KEY_JWK key #${index} is not a JWK object` };
    }

    // Set 形式では `SIGNING_KEY_KID` が使えない（どの鍵を指すか決められない）ので、
    // kid は JWK に埋まっていなければならない。無いまま通すと、秘密鍵と
    // `signing_key_metadata` の行を結び付ける手がかりが消える。
    const kid = jwk["kid"];
    if (typeof kid !== "string" || kid === "") {
      return { ok: false, reason: `SIGNING_KEY_JWK key #${index} has no "kid"` };
    }
    if (seen.has(kid)) {
      // 同じ kid が 2 本あると、どちらで署名したかが JWKS からは区別できない。
      return { ok: false, reason: `SIGNING_KEY_JWK has two keys with kid "${kid}"` };
    }
    seen.add(kid);

    const unusable = rejectUnusableJwk(jwk, `SIGNING_KEY_JWK key "${kid}"`);
    if (unusable !== null) return { ok: false, reason: unusable };

    keys.push({ kid, jwk });
  }

  return { ok: true, keys };
}

/**
 * 鍵が 3 つの時刻のどこにいるか（仕様書 5.4）。
 *
 * `signing` 以外はすべて「新規署名には使えない」。JWKS に出るかどうかは
 * これとは別の軸で、`retired` 以外はすべて出る（`listPublishable`）——
 * この 2 軸がずれているのがローテーションの肝で、`no-longer-signing` の
 * 鍵を配り続けられるから無停止で切り替えられる。
 */
export type SigningKeyState = "not-yet-active" | "signing" | "no-longer-signing" | "retired";

export function signingKeyState(row: SigningKeyLifecycle, now: Date): SigningKeyState {
  // `retires_at` を過ぎた鍵は JWKS に出ない。それで署名すると「誰も検証できない
  // トークン」を配ることになるので、行が残っていても使わない。
  if (row.retiresAt !== null && row.retiresAt.getTime() <= now.getTime()) return "retired";
  if (row.activeFrom.getTime() > now.getTime()) return "not-yet-active";
  if (row.activeUntil !== null && row.activeUntil.getTime() <= now.getTime()) {
    return "no-longer-signing";
  }
  return "signing";
}

/** 新規署名に使ってよい期間内か。使えない理由があれば返す。 */
function classifyLifecycle(row: SigningKeyLifecycle, now: Date): SigningKeyProblem | null {
  const state = signingKeyState(row, now);
  return state === "signing" ? null : state;
}

function lifecycleDetail(kid: string, problem: SigningKeyProblem): string {
  // いずれも「is not active in signing_key_metadata」を含む。運用者が
  // runbook 4.2 のどのステップで止まっているかを、括弧の中で見分けられるようにする。
  switch (problem) {
    case "retired":
      return `kid "${kid}" is not active in signing_key_metadata (retires_at has passed, so the key is no longer published in JWKS)`;
    case "not-yet-active":
      return `kid "${kid}" is not active in signing_key_metadata (active_from is in the future; the key is published but must not sign yet)`;
    default:
      return `kid "${kid}" is not active in signing_key_metadata (active_until has passed)`;
  }
}

/**
 * Secret の公開鍵成分と `public_jwk` 列が同じ鍵を指しているかを見る。
 *
 * **ここが #23 (c) の核心。** kid が一致していても中身が別の鍵なら、
 * ID Token の署名は JWKS に載っている公開鍵では検証できない。しかも
 * 症状は「全 RP で一斉に検証失敗」で、auth-worker 側のログには何も出ない
 * （署名自体は成功しているため）。kid の存在確認だけでは捕まらない。
 */
function comparePublicKey(
  secret: Record<string, unknown>,
  row: SigningKeyLifecycle,
): SigningKeyIssue | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.publicJwk);
  } catch {
    parsed = null;
  }
  const published = asRecord(parsed);
  if (published === null) {
    return {
      kid: row.kid,
      problem: "metadata-malformed",
      detail: `kid "${row.kid}" has a public_jwk in signing_key_metadata that is not valid JSON`,
    };
  }

  // 比べるのは曲線と座標だけ。`alg` / `use` / `kid` は JWKS を組み立てる側が
  // 付け直すので（`toPublicJwk`）、一致していなくても配られる鍵は変わらない。
  const same =
    published["crv"] === secret["crv"] &&
    published["x"] === secret["x"] &&
    published["y"] === secret["y"];
  if (same) return null;

  return {
    kid: row.kid,
    problem: "public-key-mismatch",
    detail: `kid "${row.kid}" in SIGNING_KEY_JWK does not match public_jwk in signing_key_metadata (JWKS would advertise a different key than the one signing)`,
  };
}

/**
 * Secret と `signing_key_metadata` を突き合わせ、署名に使う鍵を決める。
 *
 * `rows` には「突き合わせたい行」を渡す。Worker は Secret に入っている kid の
 * 行だけを引いて渡し（1 リクエストで余計なクエリを打たないため）、運用スクリプトは
 * 全行を渡す。全行を渡したときだけ `missing-from-secret`
 * ——「DB は現役と言っているが Secret にその鍵が無い」—— が検出できる。
 *
 * 現役の鍵が複数あったら **`active_from` が最も新しいもの**を選ぶ。ここで
 * 失敗させない理由は、2 本同時に現役なのがローテーションの途中で普通に
 * 起こりうる状態だから。どちらも JWKS に載っているので RP はどちらでも
 * 検証でき、新しい方を選べば切り替えは常に前へ進む。ここで throw すると、
 * 運用者の UPDATE が 1 つ遅れただけで認証が全面停止する。
 */
export function auditSigningKeySecret(
  keys: readonly SecretSigningKey[],
  rows: readonly SigningKeyLifecycle[],
  now: Date,
): SigningKeySecretAudit {
  const byKid = new Map(rows.map((row) => [row.kid, row]));
  const issues: SigningKeyIssue[] = [];
  const usable: SigningKeyLifecycle[] = [];

  for (const key of keys) {
    const row = byKid.get(key.kid);
    if (row === undefined) {
      // JWKS に載らない kid を名乗る ID Token は、全 RP で検証に失敗する。
      issues.push({
        kid: key.kid,
        problem: "no-row",
        detail: `kid "${key.kid}" has no row in signing_key_metadata`,
      });
      continue;
    }

    const lifecycle = classifyLifecycle(row, now);
    if (lifecycle !== null) {
      issues.push({
        kid: key.kid,
        problem: lifecycle,
        detail: lifecycleDetail(key.kid, lifecycle),
      });
      continue;
    }

    if (row.algorithm !== "ES256") {
      issues.push({
        kid: key.kid,
        problem: "metadata-malformed",
        detail: `kid "${key.kid}" is recorded as ${row.algorithm} in signing_key_metadata, but only ES256 is supported`,
      });
      continue;
    }

    const mismatch = comparePublicKey(key.jwk, row);
    if (mismatch !== null) {
      issues.push(mismatch);
      continue;
    }

    usable.push(row);
  }

  const inSecret = new Set(keys.map((key) => key.kid));
  for (const row of rows) {
    if (inSecret.has(row.kid)) continue;
    if (classifyLifecycle(row, now) !== null) continue;
    // DB だけが知っている現役鍵。Secret を入れ忘れたまま `active_from` を
    // 引き下げた状態がこれで、放置すると ID Token の発行が止まる
    // （どの鍵も現役行と対応しない＝署名できない）。
    issues.push({
      kid: row.kid,
      problem: "missing-from-secret",
      detail: `kid "${row.kid}" is active in signing_key_metadata but is not present in SIGNING_KEY_JWK`,
    });
  }

  // `active_from` が新しい順。同時刻なら kid の降順で決め打ちにして、
  // 同じ入力なら常に同じ鍵が選ばれるようにする（再現しない不具合を作らない）。
  const [selected] = [...usable].sort(
    (a, b) => b.activeFrom.getTime() - a.activeFrom.getTime() || (a.kid < b.kid ? 1 : -1),
  );

  return {
    secretKids: keys.map((key) => key.kid),
    signingKid: selected?.kid ?? null,
    issues,
  };
}

/**
 * ローテーション中に現れて当然の状態か、運用ミスかを分ける。
 *
 * `not-yet-active`（先行公開した新鍵）と `no-longer-signing`（まだ Secret に
 * 残している旧鍵）は、runbook 4.2 の手順どおりに進めていれば必ず見える。
 * これを異常として出すと、正しい手順のたびに警告が出て誰も読まなくなる。
 */
export function isMisconfiguration(problem: SigningKeyProblem): boolean {
  return (
    problem === "no-row" ||
    problem === "retired" ||
    problem === "metadata-malformed" ||
    problem === "public-key-mismatch" ||
    problem === "missing-from-secret"
  );
}

/** 署名できないときのエラー文。Worker のログと運用スクリプトで同じ文面を使う。 */
export function explainUnusableSigningKeys(audit: SigningKeySecretAudit): string {
  if (audit.issues.length === 0) return "SIGNING_KEY_JWK contains no key";
  if (audit.issues.length === 1) return audit.issues[0]!.detail;
  return `no usable signing key (${audit.issues.map((issue) => issue.detail).join("; ")})`;
}

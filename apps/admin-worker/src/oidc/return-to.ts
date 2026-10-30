/**
 * ログイン後の戻り先の持ち回し。
 *
 * **`auth-worker` の `sanitizeReturnTo` と同じ脅威に同じ形で答える**
 * （`packages/contracts/src/return-to.ts` ではなく独自に持つのは、
 * admin-worker が持つパスの集合が auth とは別物で、将来ここだけの
 * 接頭辞が増えるため——あちらの許可リストに admin 用のパスを足すと、
 * auth-worker の「先回りして広げない」を admin-worker の都合で破ることになる）。
 *
 * **相対パス（`/` で始まる）だけを許す。絶対 URL は拒否する。**
 * `//evil.example/` や `/\evil.example` はブラウザによって別オリジンの
 * 絶対 URL として解釈されうるので、前方一致の前に落とす。
 */
export function sanitizeReturnTo(raw: string | null | undefined): string {
  const fallback = "/";
  if (raw === null || raw === undefined || raw === "") return fallback;
  if (!raw.startsWith("/")) return fallback;
  if (raw.startsWith("//") || raw.startsWith("/\\")) return fallback;
  if (/[\r\n]/.test(raw)) return fallback;

  // **ブラウザと同じ正規化を 1 回通してから使う。** `%2e%2e` も `..` も、
  // 綴りを個別に禁止するのではなく、ここで同じ結果（`/evil` のような
  // 正規化後のパス）に揃える——auth-worker の `return-to.ts` と同じ考え方
  // だが、admin-worker にはまだ「許可する接頭辞のリスト」が無いので、
  // ここで防いでいるのは「接頭辞の外へ出る」ことではなく「同一オリジンの
  // 外へ出る」ことだけである（次の判定）。
  let normalized: URL;
  try {
    normalized = new URL(raw, "https://invalid.example");
  } catch {
    return fallback;
  }
  if (normalized.origin !== "https://invalid.example") return fallback;
  return `${normalized.pathname}${normalized.search}`;
}

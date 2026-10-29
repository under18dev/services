/**
 * クライアントのロゴ URL の検証（#308 / 仕様書 5.1）。
 *
 * `redirect_uri` と違い、ここは**認可コードの宛先ではない**ので完全一致も
 * 正規形も要らない。それでも素通しにしないのは、この値が**管理画面と
 * 同意画面に `img` として描かれる**ためである。
 *
 * - `https:` 以外を弾く。`http:` だと同意画面に混在コンテンツが入り、
 *   利用者が「このアプリに許可する」と判断する材料の出所が平文になる。
 *   `data:` / `javascript:` のようなスキームは、描画先の文脈次第で
 *   `img` 以外に化けうるので、許す理由がない側に倒す。
 * - `https://user:pass@…` を弾く。資格情報を画面の HTML に載せない
 *   （`redirect_uri` と同じ判断）。
 *
 * ループバックの例外は置かない。ロゴが開発者の手元からしか引けない形に
 * 意味が無く、`redirect_uri` のように「マシンの外へ出ない」ことが
 * 根拠になる話でもない。
 */
export type LogoUrlRejection = "not_absolute" | "insecure_scheme" | "has_credentials";

export type LogoUrlValidation =
  | { readonly ok: true; readonly url: string }
  | { readonly ok: false; readonly reason: LogoUrlRejection };

export function validateLogoUrl(raw: string): LogoUrlValidation {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "not_absolute" };
  }

  if (url.username !== "" || url.password !== "") return { ok: false, reason: "has_credentials" };
  if (url.protocol !== "https:") return { ok: false, reason: "insecure_scheme" };

  // 正規形は要求しない。照合に使う値ではないので、`https://A.example/logo.png`
  // がそのまま入っても困るのは見た目だけである。
  return { ok: true, url: raw };
}

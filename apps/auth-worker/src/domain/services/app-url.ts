/**
 * クライアントの表示用 URL（`app_url`）の検証（#457）。
 *
 * **`redirect_uri` の代わりにはならない。** ここは認可コードの宛先では
 * なく、利用者が「このアプリを開く」ために押すリンクでしかないので、
 * 完全一致も正規形も要らない。それでも素通しにしないのは、この値が
 * `/account/apps` にリンクとして描かれるためである——
 * `domain/services/logo-url.ts` と同じ理由・同じ関門（`https:` のみ・
 * 資格情報を含まない）を、別の用途向けに持つ。
 *
 * - `https:` 以外を弾く。平文 HTTP のリンクを置くと、押した先が
 *   盗聴・改ざんされうるページだと知らせずに案内することになる。
 * - `https://user:pass@…` を弾く。資格情報を画面の HTML に載せない。
 *
 * **`redirect_uri` のオリジンと突き合わせない。** コールバック専用の
 * ホスト（`/callback` しか無いなど）を app_url として使われても、
 * ここでは検出できない——運用者が入力した値をそのまま信じる。
 * 黙って `redirect_uri` から導出しない（#306 の「実在するものしか
 * 載せない」を壊す）という方針は、呼び出し側（admin-worker の画面）
 * が守るべきもので、この検証自体はその代わりにならない。
 */
export type AppUrlRejection = "not_absolute" | "insecure_scheme" | "has_credentials";

export type AppUrlValidation =
  | { readonly ok: true; readonly url: string }
  | { readonly ok: false; readonly reason: AppUrlRejection };

export function validateAppUrl(raw: string): AppUrlValidation {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "not_absolute" };
  }

  if (url.username !== "" || url.password !== "") return { ok: false, reason: "has_credentials" };
  if (url.protocol !== "https:") return { ok: false, reason: "insecure_scheme" };

  return { ok: true, url: raw };
}

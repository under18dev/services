/**
 * ログイン開始から `/callback` までの一時的な状態（state / nonce /
 * code_verifier / 戻り先）を Cookie で持ち回す。
 *
 * ## なぜ署名しないのか
 *
 * この Cookie は **HttpOnly** で、admin-worker 自身だけが読み書きする。
 * 値を書き換えられるのはブラウザ本人だけで、書き換えても得をする相手がいない
 * ——`state` は IdP から返ってきた値と一致するかを見るだけなので、
 * 利用者が自分の Cookie を自分で書き換えても自分の CSRF 対策を自分で
 * 外すだけである。署名は「第三者に偽装されると困る」ときに要るもので、
 * ここはその形に当たらない。
 *
 * ## JSON を直接 Cookie に入れない
 *
 * `;` や制御文字が紛れると Cookie のパースを壊す。base64url で包んでから
 * 入れる。
 */

export type LoginState = {
  readonly state: string;
  readonly nonce: string;
  readonly codeVerifier: string;
  readonly returnTo: string;
};

export function encodeLoginState(value: LoginState): string {
  const json = JSON.stringify(value);
  const bytes = new TextEncoder().encode(json);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

/** 壊れている・無い場合は null。**例外を投げない** —— 呼び出し側は「ログインをやり直す」の 1 択で済む。 */
export function decodeLoginState(raw: string | undefined): LoginState | null {
  if (raw === undefined || raw === "") return null;
  try {
    const padded = raw.replaceAll("-", "+").replaceAll("_", "/");
    const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, "="));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as LoginState).state === "string" &&
      typeof (parsed as LoginState).nonce === "string" &&
      typeof (parsed as LoginState).codeVerifier === "string" &&
      typeof (parsed as LoginState).returnTo === "string"
    ) {
      return parsed as LoginState;
    }
    return null;
  } catch {
    return null;
  }
}

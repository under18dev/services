/**
 * WebAuthn JSON と WebAuthn API の間の形式差を埋める。
 *
 * ## なぜ共有するのか
 *
 * ログイン（`navigator.credentials.get()`）と登録（`.create()`）で**同じ
 * 変換が要る。** 片方に書くともう片方へ写すことになり、**写した先だけが
 * 古くなる**（このリポジトリが繰り返し踏んでいる形）。
 *
 * ## なぜ手書きの変換を残すのか
 *
 * `PublicKeyCredential.parseCreationOptionsFromJSON()` と `toJSON()` が
 * あればそれを使う。**無いブラウザがまだある。** 変換そのものは
 * base64url ↔ ArrayBuffer でしかないので、落ちる代わりに手で写す。
 */

export function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, "="));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function bytesToBase64Url(buffer: ArrayBuffer): string {
  let binary = "";
  for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

/** 認証器が使えない端末。ボタンを出しても押せないので最初から出さない。 */
export const supportsPasskey = (): boolean =>
  typeof window.PublicKeyCredential === "function" && navigator.credentials !== undefined;

/** サーバーが返す JSON を `navigator.credentials.get()` の引数へ写す。 */
export function toRequestOptions(json: Record<string, unknown>): PublicKeyCredentialRequestOptions {
  const parse = window.PublicKeyCredential.parseRequestOptionsFromJSON;
  if (typeof parse === "function") {
    return parse(json as unknown as PublicKeyCredentialRequestOptionsJSON);
  }
  const { challenge, ...rest } = json as { challenge: string };
  return {
    ...(rest as unknown as PublicKeyCredentialRequestOptions),
    challenge: base64UrlToBytes(challenge),
  };
}

/**
 * サーバーが返す JSON を `navigator.credentials.create()` の引数へ写す。
 *
 * **base64url で来るのは 3 箇所**（`challenge` / `user.id` /
 * `excludeCredentials[].id`）。`excludeCredentials` を落とすと**同じ認証器を
 * 二重に登録できてしまう**ので、ここで写し忘れない。
 */
export function toCreationOptions(
  json: Record<string, unknown>,
): PublicKeyCredentialCreationOptions {
  const parse = window.PublicKeyCredential.parseCreationOptionsFromJSON;
  if (typeof parse === "function") {
    return parse(json as unknown as PublicKeyCredentialCreationOptionsJSON);
  }

  const { challenge, user, excludeCredentials, ...rest } = json as {
    challenge: string;
    user: { id: string; name: string; displayName: string };
    excludeCredentials?: readonly { id: string; type: string; transports?: string[] }[];
  };

  return {
    ...(rest as unknown as PublicKeyCredentialCreationOptions),
    challenge: base64UrlToBytes(challenge),
    user: { ...user, id: base64UrlToBytes(user.id) },
    ...(excludeCredentials === undefined
      ? {}
      : {
          excludeCredentials: excludeCredentials.map((credential) => ({
            id: base64UrlToBytes(credential.id),
            type: "public-key" as const,
            // **`exactOptionalPropertyTypes` の下では `undefined` を
            // 明示的に入れられない。** 無いときは項目ごと落とす。
            ...(credential.transports === undefined
              ? {}
              : { transports: credential.transports as AuthenticatorTransport[] }),
          })),
        }),
  };
}

/**
 * 認証器の応答を WebAuthn JSON へ写す。
 *
 * **登録と認証で中身が違う。** 登録は `attestationObject`、認証は
 * `authenticatorData` / `signature` / `userHandle` を持つ。`toJSON()` が
 * あればブラウザが正しいほうを出すので、手書き版だけが見分ける。
 */
export function toResponseJson(credential: PublicKeyCredential): Record<string, unknown> {
  if (typeof credential.toJSON === "function") {
    return credential.toJSON() as unknown as Record<string, unknown>;
  }

  const common = {
    id: credential.id,
    rawId: bytesToBase64Url(credential.rawId),
    type: credential.type,
    clientExtensionResults: credential.getClientExtensionResults(),
  };

  const response = credential.response;
  if ("attestationObject" in response) {
    const attestation = response as AuthenticatorAttestationResponse;
    return {
      ...common,
      response: {
        clientDataJSON: bytesToBase64Url(attestation.clientDataJSON),
        attestationObject: bytesToBase64Url(attestation.attestationObject),
        // `getTransports()` は古い環境に無い。無ければ省く（任意項目）。
        ...(typeof attestation.getTransports === "function"
          ? { transports: attestation.getTransports() }
          : {}),
      },
    };
  }

  const assertion = response as AuthenticatorAssertionResponse;
  return {
    ...common,
    response: {
      clientDataJSON: bytesToBase64Url(assertion.clientDataJSON),
      authenticatorData: bytesToBase64Url(assertion.authenticatorData),
      signature: bytesToBase64Url(assertion.signature),
      userHandle: assertion.userHandle === null ? null : bytesToBase64Url(assertion.userHandle),
    },
  };
}

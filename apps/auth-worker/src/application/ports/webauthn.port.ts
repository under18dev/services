/**
 * WebAuthn の検証 Port（仕様書 6.1 / 9）。
 *
 * 署名検証・CBOR/COSE の解析は実績のあるライブラリに委ねる（仕様書 5.4）。
 * ここでライブラリの型をそのまま公開すると Application がライブラリに縛られるので、
 * 必要な値だけを写した素の型で境界を切る。
 *
 * **実装側の責務**: Origin / RP ID / User Verification の検証は実装が必ず行う。
 * これらは設定（`WEBAUTHN_ORIGIN` / `RP_ID`）から決まり、リクエストごとに
 * 変わらないため、Application へ持ち上げると設定を渡し回すだけになる。
 * したがって `verified: true` は「Origin・RP ID・UV がすべて期待どおり」を意味する。
 */

/** ブラウザへそのまま渡す options。中身は WebAuthn 仕様が決めるので Application は解釈しない。 */
export type WebAuthnOptionsJson = Readonly<Record<string, unknown>>;

export type WebAuthnOptions = {
  /** base64url。保存しておき、verify で照合する。 */
  readonly challenge: string;
  readonly json: WebAuthnOptionsJson;
};

/**
 * ブラウザが返す credential の JSON。
 *
 * 構造の検証は実装（ライブラリ）に任せるため `unknown` 相当で受けるが、
 * `id` だけは「どの Credential か」を引くために Application が読む。
 */
export type WebAuthnResponseJson = {
  readonly id: string;
  readonly [key: string]: unknown;
};

export type RegistrationOptionsInput = {
  readonly userId: string;
  readonly userName: string;
  readonly userDisplayName: string;
  /** 登録済み Credential。同じ認証器の二重登録をブラウザ側で止める。 */
  readonly excludeCredentialIds: readonly string[];
};

export type VerifyRegistrationInput = {
  readonly response: WebAuthnResponseJson;
  readonly expectedChallenge: string;
};

export type VerifiedRegistration = {
  readonly credentialId: string;
  /** COSE 公開鍵の base64url。 */
  readonly publicKey: string;
  readonly counter: number;
  readonly transports: readonly string[] | null;
  readonly aaguid: string | null;
  readonly deviceType: "singleDevice" | "multiDevice";
  readonly backedUp: boolean;
};

export type VerifyAuthenticationInput = {
  readonly response: WebAuthnResponseJson;
  readonly expectedChallenge: string;
  readonly credential: {
    readonly credentialId: string;
    readonly publicKey: string;
    readonly counter: number;
    readonly transports: readonly string[] | null;
  };
};

export type VerifiedAuthentication = {
  readonly credentialId: string;
  /** 認証器が申告したサインカウンター。受け入れ可否の判断は Domain が行う。 */
  readonly newCounter: number;
  readonly backedUp: boolean;
};

/**
 * 検証結果。
 *
 * 失敗は例外ではなく値で返す。UseCase は例外を投げない契約（`types.ts`）なので、
 * ライブラリの throw を Application まで素通りさせない。`reason` は監査ログ専用で、
 * 利用者への応答に混ぜないこと（失敗理由の差は列挙の材料になる）。
 */
export type WebAuthnResult<T> =
  | { readonly verified: true; readonly value: T }
  | { readonly verified: false; readonly reason: string };

export interface WebAuthnService {
  createRegistrationOptions(input: RegistrationOptionsInput): Promise<WebAuthnOptions>;
  verifyRegistration(input: VerifyRegistrationInput): Promise<WebAuthnResult<VerifiedRegistration>>;
  /**
   * ログイン用の options。
   *
   * 引数で利用者を受け取らない。allowCredentials を返すと「そのアカウントは
   * 存在する」と答えることになるため、discoverable credential だけを使う。
   */
  createAuthenticationOptions(): Promise<WebAuthnOptions>;
  verifyAuthentication(
    input: VerifyAuthenticationInput,
  ): Promise<WebAuthnResult<VerifiedAuthentication>>;
}

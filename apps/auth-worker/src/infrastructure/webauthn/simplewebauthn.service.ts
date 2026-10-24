import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import { isoBase64URL, isoUint8Array } from "@simplewebauthn/server/helpers";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import type {
  RegistrationOptionsInput,
  VerifiedAuthentication,
  VerifiedRegistration,
  VerifyAuthenticationInput,
  VerifyRegistrationInput,
  WebAuthnOptions,
  WebAuthnResult,
  WebAuthnService,
} from "../../application/ports/webauthn.port";

export type WebAuthnConfig = {
  /** `RP_ID`。登録・認証の両方でこの値と一致しない応答は弾かれる。 */
  readonly rpId: string;
  readonly rpName: string;
  /** `WEBAUTHN_ORIGIN`。clientDataJSON の origin をこれと照合する。 */
  readonly origin: string;
};

/**
 * WebAuthn Port の実装（仕様書 5.4「独自の暗号プリミティブを作らない」）。
 *
 * 署名検証・CBOR/COSE の解析・attestation の扱いはすべて
 * `@simplewebauthn/server` に委ねる。このクラスの仕事は 3 つだけ:
 *
 * 1. 設定（Origin / RP ID）を検証パラメータとして渡す
 * 2. User Verification を必須にする
 * 3. ライブラリの例外を Application が扱える戻り値へ畳み込む
 */
export class SimpleWebAuthnService implements WebAuthnService {
  constructor(private readonly config: WebAuthnConfig) {}

  async createRegistrationOptions(input: RegistrationOptionsInput): Promise<WebAuthnOptions> {
    const options = await generateRegistrationOptions({
      rpName: this.config.rpName,
      rpID: this.config.rpId,
      // userID は認証器に保存され、ログイン時に userHandle として返ってくる。
      // ここに username やメールを入れると認証器側に個人情報が残るので
      // 不変の内部 ID だけを渡す（仕様書 6.2 / 9 Privacy）。
      userID: isoUint8Array.fromUTF8String(input.userId),
      userName: input.userName,
      userDisplayName: input.userDisplayName,
      attestationType: "none",
      excludeCredentials: input.excludeCredentialIds.map((id) => ({ id })),
      authenticatorSelection: {
        // discoverable credential を必須にする。ログインで allowCredentials を
        // 出さない設計（列挙対策）は、認証器側が Credential を保持して
        // いなければ成立しない。
        residentKey: "required",
        userVerification: "required",
      },
    });

    // ライブラリの型は index signature を持たないので、素の JSON へ写してから返す。
    return { challenge: options.challenge, json: { ...options } };
  }

  async verifyRegistration(
    input: VerifyRegistrationInput,
  ): Promise<WebAuthnResult<VerifiedRegistration>> {
    try {
      const result = await verifyRegistrationResponse({
        // 構造の検証もライブラリが行う。壊れていれば throw され、下で畳み込む。
        response: input.response as unknown as RegistrationResponseJSON,
        expectedChallenge: input.expectedChallenge,
        expectedOrigin: this.config.origin,
        expectedRPID: this.config.rpId,
        requireUserVerification: true,
      });
      if (!result.verified) return { verified: false, reason: "not_verified" };

      const { credential, aaguid, credentialDeviceType, credentialBackedUp } =
        result.registrationInfo;
      return {
        verified: true,
        value: {
          credentialId: credential.id,
          publicKey: isoBase64URL.fromBuffer(credential.publicKey),
          counter: credential.counter,
          transports: credential.transports ?? null,
          aaguid,
          deviceType: credentialDeviceType,
          backedUp: credentialBackedUp,
        },
      };
    } catch (error) {
      return { verified: false, reason: reasonOf(error) };
    }
  }

  async createAuthenticationOptions(): Promise<WebAuthnOptions> {
    const options = await generateAuthenticationOptions({
      rpID: this.config.rpId,
      // allowCredentials は渡さない。返した時点で「そのアカウントは存在する」
      // と答えることになる（仕様書 9）。
      userVerification: "required",
    });

    return { challenge: options.challenge, json: { ...options } };
  }

  async verifyAuthentication(
    input: VerifyAuthenticationInput,
  ): Promise<WebAuthnResult<VerifiedAuthentication>> {
    try {
      const result = await verifyAuthenticationResponse({
        response: input.response as unknown as AuthenticationResponseJSON,
        expectedChallenge: input.expectedChallenge,
        expectedOrigin: this.config.origin,
        expectedRPID: this.config.rpId,
        requireUserVerification: true,
        credential: {
          id: input.credential.credentialId,
          publicKey: isoBase64URL.toBuffer(input.credential.publicKey),
          counter: input.credential.counter,
          ...(input.credential.transports === null
            ? {}
            : { transports: [...input.credential.transports] }),
        },
      });
      if (!result.verified) return { verified: false, reason: "not_verified" };

      const { credentialID, newCounter, credentialBackedUp } = result.authenticationInfo;
      return {
        verified: true,
        value: { credentialId: credentialID, newCounter, backedUp: credentialBackedUp },
      };
    } catch (error) {
      return { verified: false, reason: reasonOf(error) };
    }
  }
}

/**
 * 例外を監査ログ用の短い文字列にする。
 *
 * ライブラリのメッセージには期待値（Origin・RP ID・Challenge）が入りうる。
 * 利用者への応答には出さず、ログにだけ残す前提の値。
 */
function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : "verification error";
}

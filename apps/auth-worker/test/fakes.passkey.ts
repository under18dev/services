import { isoBase64URL, isoCBOR } from "@simplewebauthn/server/helpers";
import type { NewPasskey, PasskeyRepository } from "../src/application/ports/passkey.repository";
import type {
  CreateWebAuthnChallengeInput,
  WebAuthnChallengeRepository,
} from "../src/application/ports/webauthn-challenge.repository";
import type {
  RegistrationOptionsInput,
  VerifiedAuthentication,
  VerifiedRegistration,
  VerifyAuthenticationInput,
  VerifyRegistrationInput,
  WebAuthnOptions,
  WebAuthnResult,
  WebAuthnService,
} from "../src/application/ports/webauthn.port";
import { Passkey, type PasskeyProps } from "../src/domain/entities/passkey";
import {
  WebAuthnChallenge,
  type WebAuthnChallengeProps,
} from "../src/domain/entities/webauthn-challenge";

/**
 * パスキー関連のテスト代替（仕様書 11.1）。
 *
 * Repository は Mock ではなくインメモリの本物の振る舞いを置く。特に
 * 条件付き UPDATE の原子性は再現しておかないと、UseCase 側のテストが
 * 「実際には同時実行で破れる実装」を通してしまう。
 */

export class InMemoryPasskeyRepository implements PasskeyRepository {
  private readonly store = new Map<string, PasskeyProps>();

  seed(props: PasskeyProps): Passkey {
    this.store.set(props.credentialId, props);
    return Passkey.fromPersistence(props);
  }

  async findByCredentialId(credentialId: string): Promise<Passkey | null> {
    const props = this.store.get(credentialId);
    return props ? Passkey.fromPersistence(props) : null;
  }

  async listByUserId(userId: string): Promise<readonly Passkey[]> {
    return [...this.store.values()]
      .filter((props) => props.userId === userId)
      .map((props) => Passkey.fromPersistence(props));
  }

  async create(input: NewPasskey): Promise<Passkey | null> {
    // 一意制約と同じく、すでにある Credential ID なら null。
    if (this.store.has(input.credentialId)) return null;
    const props: PasskeyProps = { ...input, lastUsedAt: null, createdAt: new Date() };
    this.store.set(props.credentialId, props);
    return Passkey.fromPersistence(props);
  }

  async recordUse(credentialId: string, counter: number, at: Date): Promise<boolean> {
    const props = this.store.get(credentialId);
    // 条件付き UPDATE（`counter <= :next`）と同じ判定。
    if (!props || props.counter > counter) return false;
    this.store.set(credentialId, { ...props, counter, lastUsedAt: at });
    return true;
  }
}

export class InMemoryWebAuthnChallengeRepository implements WebAuthnChallengeRepository {
  private readonly store = new Map<string, WebAuthnChallengeProps>();

  seed(props: WebAuthnChallengeProps): WebAuthnChallenge {
    this.store.set(props.id, props);
    return WebAuthnChallenge.fromPersistence(props);
  }

  async create(input: CreateWebAuthnChallengeInput): Promise<WebAuthnChallenge> {
    const props: WebAuthnChallengeProps = { ...input, consumedAt: null, createdAt: new Date() };
    this.store.set(props.id, props);
    return WebAuthnChallenge.fromPersistence(props);
  }

  async consume(id: string, at: Date): Promise<WebAuthnChallenge | null> {
    const props = this.store.get(id);
    // 実装と同じく、消費済みなら null。2 回目は何も返さない。
    if (!props || props.consumedAt !== null) return null;
    const consumed: WebAuthnChallengeProps = { ...props, consumedAt: at };
    this.store.set(id, consumed);
    return WebAuthnChallenge.fromPersistence(consumed);
  }
}

/**
 * 署名検証をしない WebAuthn Port。
 *
 * UseCase のテストで「検証は通ったが、その後の方針で弾くか」を確かめるためのもの。
 * 実物の検証（Origin / RP ID / UV / 署名）は passkey-webauthn.test.ts が
 * 本物の認証器を組み立てて確かめる。
 */
export class FakeWebAuthnService implements WebAuthnService {
  /** 次の verifyRegistration / verifyAuthentication が返す結果。 */
  registrationResult: WebAuthnResult<VerifiedRegistration> = {
    verified: false,
    reason: "not configured",
  };
  authenticationResult: WebAuthnResult<VerifiedAuthentication> = {
    verified: false,
    reason: "not configured",
  };

  readonly registrationOptionsInputs: RegistrationOptionsInput[] = [];
  private issued = 0;

  async createRegistrationOptions(input: RegistrationOptionsInput): Promise<WebAuthnOptions> {
    this.registrationOptionsInputs.push(input);
    const challenge = `challenge-${(this.issued += 1)}`;
    return { challenge, json: { challenge, rp: { id: "localhost" } } };
  }

  async createAuthenticationOptions(): Promise<WebAuthnOptions> {
    const challenge = `challenge-${(this.issued += 1)}`;
    return { challenge, json: { challenge, rpId: "localhost" } };
  }

  async verifyRegistration(
    _input: VerifyRegistrationInput,
  ): Promise<WebAuthnResult<VerifiedRegistration>> {
    return this.registrationResult;
  }

  async verifyAuthentication(
    _input: VerifyAuthenticationInput,
  ): Promise<WebAuthnResult<VerifiedAuthentication>> {
    return this.authenticationResult;
  }
}

export function aVerifiedRegistration(
  overrides: Partial<VerifiedRegistration> = {},
): VerifiedRegistration {
  return {
    credentialId: "cred-1",
    publicKey: "cHVibGljLWtleQ",
    counter: 0,
    transports: ["internal"],
    aaguid: "00000000-0000-0000-0000-000000000000",
    deviceType: "multiDevice",
    backedUp: true,
    ...overrides,
  };
}

export function aPasskey(overrides: Partial<PasskeyProps> = {}): PasskeyProps {
  return {
    id: "pky_test",
    userId: "usr_test",
    credentialId: "cred-1",
    publicKey: "cHVibGljLWtleQ",
    counter: 0,
    aaguid: null,
    deviceType: "multiDevice",
    backedUp: true,
    transports: ["internal"],
    label: null,
    lastUsedAt: null,
    createdAt: new Date("2026-10-24T00:00:00.000Z"),
    ...overrides,
  };
}

// --- ここから下は「本物の認証器」の代わり ---

/**
 * Workers の型定義では素の `Uint8Array` が `ArrayBufferLike` 付きになり、
 * ライブラリが要求する `Uint8Array<ArrayBuffer>` と噛み合わない。
 * テスト側で作るバイト列はすべてこちらに揃える。
 */
type Bytes = Uint8Array<ArrayBuffer>;

/** `isoCBOR.encode` が受け取れる値。tiny-cbor の CBORType を再輸出していないので引き出す。 */
type Cbor = Parameters<typeof isoCBOR.encode>[0];

const AAGUID: Bytes = new Uint8Array(16);

const FLAG = {
  userPresent: 0x01,
  userVerified: 0x04,
  backupEligible: 0x08,
  backedUp: 0x10,
  attestedCredentialData: 0x40,
} as const;

const utf8 = (value: string): Bytes => new Uint8Array(new TextEncoder().encode(value));

async function sha256(bytes: Bytes): Promise<Bytes> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}

function concat(parts: readonly Uint8Array[]): Bytes {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function uint32(value: number): Bytes {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, false);
  return out;
}

/**
 * Web Crypto の ECDSA 署名（r||s の生バイト）を DER へ包み直す。
 *
 * WebAuthn の ES256 署名は ASN.1 DER で運ばれる（W3C WebAuthn §6.5.6）。
 * 検証側のライブラリはこれを解いて生バイトへ戻すので、テスト側では
 * 逆向きの変換が要る。暗号そのものではなく TLV の組み立て。
 */
function toDerSignature(raw: Bytes): Bytes {
  const encodeInteger = (bytes: Uint8Array): Bytes => {
    let start = 0;
    while (start < bytes.length - 1 && bytes[start] === 0) start += 1;
    const trimmed = bytes.subarray(start);
    // 最上位ビットが立っていると負数に見えるので 0x00 を足す。
    const body = (trimmed[0] ?? 0) & 0x80 ? concat([new Uint8Array([0]), trimmed]) : trimmed;
    return concat([new Uint8Array([0x02, body.length]), body]);
  };

  const r = encodeInteger(raw.subarray(0, 32));
  const s = encodeInteger(raw.subarray(32));
  const body = concat([r, s]);
  return concat([new Uint8Array([0x30, body.length]), body]);
}

export type AuthenticatorFlags = {
  readonly userVerified?: boolean;
  readonly backedUp?: boolean;
};

export type AssertionOptions = AuthenticatorFlags & {
  readonly challenge: string;
  readonly origin: string;
  readonly rpId: string;
  readonly counter: number;
};

export type AttestationOptions = AuthenticatorFlags & {
  readonly challenge: string;
  readonly origin: string;
  readonly rpId: string;
  readonly counter?: number;
};

/**
 * テスト用の認証器。
 *
 * P-256 の鍵を本当に作り、本当に署名する。Origin / RP ID / UV / カウンターを
 * 自由に差し替えられるので、「検証が落ちること」を実物の
 * `@simplewebauthn/server` に対して確かめられる。CBOR の組み立てには
 * ライブラリの helpers をそのまま使う（独自実装を増やさない）。
 */
export class TestAuthenticator {
  private constructor(
    readonly credentialId: string,
    private readonly privateKey: CryptoKey,
    private readonly cosePublicKey: Bytes,
  ) {}

  static async create(credentialId = "test-credential"): Promise<TestAuthenticator> {
    const keyPair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const jwk = (await crypto.subtle.exportKey("jwk", keyPair.publicKey)) as JsonWebKey;

    // COSE_Key (EC2 / ES256): kty=2, alg=-7, crv=1(P-256), x, y
    const cose = isoCBOR.encode(
      new Map<string | number, Cbor>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, isoBase64URL.toBuffer(jwk.x ?? "")],
        [-3, isoBase64URL.toBuffer(jwk.y ?? "")],
      ]),
    );

    return new TestAuthenticator(
      isoBase64URL.fromBuffer(utf8(credentialId)),
      keyPair.privateKey,
      cose,
    );
  }

  /** `navigator.credentials.create()` の戻り値に相当する JSON。 */
  async attest(options: AttestationOptions): Promise<Record<string, unknown>> {
    const clientDataJSON = this.clientData("webauthn.create", options.challenge, options.origin);
    const credentialIdBytes = isoBase64URL.toBuffer(this.credentialId);
    const attestedCredentialData = concat([
      AAGUID,
      new Uint8Array([credentialIdBytes.length >> 8, credentialIdBytes.length & 0xff]),
      credentialIdBytes,
      this.cosePublicKey,
    ]);
    const authData = concat([
      await sha256(utf8(options.rpId)),
      new Uint8Array([this.flags(options) | FLAG.attestedCredentialData]),
      uint32(options.counter ?? 0),
      attestedCredentialData,
    ]);

    const attestationObject = isoCBOR.encode(
      new Map<string | number, Cbor>([
        ["fmt", "none"],
        ["attStmt", new Map<string | number, Cbor>()],
        ["authData", authData],
      ]),
    );

    return {
      id: this.credentialId,
      rawId: this.credentialId,
      type: "public-key",
      clientExtensionResults: {},
      response: {
        clientDataJSON: isoBase64URL.fromBuffer(clientDataJSON),
        attestationObject: isoBase64URL.fromBuffer(attestationObject),
        transports: ["internal"],
      },
    };
  }

  /** `navigator.credentials.get()` の戻り値に相当する JSON。 */
  async assert(options: AssertionOptions): Promise<Record<string, unknown>> {
    const clientDataJSON = this.clientData("webauthn.get", options.challenge, options.origin);
    const authData = concat([
      await sha256(utf8(options.rpId)),
      new Uint8Array([this.flags(options)]),
      uint32(options.counter),
    ]);

    const signed = concat([authData, await sha256(clientDataJSON)]);
    const raw = new Uint8Array(
      await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, this.privateKey, signed),
    );

    return {
      id: this.credentialId,
      rawId: this.credentialId,
      type: "public-key",
      clientExtensionResults: {},
      response: {
        clientDataJSON: isoBase64URL.fromBuffer(clientDataJSON),
        authenticatorData: isoBase64URL.fromBuffer(authData),
        signature: isoBase64URL.fromBuffer(toDerSignature(raw)),
      },
    };
  }

  private flags(options: AuthenticatorFlags): number {
    // User Presence は常に立てる。ここを落とすと UV 以前の段階で弾かれ、
    // 「UV を要求していること」のテストにならない。
    let flags = FLAG.userPresent;
    if (options.userVerified !== false) flags |= FLAG.userVerified;
    if (options.backedUp !== false) flags |= FLAG.backupEligible | FLAG.backedUp;
    return flags;
  }

  private clientData(type: string, challenge: string, origin: string): Bytes {
    return utf8(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  }
}

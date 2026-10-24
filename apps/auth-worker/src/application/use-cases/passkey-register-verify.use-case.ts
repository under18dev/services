import { newId } from "@u18/domain";
import type { AuditLogger } from "../ports/audit-log.port";
import type { Clock } from "../ports/clock.port";
import type { PasskeyRepository } from "../ports/passkey.repository";
import type { WebAuthnChallengeRepository } from "../ports/webauthn-challenge.repository";
import type { WebAuthnResponseJson, WebAuthnService } from "../ports/webauthn.port";
import type { GetSessionUseCase } from "./get-session.use-case";
import { settleSideEffects } from "./side-effects";
import { err, ok, type UseCaseResult } from "./types";

export type PasskeyRegisterVerifyCommand = {
  readonly sessionToken: string;
  readonly challengeId: string;
  readonly response: WebAuthnResponseJson;
  /** 利用者が端末を見分けるための名前。省略可。 */
  readonly label: string | null;
};

export type PasskeyRegisterVerifyOutput = {
  readonly passkeyId: string;
  readonly credentialId: string;
};

export type PasskeyRegisterVerifyDeps = {
  readonly getSession: GetSessionUseCase;
  readonly passkeys: PasskeyRepository;
  readonly challenges: WebAuthnChallengeRepository;
  readonly webauthn: WebAuthnService;
  readonly clock: Clock;
  readonly audit: AuditLogger;
};

/** 登録の失敗はすべて同じ応答にする。どこで落ちたかを返す必要がない。 */
const REGISTRATION_FAILED = "passkey registration failed";

/**
 * パスキーの登録を完了する（仕様書 6.1 / 9）。
 *
 * Origin / RP ID / User Verification の検証は Port 実装の責務（webauthn.port.ts）。
 * ここで守るのは「Challenge を単回で消費すること」と
 * 「他人のものになっている Credential ID を奪わせないこと」の 2 点。
 */
export class PasskeyRegisterVerifyUseCase {
  constructor(private readonly deps: PasskeyRegisterVerifyDeps) {}

  async execute(
    command: PasskeyRegisterVerifyCommand,
  ): Promise<UseCaseResult<PasskeyRegisterVerifyOutput>> {
    const auth = await this.deps.getSession.execute({ sessionToken: command.sessionToken });
    if (!auth.ok) return auth;
    if (auth.value === null) return err("unauthenticated", "session is not valid");

    const { userId } = auth.value;
    const now = this.deps.clock.now();

    // 検証より先に消費する。先に検証すると、同じ Challenge に対して
    // 何度でも署名を試せる窓が残る。
    const challenge = await this.deps.challenges.consume(command.challengeId, now);
    if (challenge === null) return this.fail(userId, "challenge_unavailable");
    if (challenge.isExpiredAt(now)) return this.fail(userId, "challenge_expired");
    if (!challenge.isBoundTo("registration", userId)) {
      return this.fail(userId, "challenge_not_bound");
    }

    const verification = await this.deps.webauthn.verifyRegistration({
      response: command.response,
      expectedChallenge: challenge.challenge,
    });
    if (!verification.verified) return this.fail(userId, verification.reason);

    const credential = verification.value;

    // すでに誰かのものになっている Credential は受け付けない。
    // 他人の Credential ID で行を作れると、その認証器での認証が
    // 自分のアカウントへ結びつく。
    const existing = await this.deps.passkeys.findByCredentialId(credential.credentialId);
    if (existing !== null) {
      return this.fail(userId, existing.userId === userId ? "already_registered" : "taken");
    }

    const passkey = await this.deps.passkeys.create({
      id: newId("pky"),
      userId,
      credentialId: credential.credentialId,
      publicKey: credential.publicKey,
      counter: credential.counter,
      aaguid: credential.aaguid,
      deviceType: credential.deviceType,
      backedUp: credential.backedUp,
      transports: credential.transports,
      label: command.label,
    });
    // 上の findByCredentialId と create の間に割り込まれた場合。
    // 一意制約で負けた側はここへ来る。
    if (passkey === null) return this.fail(userId, "taken");

    await settleSideEffects(
      "passkey.register",
      this.deps.audit.record({
        event: "passkey.register",
        userId,
        outcome: "success",
        metadata: { passkeyId: passkey.id, deviceType: credential.deviceType },
      }),
    );

    return ok({ passkeyId: passkey.id, credentialId: passkey.credentialId });
  }

  private async fail(userId: string, reason: string): Promise<UseCaseResult<never>> {
    // 監査ログには理由を残すが、応答には出さない。
    await settleSideEffects(
      "passkey.register",
      this.deps.audit.record({
        event: "passkey.register",
        userId,
        outcome: "failure",
        reason,
      }),
    );
    return err("invalid_input", REGISTRATION_FAILED);
  }
}

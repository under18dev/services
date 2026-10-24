import { newId } from "@u18/domain";
import { TokenLifetime, expiresAt } from "../../domain/services/token-lifetime";
import type { Clock } from "../ports/clock.port";
import type { PasskeyRepository } from "../ports/passkey.repository";
import type { UserRepository } from "../ports/user.repository";
import type { WebAuthnChallengeRepository } from "../ports/webauthn-challenge.repository";
import type { WebAuthnOptionsJson, WebAuthnService } from "../ports/webauthn.port";
import type { GetSessionUseCase } from "./get-session.use-case";
import { err, ok, type UseCaseResult } from "./types";

export type PasskeyRegisterOptionsCommand = {
  readonly sessionToken: string;
};

export type PasskeyRegisterOptionsOutput = {
  /**
   * 検証時に「どの Challenge か」を指すための ID。
   *
   * 秘密ではない。Challenge 本体は署名された clientDataJSON と照合されるので、
   * 他人の ID を指定しても検証は通らない。
   */
  readonly challengeId: string;
  readonly options: WebAuthnOptionsJson;
};

export type PasskeyRegisterOptionsDeps = {
  readonly getSession: GetSessionUseCase;
  readonly users: UserRepository;
  readonly passkeys: PasskeyRepository;
  readonly challenges: WebAuthnChallengeRepository;
  readonly webauthn: WebAuthnService;
  readonly clock: Clock;
};

/**
 * パスキー登録の Challenge を発行する（仕様書 6.1）。
 *
 * **ログイン済みであることが前提**。未認証でここを通すと、他人のアカウントへ
 * 自分の認証器を足せてしまう。対象ユーザーは常にセッションから導き、
 * 呼び出し元が申告した userId は受け取らない。
 */
export class PasskeyRegisterOptionsUseCase {
  constructor(private readonly deps: PasskeyRegisterOptionsDeps) {}

  async execute(
    command: PasskeyRegisterOptionsCommand,
  ): Promise<UseCaseResult<PasskeyRegisterOptionsOutput>> {
    const auth = await this.deps.getSession.execute({ sessionToken: command.sessionToken });
    if (!auth.ok) return auth;
    if (auth.value === null) return err("unauthenticated", "session is not valid");

    const { userId } = auth.value;

    // 表示名と登録済み Credential は互いに独立なので同時に引く。
    // どちらも options に必須なので allSettled ではなく all —— 片方を
    // 握り潰すと、二重登録を抑止する excludeCredentials が静かに空になる。
    const [user, registered] = await Promise.all([
      this.deps.users.findById(userId),
      this.deps.passkeys.listByUserId(userId),
    ]);
    if (user === null) return err("unauthenticated", "session is not valid");

    const options = await this.deps.webauthn.createRegistrationOptions({
      userId: user.id,
      userName: user.username,
      userDisplayName: user.displayName,
      excludeCredentialIds: registered.map((passkey) => passkey.credentialId),
    });

    const now = this.deps.clock.now();
    const challenge = await this.deps.challenges.create({
      id: newId("wac"),
      userId,
      challenge: options.challenge,
      purpose: "registration",
      expiresAt: expiresAt(now, TokenLifetime.webauthnChallengeMs),
    });

    return ok({ challengeId: challenge.id, options: options.json });
  }
}

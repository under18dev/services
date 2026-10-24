import { newId } from "@u18/domain";
import { TokenLifetime, expiresAt } from "../../domain/services/token-lifetime";
import type { Clock } from "../ports/clock.port";
import type { WebAuthnChallengeRepository } from "../ports/webauthn-challenge.repository";
import type { WebAuthnOptionsJson, WebAuthnService } from "../ports/webauthn.port";
import { ok, type UseCaseResult } from "./types";

export type PasskeyLoginOptionsOutput = {
  readonly challengeId: string;
  readonly options: WebAuthnOptionsJson;
};

export type PasskeyLoginOptionsDeps = {
  readonly challenges: WebAuthnChallengeRepository;
  readonly webauthn: WebAuthnService;
  readonly clock: Clock;
};

/**
 * ログイン用の Challenge を発行する（仕様書 6.1）。
 *
 * **入力を一切受け取らない。** メールアドレスや username を受け取って
 * allowCredentials を返す設計にすると、応答の差でアカウントの実在が分かる
 * （仕様書 9）。discoverable credential 前提にすれば、そもそも
 * 誰のログインか分からないまま Challenge を出せる。
 */
export class PasskeyLoginOptionsUseCase {
  constructor(private readonly deps: PasskeyLoginOptionsDeps) {}

  async execute(): Promise<UseCaseResult<PasskeyLoginOptionsOutput>> {
    const options = await this.deps.webauthn.createAuthenticationOptions();

    const now = this.deps.clock.now();
    const challenge = await this.deps.challenges.create({
      // 誰のログインかまだ分からないので userId は持たせない。
      id: newId("wac"),
      userId: null,
      challenge: options.challenge,
      purpose: "authentication",
      expiresAt: expiresAt(now, TokenLifetime.webauthnChallengeMs),
    });

    return ok({ challengeId: challenge.id, options: options.json });
  }
}

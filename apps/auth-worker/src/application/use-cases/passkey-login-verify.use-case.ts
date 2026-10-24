import type { Session } from "../../domain/entities/session";
import type { AuditLogger } from "../ports/audit-log.port";
import type { Clock } from "../ports/clock.port";
import type { PasskeyRepository } from "../ports/passkey.repository";
import type { UserRepository } from "../ports/user.repository";
import type { WebAuthnChallengeRepository } from "../ports/webauthn-challenge.repository";
import type { WebAuthnResponseJson, WebAuthnService } from "../ports/webauthn.port";
import type { IssueSessionUseCase } from "./issue-session.use-case";
import { settleSideEffects } from "./side-effects";
import { err, ok, type UseCaseResult } from "./types";

export type PasskeyLoginVerifyCommand = {
  readonly challengeId: string;
  readonly response: WebAuthnResponseJson;
  readonly userAgent: string | null;
  /** 生 IP。保存前にハッシュ化される（仕様書 9 Privacy）。 */
  readonly ip: string | null;
};

export type PasskeyLoginVerifyOutput = {
  readonly session: Session;
  /** 平文のセッショントークン。Cookie に載せる機会はこの一度だけ。 */
  readonly token: string;
};

export type PasskeyLoginVerifyDeps = {
  readonly issueSession: IssueSessionUseCase;
  readonly users: UserRepository;
  readonly passkeys: PasskeyRepository;
  readonly challenges: WebAuthnChallengeRepository;
  readonly webauthn: WebAuthnService;
  readonly clock: Clock;
  readonly audit: AuditLogger;
};

/**
 * ログインの失敗はすべてこの 1 つに畳み込む（仕様書 9）。
 *
 * 「その Credential は知らない」「そのユーザーは停止中」「署名が不正」を
 * 区別して返すと、アカウントや認証器の実在を外から確かめられる。
 */
const AUTHENTICATION_FAILED = "passkey authentication failed";

/**
 * パスキーでログインする（仕様書 6.1）。
 *
 * Origin / RP ID / User Verification / 署名の検証は Port 実装が行う。
 * ここが持つのは「Challenge の単回消費」「サインカウンターの巻き戻り拒否」
 * 「停止・削除済みユーザーの排除」と、成功後のセッション発行。
 */
export class PasskeyLoginVerifyUseCase {
  constructor(private readonly deps: PasskeyLoginVerifyDeps) {}

  async execute(
    command: PasskeyLoginVerifyCommand,
  ): Promise<UseCaseResult<PasskeyLoginVerifyOutput>> {
    const now = this.deps.clock.now();

    // 署名の検証より先に消費する。同じ Challenge を使い回して何度も
    // 署名を試せる窓を残さない。
    const challenge = await this.deps.challenges.consume(command.challengeId, now);
    if (challenge === null) return this.fail(undefined, "challenge_unavailable");
    if (challenge.isExpiredAt(now)) return this.fail(undefined, "challenge_expired");
    // 登録用の Challenge をログインへ流用させない。discoverable なので userId は null。
    if (!challenge.isBoundTo("authentication", null)) {
      return this.fail(undefined, "challenge_not_bound");
    }

    const passkey = await this.deps.passkeys.findByCredentialId(command.response.id);
    if (passkey === null) return this.fail(undefined, "unknown_credential");

    const verification = await this.deps.webauthn.verifyAuthentication({
      response: command.response,
      expectedChallenge: challenge.challenge,
      credential: {
        credentialId: passkey.credentialId,
        publicKey: passkey.publicKey,
        counter: passkey.counter,
        transports: passkey.transports,
      },
    });
    if (!verification.verified) return this.fail(passkey.userId, verification.reason);

    // 巻き戻ったカウンターは Credential の複製を示唆する（仕様書 9 WebAuthn）。
    // Port 実装側のライブラリも同じ検査を持つが、これは実装の都合に左右されて
    // よい判断ではないので Domain のルールとして独立に確かめる。
    if (!passkey.acceptsCounter(verification.value.newCounter)) {
      return this.fail(passkey.userId, "counter_regression");
    }

    const user = await this.deps.users.findById(passkey.userId);
    // 停止・論理削除されたユーザーは、認証器が正しくてもログインさせない。
    // `isActive` は status と deletedAt の両方を見る。
    if (user === null || !user.isActive) return this.fail(passkey.userId, "user_not_active");

    // カウンターの前進も条件付き UPDATE。同じカウンターでの同時ログインが
    // 両方とも成立しないようにする。負けた側はログインさせない。
    const advanced = await this.deps.passkeys.recordUse(
      passkey.credentialId,
      verification.value.newCounter,
      now,
    );
    if (!advanced) return this.fail(passkey.userId, "counter_not_advanced");

    const issued = await this.deps.issueSession.execute({
      userId: user.id,
      authMethod: "passkey",
      userAgent: command.userAgent,
      ip: command.ip,
    });
    // 発行側のエラーコードをそのまま返さない。ユーザーの状態が応答に漏れる。
    if (!issued.ok) return this.fail(user.id, `issue_session:${issued.error.code}`);

    await settleSideEffects(
      "passkey.login",
      this.deps.audit.record({
        event: "passkey.login",
        userId: user.id,
        outcome: "success",
        metadata: { passkeyId: passkey.id },
      }),
    );

    return ok(issued.value);
  }

  private async fail(userId: string | undefined, reason: string): Promise<UseCaseResult<never>> {
    await settleSideEffects(
      "passkey.login",
      this.deps.audit.record({
        event: "passkey.login",
        userId,
        outcome: "failure",
        reason,
      }),
    );
    return err("unauthenticated", AUTHENTICATION_FAILED);
  }
}

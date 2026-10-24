import type {
  WebAuthnChallenge,
  WebAuthnChallengePurpose,
} from "../../domain/entities/webauthn-challenge";

export type CreateWebAuthnChallengeInput = {
  readonly id: string;
  /** 登録フローでは確定済み、認証フロー（discoverable）では null。 */
  readonly userId: string | null;
  readonly challenge: string;
  readonly purpose: WebAuthnChallengePurpose;
  readonly expiresAt: Date;
};

export interface WebAuthnChallengeRepository {
  create(input: CreateWebAuthnChallengeInput): Promise<WebAuthnChallenge>;
  /**
   * Challenge を単回消費する。消費できなければ null。
   *
   * `consumed_at IS NULL` を条件にした UPDATE で、同じ Challenge に対する
   * 同時検証は片方しか通らない（仕様書 9 WebAuthn の単回使用）。
   * 返すのは更新後の行なので `consumedAt` は埋まっている。期限と用途の
   * 判定は呼び出し側（Domain）が行う。
   */
  consume(id: string, at: Date): Promise<WebAuthnChallenge | null>;
}

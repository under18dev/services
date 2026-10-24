import type { Passkey, PasskeyDeviceType } from "../../domain/entities/passkey";

export type NewPasskey = {
  readonly id: string;
  readonly userId: string;
  readonly credentialId: string;
  readonly publicKey: string;
  readonly counter: number;
  readonly aaguid: string | null;
  readonly deviceType: PasskeyDeviceType | null;
  readonly backedUp: boolean;
  readonly transports: readonly string[] | null;
  readonly label: string | null;
};

export interface PasskeyRepository {
  findByCredentialId(credentialId: string): Promise<Passkey | null>;
  /** 内部 ID で引く。利用者の管理画面は Credential ID ではなくこちらを扱う。 */
  findById(id: string): Promise<Passkey | null>;
  listByUserId(userId: string): Promise<readonly Passkey[]>;
  /**
   * 登録する。Credential ID がすでに使われていれば null を返す。
   *
   * 「引いてから入れる」では、同じ Credential を 2 人が同時に登録する競合を
   * 防げない。一意制約の判定を DB に任せ、負けた側へ null を返す。
   */
  create(input: NewPasskey): Promise<Passkey | null>;
  /**
   * 認証成功を記録し、サインカウンターを進める。
   *
   * `counter <= :next` を条件にした UPDATE なので、巻き戻った値では行が
   * 更新されず false になる（仕様書 9 WebAuthn）。カウンターを実装しない
   * 認証器は常に 0 を送ってくるため、等号は許す。
   */
  recordUse(credentialId: string, counter: number, at: Date): Promise<boolean>;
  /**
   * 自分の Credential を 1 本削除する。実際に消えたときだけ true。
   *
   * userId を条件に含め、UseCase 側の所有者チェックと二重化する。破壊的な
   * 文が id だけで成立する形にしておくと、呼び出し側の 1 行の取り違えが
   * そのまま「他人の認証器を剥奪できる」になる。
   *
   * 行は論理削除せず消す。認証器を外したのに `passkeys` に行が残っていると、
   * 将来の問い合わせが「生きている Credential」として拾い直す危険がある。
   * 外したという事実は監査ログ（passkey.deleted）に残す。
   */
  deleteOwned(id: string, userId: string): Promise<boolean>;
}

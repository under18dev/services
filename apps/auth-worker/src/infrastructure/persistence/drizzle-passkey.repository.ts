import { type IdentityDatabase, passkeys } from "@u18/db";
import { and, eq, lte } from "drizzle-orm";
import type { NewPasskey, PasskeyRepository } from "../../application/ports/passkey.repository";
import { Passkey, type PasskeyDeviceType, type PasskeyProps } from "../../domain/entities/passkey";

type PasskeyRow = typeof passkeys.$inferSelect;

/**
 * transports は JSON 配列文字列で保存されている。
 *
 * 壊れた値で認証全体を落とさない。transports はブラウザに「どの経路で
 * 認証器を探すか」を助言するだけの情報で、無くても認証は成立する。
 */
function parseTransports(value: string | null): readonly string[] | null {
  if (value === null) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string") : null;
  } catch {
    return null;
  }
}

function toDomain(row: PasskeyRow): Passkey {
  const props: PasskeyProps = {
    id: row.id,
    userId: row.userId,
    credentialId: row.credentialId,
    publicKey: row.publicKey,
    counter: row.counter,
    aaguid: row.aaguid,
    // 列は自由文字列だが、Domain では 2 値に閉じる。想定外の値は「不明」扱い。
    deviceType: row.deviceType === null ? null : (row.deviceType as PasskeyDeviceType),
    backedUp: row.backedUp,
    transports: parseTransports(row.transports),
    label: row.label,
    lastUsedAt: row.lastUsedAt,
    createdAt: row.createdAt,
  };
  return Passkey.fromPersistence(props);
}

export class DrizzlePasskeyRepository implements PasskeyRepository {
  constructor(private readonly db: IdentityDatabase) {}

  async findByCredentialId(credentialId: string): Promise<Passkey | null> {
    const row = await this.db
      .select()
      .from(passkeys)
      .where(eq(passkeys.credentialId, credentialId))
      .get();
    return row ? toDomain(row) : null;
  }

  async findById(id: string): Promise<Passkey | null> {
    const row = await this.db.select().from(passkeys).where(eq(passkeys.id, id)).get();
    return row ? toDomain(row) : null;
  }

  async listByUserId(userId: string): Promise<readonly Passkey[]> {
    const rows = await this.db.select().from(passkeys).where(eq(passkeys.userId, userId)).all();
    return rows.map(toDomain);
  }

  async create(input: NewPasskey): Promise<Passkey | null> {
    // 一意制約（credential_id）の判定を DB に任せる。衝突は例外にせず
    // null で返し、呼び出し側が「登録できなかった」として扱えるようにする。
    const row = await this.db
      .insert(passkeys)
      .values({
        id: input.id,
        userId: input.userId,
        credentialId: input.credentialId,
        publicKey: input.publicKey,
        counter: input.counter,
        aaguid: input.aaguid,
        deviceType: input.deviceType,
        backedUp: input.backedUp,
        transports: input.transports === null ? null : JSON.stringify(input.transports),
        label: input.label,
      })
      .onConflictDoNothing({ target: passkeys.credentialId })
      .returning()
      .get();
    return row ? toDomain(row) : null;
  }

  async recordUse(credentialId: string, counter: number, at: Date): Promise<boolean> {
    // `counter <= :next` を条件に入れることで、巻き戻った値では行が更新されず
    // false になる（仕様書 9 WebAuthn）。等号を許すのは、カウンターを実装しない
    // 認証器が常に 0 を送ってくるため。リプレイ自体は Challenge の単回消費で塞ぐ。
    const rows = await this.db
      .update(passkeys)
      .set({ counter, lastUsedAt: at })
      .where(and(eq(passkeys.credentialId, credentialId), lte(passkeys.counter, counter)))
      .returning({ id: passkeys.id })
      .all();
    return rows.length > 0;
  }

  async deleteOwned(id: string, userId: string): Promise<boolean> {
    // 所有者の条件を DELETE 自身に持たせる。UseCase 側の判定と二重化して、
    // この 1 文だけを見ても他人の行に当たらないことが分かる形にする。
    const rows = await this.db
      .delete(passkeys)
      .where(and(eq(passkeys.id, id), eq(passkeys.userId, userId)))
      .returning({ id: passkeys.id })
      .all();
    return rows.length > 0;
  }
}

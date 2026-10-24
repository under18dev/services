import type { IdentityDatabase } from "@u18/db";
import { sql } from "drizzle-orm";
import type { DatabaseProbe } from "../../application/ports/health.port";

export class DrizzleDatabaseProbe implements DatabaseProbe {
  constructor(private readonly db: IdentityDatabase) {}

  async ping(): Promise<boolean> {
    try {
      await this.db.run(sql`select 1`);
      return true;
    } catch (error) {
      // 到達できないこと自体が答えなので、ここで投げ直さない。
      console.error("database probe failed", error);
      return false;
    }
  }
}

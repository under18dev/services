import { fetchDiscovery, fetchJwks, type DiscoveryDocument, type Jwks } from "./discovery";
import type { Clock } from "../composition/container";

/**
 * Discovery / JWKS を Worker のアイソレート内で使い回す。
 *
 * ## なぜキャッシュするか
 *
 * `/login` と `/callback` の両方が Discovery を要る。キャッシュしないと
 * 毎回の認可要求のたびに auth-worker へ往復が増える。Discovery は
 * **公開メタデータで、IdP 自身が `Cache-Control: public, max-age=300` を
 * 付けて「キャッシュしてよい」と言っている**（`oauth.routes.ts`）。
 * ここではその 300 秒をそのまま採る——**IdP 側の値と揃えるのは、
 * 片方だけ動かすと「Discovery は新しいが JWKS は古い」状態が生まれる
 * のを避けるため**（あちらのコメントと同じ理由）。
 *
 * ## Workers のアイソレートはいつ消えるか分からない
 *
 * キャッシュはベストエフォートで、無くても正しさは壊れない
 * （無ければ毎回取りに行くだけ）。**キャッシュが無いと落ちる設計にしない。**
 */

const TTL_MS = 5 * 60 * 1000;

export class DiscoveryCache {
  private cached: {
    readonly doc: DiscoveryDocument;
    readonly jwks: Jwks;
    readonly at: number;
  } | null = null;

  constructor(
    private readonly fetcher: typeof fetch,
    private readonly issuer: string,
    private readonly clock: Clock,
  ) {}

  async get(): Promise<{ readonly doc: DiscoveryDocument; readonly jwks: Jwks }> {
    const now = this.clock.now().getTime();
    if (this.cached !== null && now - this.cached.at < TTL_MS) {
      return this.cached;
    }
    const doc = await fetchDiscovery(this.fetcher, this.issuer);
    const jwks = await fetchJwks(this.fetcher, doc.jwks_uri);
    this.cached = { doc, jwks, at: now };
    return this.cached;
  }
}

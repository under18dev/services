import type { IdentityGateway } from "../application/ports";
import { RpcIdentityGateway, asIdentityRpc } from "../infrastructure/rpc/identity.gateway";

/**
 * 依存性の組み立て（仕様書 2.3）。
 *
 * Cloudflare の `Env` を知ってよいのはこの層だけ。Presentation からは
 * `IdentityGateway`（Port）の型しか見えない。
 *
 * **この Worker は D1 を持たない。** 認証 DB の読み書きは auth-worker に
 * 集約されており、ここが組み立てるのは RPC の Gateway だけである
 * （仕様書 2.2 / 4.1）。将来ここに Repository が増えたら、それは
 * dashboard が DB を直接触り始めたということなので、設計を見直すこと。
 */
export type Container = {
  /**
   * **この Worker が持つ Gateway はこれ 1 本である**（#433）。
   *
   * かつては管理用の `identityAdmin`（auth-worker の `IdentityAdminRPC`
   * を束縛した別 binding）も組み立てていた。運営向けの画面を
   * `admin.under18.dev` へ移したので、呼ぶ側ごと消した —— **あちらは
   * `IdentityAdminDelegatedRPC` を自分で束縛している。**
   *
   * **binding も `wrangler.jsonc` から落としてある。** 誰も呼ばない
   * binding を残すと、この Worker は「管理用の口を叩ける権限」だけを
   * 持ち続ける。Service Binding はメソッド単位で絞れないので、
   * **残っていること自体が到達範囲である**（#308 / 脅威モデル RR-21）。
   */
  readonly identity: IdentityGateway;
};

/**
 * リクエストごとに組み立てる。
 *
 * Workers では `Env` がリクエスト単位で渡るため、モジュールスコープに
 * キャッシュしない。生成コストはオブジェクト確保のみ。
 */
export function createContainer(env: Env): Container {
  return { identity: new RpcIdentityGateway(asIdentityRpc(env.IDENTITY)) };
}

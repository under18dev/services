import type { IdentityAdminGateway, IdentityGateway } from "../application/ports";
import { RpcIdentityGateway, asIdentityRpc } from "../infrastructure/rpc/identity.gateway";
import {
  RpcIdentityAdminGateway,
  asIdentityAdminRpc,
} from "../infrastructure/rpc/identity-admin.gateway";

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
  readonly identity: IdentityGateway;
  /**
   * 管理用（#333）。**別の binding（`IDENTITY_ADMIN`）から組み立てる。**
   *
   * ここで `env.IDENTITY` を渡しても型は通る（どちらも `Fetcher`）が、
   * **呼んだ先に管理用のメソッドは無い**ので実行時に落ちる。
   * `asIdentityAdminRpc` を分けてあるのはその取り違えを 1 箇所に
   * 閉じ込めるためで、**渡す binding を間違えないのはここの責任である。**
   */
  readonly identityAdmin: IdentityAdminGateway;
};

/**
 * リクエストごとに組み立てる。
 *
 * Workers では `Env` がリクエスト単位で渡るため、モジュールスコープに
 * キャッシュしない。生成コストはオブジェクト確保のみ。
 */
export function createContainer(env: Env): Container {
  return {
    identity: new RpcIdentityGateway(asIdentityRpc(env.IDENTITY)),
    identityAdmin: new RpcIdentityAdminGateway(asIdentityAdminRpc(env.IDENTITY_ADMIN)),
  };
}

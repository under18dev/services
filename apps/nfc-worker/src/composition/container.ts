import { systemClock } from "@u18/domain";
import { createNfcDatabase } from "@u18/nfc-db";
import type { CardRepository, ExpiredEventPurger, IdentityGateway } from "../application/ports";
import { ClaimCardUseCase } from "../application/use-cases/claim-card.use-case";
import { DisableCardUseCase } from "../application/use-cases/disable-card.use-case";
import { IssueCardsUseCase } from "../application/use-cases/issue-cards.use-case";
import { ListMyCardsUseCase } from "../application/use-cases/list-cards.use-case";
import { ReleaseCardUseCase } from "../application/use-cases/release-card.use-case";
import { PurgeExpiredEventsUseCase } from "../application/use-cases/purge-expired-events.use-case";
import { ResolveCardUseCase } from "../application/use-cases/resolve-card.use-case";
import { UpdateCardTargetUseCase } from "../application/use-cases/update-card-target.use-case";
import { ViewClaimUseCase } from "../application/use-cases/view-claim.use-case";
import { DrizzleCardEventRecorder } from "../infrastructure/persistence/drizzle-card-event.recorder";
import { DrizzleCardRepository } from "../infrastructure/persistence/drizzle-card.repository";
import { DrizzleExpiredEventPurger } from "../infrastructure/persistence/drizzle-expired-event.purger";
import { RpcIdentityGateway, asIdentityRpc } from "../infrastructure/rpc/identity.gateway";

/**
 * 依存性の組み立て（仕様書 2.3）。
 *
 * **`Env` を読んでよい唯一の場所。** ここから下の層は `Env` を知らない。
 *
 * `createContainer(env)` はリクエストごとに呼ばれる。Workers では `Env` が
 * リクエスト単位で渡るのでモジュールスコープにキャッシュできない。
 * 生成コストはオブジェクト確保だけで、`createNfcDatabase()` も D1 への
 * 接続を張るわけではない（binding をラップするだけ）。
 *
 * テストから任意の Port を差し替えられるよう、上書きを受け取る。
 * `IdentityGateway` の fake を差せば、Service Binding 無しで
 * 認可の分岐を検証できる。
 */
export type ContainerOverrides = {
  readonly identity?: IdentityGateway;
  readonly cards?: CardRepository;
  readonly eventPurger?: ExpiredEventPurger;
};

export type Container = ReturnType<typeof createContainer>;

/**
 * カードの遷移先にできないオリジン。
 *
 * IdP 自身を弾く。`https://auth.under18.dev/...` へ飛ぶ短縮 URL を
 * 利用者が自由に作れると、ログイン画面や同意画面を踏ませる導線を
 * 外部から組み立てられる（target-url.ts の 5 を参照）。
 *
 * この Worker 自身のオリジンも弾く。`go.under18.dev/c/A` →
 * `go.under18.dev/c/B` のような連鎖を作れると、1 枚のカードから
 * 任意の深さのリダイレクトチェーンが生え、無効化の効き方が読めなくなる。
 */
function blockedTargetOrigins(env: Env): readonly string[] {
  return [env.AUTH_ISSUER, env.SHORT_URL_ORIGIN];
}

export function createContainer(env: Env, overrides: ContainerOverrides = {}) {
  const db = createNfcDatabase(env.NFC_DB);

  const cards = overrides.cards ?? new DrizzleCardRepository(db);
  const events = new DrizzleCardEventRecorder(db);
  const identity = overrides.identity ?? new RpcIdentityGateway(asIdentityRpc(env.IDENTITY));
  // 保持期限を過ぎたカードイベントの掃除。scheduled からしか使わないが、
  // Port の配線先はここ 1 箇所に揃える（auth-worker の purger と同じ）。
  const eventPurger = overrides.eventPurger ?? new DrizzleExpiredEventPurger(db);
  const clock = systemClock;

  return {
    repositories: { cards },
    services: { identity, clock },
    useCases: {
      resolveCard: new ResolveCardUseCase(cards),
      listMyCards: new ListMyCardsUseCase(identity, cards),
      updateCardTarget: new UpdateCardTargetUseCase(
        identity,
        cards,
        events,
        clock,
        blockedTargetOrigins(env),
      ),
      disableCard: new DisableCardUseCase(identity, cards, events, clock),
      claimCard: new ClaimCardUseCase(identity, cards, events, clock),
      issueCards: new IssueCardsUseCase(identity, cards, events, clock),
      releaseCard: new ReleaseCardUseCase(identity, cards, events, clock),
      viewClaim: new ViewClaimUseCase(identity, cards),
      purgeExpiredEvents: new PurgeExpiredEventsUseCase({ purger: eventPurger, clock }),
    },
  };
}

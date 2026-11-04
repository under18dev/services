import { systemClock } from "@u18/domain";
import { createNfcDatabase } from "@u18/nfc-db";
import type {
  CardRepository,
  CardTapRecorder,
  ExpiredEventPurger,
  ExpiredTapPurger,
  IdentityGateway,
} from "../application/ports";
import { AdminDisableCardUseCase } from "../application/use-cases/admin-disable-card.use-case";
import { DelegatedBatchDisableCardsUseCase } from "../application/use-cases/delegated-batch-disable-cards.use-case";
import { DelegatedCountBatchIssuedCardsUseCase } from "../application/use-cases/delegated-count-batch-issued-cards.use-case";
import { DelegatedCountDisabledInBatchUseCase } from "../application/use-cases/delegated-count-disabled-in-batch.use-case";
import { DelegatedDisableCardUseCase } from "../application/use-cases/delegated-disable-card.use-case";
import { DelegatedIssueCardsUseCase } from "../application/use-cases/delegated-issue-cards.use-case";
import { DelegatedCountCardsUseCase } from "../application/use-cases/delegated-count-cards.use-case";
import { DelegatedListAllCardsUseCase } from "../application/use-cases/delegated-list-all-cards.use-case";
import { DelegatedReinstateBatchToIssuedCardsUseCase } from "../application/use-cases/delegated-reinstate-batch-to-issued-cards.use-case";
import { DelegatedReinstateCardToIssuedUseCase } from "../application/use-cases/delegated-reinstate-card-to-issued.use-case";
import { DelegatedReinstateCardUseCase } from "../application/use-cases/delegated-reinstate-card.use-case";
import { DelegatedReleaseCardUseCase } from "../application/use-cases/delegated-release-card.use-case";
import { DelegatedUpdateCardTargetUseCase } from "../application/use-cases/delegated-update-card-target.use-case";
import { ClaimCardUseCase } from "../application/use-cases/claim-card.use-case";
import { DisableCardUseCase } from "../application/use-cases/disable-card.use-case";
import { IssueCardsUseCase } from "../application/use-cases/issue-cards.use-case";
import { ListAllCardsUseCase } from "../application/use-cases/list-all-cards.use-case";
import { ListMyCardsUseCase } from "../application/use-cases/list-cards.use-case";
import { ReleaseCardUseCase } from "../application/use-cases/release-card.use-case";
import { PurgeExpiredEventsUseCase } from "../application/use-cases/purge-expired-events.use-case";
import { PurgeExpiredTapsUseCase } from "../application/use-cases/purge-expired-taps.use-case";
import { ResolveCardUseCase } from "../application/use-cases/resolve-card.use-case";
import { UpdateCardTargetUseCase } from "../application/use-cases/update-card-target.use-case";
import { ViewClaimUseCase } from "../application/use-cases/view-claim.use-case";
import { DrizzleCardEventRecorder } from "../infrastructure/persistence/drizzle-card-event.recorder";
import { DrizzleCardRepository } from "../infrastructure/persistence/drizzle-card.repository";
import { DrizzleCardTapRecorder } from "../infrastructure/persistence/drizzle-card-tap.recorder";
import { DrizzleExpiredEventPurger } from "../infrastructure/persistence/drizzle-expired-event.purger";
import { DrizzleExpiredTapPurger } from "../infrastructure/persistence/drizzle-expired-tap.purger";
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
  readonly cardTaps?: CardTapRecorder;
  readonly tapPurger?: ExpiredTapPurger;
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
  // タップ回数の記録・集計（#394）。公開経路（`redirect.routes.ts`）と
  // 運営向け一覧（`listAllCards`）の両方から使う。
  const cardTaps = overrides.cardTaps ?? new DrizzleCardTapRecorder(db);
  const tapPurger = overrides.tapPurger ?? new DrizzleExpiredTapPurger(db);
  const clock = systemClock;

  return {
    repositories: { cards, cardTaps },
    services: { identity, clock },
    useCases: {
      resolveCard: new ResolveCardUseCase(cards),
      listMyCards: new ListMyCardsUseCase(identity, cards),
      // 運営向けの全カード一覧（#338 Step 3）。**管理者判定は UseCase の中。**
      listAllCards: new ListAllCardsUseCase(identity, cards, cardTaps),
      updateCardTarget: new UpdateCardTargetUseCase(
        identity,
        cards,
        events,
        clock,
        blockedTargetOrigins(env),
      ),
      disableCard: new DisableCardUseCase(identity, cards, events, clock),
      // 運営が他人のカードを無効化する（#382）。**管理者判定は UseCase の中。**
      adminDisableCard: new AdminDisableCardUseCase(identity, cards, events, clock),
      // admin-worker からの delegated RPC 専用（#382 / #390 決定 16 ③）。
      // **`identity` を渡さない** —— 認可は admin-worker 側で済んでいる。
      delegatedDisableCard: new DelegatedDisableCardUseCase(cards, events, clock),
      delegatedBatchDisableCards: new DelegatedBatchDisableCardsUseCase(cards, events, clock),
      delegatedCountBatchIssuedCards: new DelegatedCountBatchIssuedCardsUseCase(cards),
      delegatedReleaseCard: new DelegatedReleaseCardUseCase(cards, events, clock),
      delegatedReinstateCard: new DelegatedReinstateCardUseCase(cards, events, clock),
      // reinstateCard（→ active）の単発版（#436、→ issued）。
      delegatedReinstateCardToIssued: new DelegatedReinstateCardToIssuedUseCase(
        cards,
        events,
        clock,
      ),
      // バッチ一括無効化の逆（#436）。
      delegatedReinstateBatchToIssuedCards: new DelegatedReinstateBatchToIssuedCardsUseCase(
        cards,
        events,
        clock,
      ),
      delegatedCountDisabledInBatch: new DelegatedCountDisabledInBatchUseCase(cards),
      delegatedListAllCards: new DelegatedListAllCardsUseCase(cards, cardTaps),
      delegatedCountCards: new DelegatedCountCardsUseCase(cards),
      delegatedIssueCards: new DelegatedIssueCardsUseCase(cards, events, clock),
      delegatedUpdateCardTarget: new DelegatedUpdateCardTargetUseCase(
        cards,
        events,
        clock,
        blockedTargetOrigins(env),
      ),
      claimCard: new ClaimCardUseCase(identity, cards, events, clock),
      issueCards: new IssueCardsUseCase(identity, cards, events, clock),
      releaseCard: new ReleaseCardUseCase(identity, cards, events, clock),
      viewClaim: new ViewClaimUseCase(identity, cards),
      purgeExpiredEvents: new PurgeExpiredEventsUseCase({ purger: eventPurger, clock }),
      purgeExpiredTaps: new PurgeExpiredTapsUseCase({ purger: tapPurger, clock }),
    },
  };
}

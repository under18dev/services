/**
 * 本筋でない副作用をいつ走らせるかを決める Port（#126 / 脅威モデル RR-15）。
 *
 * ## なぜ Port にするのか
 *
 * 応答時間からトークンの実在が漏れるのを塞ぐには、監査ログの INSERT と
 * `sessions.touch()` の UPDATE を**応答を返した後**へ逃がす必要がある。
 * Workers でそれをやる手段は `ExecutionContext.waitUntil()` だが、
 * **Application 層が `ExecutionContext` を知ってはいけない**
 * （仕様書 2.3。知った瞬間に UseCase が Workers 専用になる）。
 *
 * そこで「いつ走らせるか」だけを Port にして、`waitUntil` を持っている
 * Presentation / Composition 側から注入する。
 *
 * ## 2 つの実装は挙動が違ってよい
 *
 * - `WaitUntilSideEffectScheduler` —— 応答後へ逃がす。HTTP の入口はこれ。
 * - `InlineSideEffectScheduler` —— その場で待つ。`ExecutionContext` が
 *   無い経路（Cron の `scheduled`、一部のテスト）はこれ。
 *
 * **`waitUntil` が無いときに「投げっぱなし」にしないこと。** Workers は
 * 応答を返した時点で isolate を止めうるので、待たずに放流した書き込みは
 * 黙って消える。「消えてもよいログ」ではなく「消えたことに気づけない
 * ログ」になる —— #122 で塞いだのと同じ形の穴である。
 *
 * ## 失敗は呼び出し元へ伝播しない
 *
 * どちらの実装も `settleSideEffects` と同じ契約で、副作用の失敗で本筋を
 * 落とさない。監査ログが書けないことを理由にログインを拒否すると、
 * 可観測性の問題がそのまま認証停止になる。
 */
export interface SideEffectScheduler {
  schedule(label: string, ...tasks: readonly Promise<unknown>[]): Promise<void>;
}

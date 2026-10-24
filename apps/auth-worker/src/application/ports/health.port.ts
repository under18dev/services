/**
 * 死活確認の Port。
 *
 * Presentation から DB を直接叩くと Layered Architecture の依存方向が壊れる
 * （仕様書 2.3）。ヘルスチェックも例外にせず、Port 越しに問い合わせる。
 */
export interface DatabaseProbe {
  /** DB へ到達できれば true。例外は投げず、到達性だけを返す。 */
  ping(): Promise<boolean>;
}

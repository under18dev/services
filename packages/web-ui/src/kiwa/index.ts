/**
 * Kiwa UI から取り込んだ primitives（#332）。
 *
 * **`@u18/web-ui` の本体（`../index.ts`）からは再 export しない。**
 * あちらは手書き CSS（`styles.ts`）の世界で、ログイン画面・同意画面・
 * 残り 5 枚のダッシュボードがまだそちらに乗っている。1 つの入口に
 * まとめると、**どちらの流儀で書かれた画面なのかが import から読めなく
 * なる。** 移行が終わるまでは別の入口にしておく（`@u18/web-ui/kiwa`）。
 *
 * 取り込んであるのは `/account/apps` を組むのに要ったものだけ。
 * 足りなければ上流の `registry/ui/` から持ってくる（`./README.md`）。
 */
export * from "./alert";
export * from "./badge";
export * from "./button";
export * from "./card";
export * from "./empty";
export * from "./separator";
export * from "./shell";
export * from "./sidebar-item";
export * from "./utils";

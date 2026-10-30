/**
 * Kiwa UI から取り込んだ primitives（#332）。
 *
 * **`@u18/web-ui` の本体（`../index.ts`）からは再 export しない。**
 *
 * **もともとの理由は失効している。** 入口を 2 つに分けていたのは、
 * 手書き CSS（`styles.ts`）の画面と Kiwa の画面が混在していた間、
 * **どちらの流儀で書かれた画面なのかを import から読めるようにする**
 * ためだった。移行は終わり、手書き CSS は消えた。
 *
 * **それでも分けたままにしてある。** ここは**上流から取り直すファイル**
 * （`./README.md` の手順）で、本体は u18 が書いたものである。混ぜると
 * 「上流に戻せるのはどれか」が読めなくなる。**統合するなら、その理由で
 * 判断すること** —— 移行が終わったから、ではない。
 *
 * 足りなければ上流の `registry/ui/` から持ってくる（`./README.md`）。
 */
export * from "./alert";
export * from "./badge";
export * from "./button";
export * from "./card";
export * from "./card-shell";
export * from "./empty";
export * from "./separator";
export * from "./shell";
export * from "./sidebar-item";
export * from "./table";
export * from "./utils";

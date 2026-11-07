/*
 * 自動生成——手で編集しない（GDG デザイン移行 PR1）。
 * `node packages/web-ui/scripts/generate-gdg-dark-media.mjs` で作り直す。
 *
 * vendored `../gdg/tokens.css` の `.dark { ... }` が宣言する変数名の
 * 集合。各 Worker の `kiwa-stylesheet.test.ts` が、配信 CSS の
 * `@media (prefers-color-scheme: dark)` と突き合わせるために読む
 * （workerd の中では `tokens.css` を直接 `readFileSync` できないため）。
 */
export const GDG_DARK_CLASS_VAR_NAMES = [
  "--gdg-background",
  "--gdg-surface",
  "--gdg-text",
  "--gdg-muted",
  "--gdg-border",
  "--gdg-input-border",
  "--gdg-shadow-sm",
  "--gdg-shadow-md",
  "--gdg-shadow-lg",
  "--gdg-shadow-hover",
  "--gdg-shadow-pressed",
  "--gdg-shadow-inset",
  "--gdg-shadow-right",
  "--gdg-shadow-left",
  "--gdg-shadow-bottom",
  "--gdg-edge-highlight",
  "--gdg-link",
  "--gdg-focus",
  "--gdg-selected",
  "--gdg-secondary",
  "--gdg-on-secondary",
  "--gdg-secondary-hover",
  "--gdg-neutral",
  "--gdg-hover",
  "--gdg-danger",
  "--gdg-on-danger",
  "--gdg-danger-surface",
  "--gdg-success",
  "--gdg-success-surface",
  "--gdg-warning",
  "--gdg-warning-surface"
];

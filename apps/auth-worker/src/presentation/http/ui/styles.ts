/**
 * u18 の画面で共有するスタイルシート。
 *
 * `<style>` のインライン埋め込みにせず外部ファイルとして配信する。
 * 画面には `style-src 'self'` の CSP を掛けており、インラインにすると
 * `'unsafe-inline'` を足すことになる。CSP を緩めるくらいなら外部ファイルに
 * する、という判断（`@u18/web-ui` の `page-headers.ts` を参照）。
 *
 * ## 配信元は auth-worker だが、dashboard-worker も同じものを読む
 *
 * 両者は同じオリジン `auth.under18.dev` に載る（仕様書 §14.1 決定 1）ので、
 * dashboard のページからも `/ui/u18.css` をそのまま参照できる。**定義は
 * 1 つに保つ。** 2 つに分けると、同じサイトに見えるのに画面ごとに見た目が
 * 違う状態が生まれる。
 *
 * ## デザイン
 *
 * `under18dev/under18dev` の `design.md`（Vercel / Linear / Stripe Press /
 * Raycast に着想を得た design system）に合わせてある。トークンの実値は
 * 参照元の `src/index.css` から取った。
 *
 * 参照元が明示している禁止事項を守ること:
 *
 *  - **グラデーションを使わない**（"No gradients."）
 *  - アクセント（`--accent`）は控えめに。"No rainbow effects. No neon
 *    cyberpunk effects. No colorful UI."
 *  - アニメーションは fade in / 軽い hover / smooth transition まで。
 *    "Avoid: heavy parallax, flashy motion, spinning elements"
 *  - 余白を大きく、要素を詰め込まない
 *
 * **ダーク固定にしてある。** 参照元にライトパレットが無いためで、
 * 独自に作ると「同じサイトなのに認証画面だけ別物」になる。
 * `color-scheme: dark` を明示しているので、ブラウザ既定の UI
 * （スクロールバー・フォームコントロール）もダーク側に揃う。
 *
 * ## フォントは第三者ホストから読まない（仕様書 §14.1 決定 15）
 *
 * 参照元は Inter / JetBrains Mono を Google Fonts から読んでいるが、
 * **認証画面では採らない。** CSP に `style-src https://fonts.googleapis.com`
 * と `font-src https://fonts.gstatic.com` を足すことになり、決定 13
 * （Turnstile を入れない）と同じ理由で、**ログイン画面を開いた事実が
 * 第三者へ渡る**。同意画面で `img-src` に外部ホストを許していないのと同じ。
 *
 * 参照元のフォント指定自体がシステムフォントへフォールバックする形
 * （`"Inter", ui-sans-serif, system-ui, sans-serif`）なので、ここはその
 * フォールバック側を既定にしている。Inter が要るなら self-host する
 * （`font-src 'self'` のまま配信できる）。
 */
export const UI_STYLESHEET = `
:root {
  color-scheme: dark;

  /* under18dev/under18dev の src/index.css から */
  --bg: #0a0a0a;
  --bg-secondary: #111111;
  --card: #151515;
  --border: #222222;
  --fg: #fafafa;
  --muted: #a1a1aa;
  --muted-deep: #71717a;
  --accent: #3b82f6;
  --ease: cubic-bezier(0.16, 1, 0.3, 1);

  --accent-fg: #ffffff;
  /* 失敗の表示。彩度を上げると "colorful UI" になるので赤は 1 段落とす。 */
  --danger: #f87171;

  --font-sans: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto,
    "Hiragino Sans", "Noto Sans JP", sans-serif;
  --font-mono: ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace;
}

* { box-sizing: border-box; }

body {
  margin: 0;
  min-height: 100dvh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 2rem 1.5rem;
  background: var(--bg);
  color: var(--fg);
  font-family: var(--font-sans);
  line-height: 1.65;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}

::selection {
  background: color-mix(in srgb, var(--accent) 35%, transparent);
  color: var(--fg);
}

.card {
  width: 100%;
  max-width: 26rem;
  padding: 2.5rem;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 0.75rem;
}

.brand {
  margin: 0 0 2rem;
  font-size: 0.8rem;
  font-weight: 500;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--muted-deep);
}

h2 {
  margin: 0 0 0.5rem;
  font-size: 1.5rem;
  font-weight: 600;
  letter-spacing: -0.02em;
}

.lead { margin: 0 0 1.75rem; color: var(--muted); }

.field { display: block; margin-bottom: 1.25rem; }
.field > span {
  display: block;
  margin-bottom: 0.4rem;
  font-weight: 500;
  font-size: 0.875rem;
  color: var(--muted);
}

input[type="email"],
input[type="text"] {
  width: 100%;
  padding: 0.7rem 0.85rem;
  font: inherit;
  color: inherit;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  transition: border-color 0.15s var(--ease);
}

input[type="email"]:hover,
input[type="text"]:hover { border-color: #2e2e2e; }

input:focus-visible,
.button:focus-visible,
.link-button:focus-visible,
a:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.code-input {
  letter-spacing: 0.4em;
  font-size: 1.25rem;
  text-align: center;
  font-family: var(--font-mono);
}

.button {
  display: block;
  width: 100%;
  padding: 0.75rem 1rem;
  font: inherit;
  font-weight: 500;
  color: var(--accent-fg);
  background: var(--accent);
  border: 1px solid transparent;
  border-radius: 0.5rem;
  cursor: pointer;
  transition:
    background-color 0.15s var(--ease),
    border-color 0.15s var(--ease);
}

.button:hover { background: #2f6fe0; }
.button[disabled] { opacity: 0.55; cursor: progress; }

.button-secondary {
  color: var(--fg);
  background: transparent;
  border-color: var(--border);
}

.button-secondary:hover {
  background: var(--bg-secondary);
  border-color: #2e2e2e;
}

.separator {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  margin: 1.75rem 0;
  color: var(--muted-deep);
  font-size: 0.8rem;
}

.separator::before,
.separator::after {
  content: "";
  flex: 1;
  height: 1px;
  background: var(--border);
}

.error {
  margin: 0 0 1.25rem;
  padding: 0.7rem 0.85rem;
  border: 1px solid color-mix(in srgb, var(--danger) 40%, var(--border));
  border-radius: 0.5rem;
  color: var(--danger);
  font-size: 0.875rem;
  background: var(--bg-secondary);
}

.notice { margin: 0.85rem 0 0; color: var(--muted); font-size: 0.875rem; }

.links { margin: 1.5rem 0 0; font-size: 0.875rem; }
.links a { color: var(--muted); }
.links a:hover { color: var(--fg); }

.inline-form { display: inline; }

.link-button {
  padding: 0;
  font: inherit;
  color: var(--muted);
  background: none;
  border: 0;
  cursor: pointer;
  text-decoration: underline;
  transition: color 0.15s var(--ease);
}

.link-button:hover { color: var(--fg); }

.identity {
  margin: 0 0 1.5rem;
  padding: 0.85rem;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: 0.5rem;
}

.identity strong { display: block; font-weight: 500; }
.identity span { color: var(--muted); font-size: 0.875rem; }

/* 同意画面（#15）で要求 scope を並べる。 */
.scopes { margin: 0 0 1.75rem; padding-left: 1.25rem; color: var(--muted); }
.scopes li { margin-bottom: 0.5rem; }
`;

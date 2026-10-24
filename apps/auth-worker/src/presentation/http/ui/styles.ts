/**
 * Auth UI のスタイルシート。
 *
 * `<style>` のインライン埋め込みにせず外部ファイルとして配信する。
 * ログイン画面には `style-src 'self'` の CSP を掛けており、インラインに
 * すると `'unsafe-inline'` を足すことになる。CSP を緩めるくらいなら
 * 外部ファイルにする、という判断（ui/login.routes.ts の CSP 定義を参照）。
 *
 * レイアウトと同じく同意画面（#15）でも使い回す前提で、`.login-*` のような
 * 画面固有の名前を避けている。
 */
export const UI_STYLESHEET = `
:root {
  color-scheme: light dark;
  --bg: #f6f7f9;
  --fg: #16181d;
  --muted: #5c6370;
  --card: #ffffff;
  --border: #d9dde3;
  --accent: #1f5eff;
  --accent-fg: #ffffff;
  --danger: #b3261e;
}

@media (prefers-color-scheme: dark) {
  :root {
    --bg: #14161a;
    --fg: #e8eaed;
    --muted: #9aa0ab;
    --card: #1d2026;
    --border: #2f343c;
    --accent: #6f9bff;
    --accent-fg: #10131a;
    --danger: #f2b8b5;
  }
}

* { box-sizing: border-box; }

body {
  margin: 0;
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1.5rem;
  background: var(--bg);
  color: var(--fg);
  font-family: system-ui, -apple-system, "Hiragino Sans", "Noto Sans JP", sans-serif;
  line-height: 1.6;
}

.card {
  width: 100%;
  max-width: 26rem;
  padding: 2rem;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 0.75rem;
}

.brand {
  margin: 0 0 1.5rem;
  font-size: 1rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--muted);
}

h2 { margin: 0 0 0.5rem; font-size: 1.35rem; }

.lead { margin: 0 0 1.25rem; color: var(--muted); }

.field { display: block; margin-bottom: 1rem; }
.field > span { display: block; margin-bottom: 0.35rem; font-weight: 600; font-size: 0.9rem; }

input[type="email"],
input[type="text"] {
  width: 100%;
  padding: 0.65rem 0.75rem;
  font: inherit;
  color: inherit;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 0.5rem;
}

input:focus-visible,
.button:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.code-input { letter-spacing: 0.4em; font-size: 1.25rem; text-align: center; }

.button {
  display: block;
  width: 100%;
  padding: 0.7rem 1rem;
  font: inherit;
  font-weight: 600;
  color: var(--accent-fg);
  background: var(--accent);
  border: 1px solid transparent;
  border-radius: 0.5rem;
  cursor: pointer;
}

.button[disabled] { opacity: 0.6; cursor: progress; }

.button-secondary {
  color: var(--fg);
  background: transparent;
  border-color: var(--border);
}

.separator {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  margin: 1.5rem 0;
  color: var(--muted);
  font-size: 0.85rem;
}

.separator::before,
.separator::after {
  content: "";
  flex: 1;
  height: 1px;
  background: var(--border);
}

.error {
  margin: 0 0 1rem;
  padding: 0.65rem 0.75rem;
  border: 1px solid var(--danger);
  border-radius: 0.5rem;
  color: var(--danger);
  font-size: 0.9rem;
}

.notice { margin: 0.75rem 0 0; color: var(--muted); font-size: 0.9rem; }

.links { margin: 1.25rem 0 0; font-size: 0.9rem; }
.links a { color: var(--accent); }

.inline-form { display: inline; }

.link-button {
  padding: 0;
  font: inherit;
  color: var(--accent);
  background: none;
  border: 0;
  cursor: pointer;
  text-decoration: underline;
}

.identity { margin: 0 0 1.25rem; padding: 0.75rem; background: var(--bg); border-radius: 0.5rem; }
.identity strong { display: block; }
.identity span { color: var(--muted); font-size: 0.9rem; }

/* 同意画面（#15）で要求 scope を並べる。 */
.scopes { margin: 0 0 1.5rem; padding-left: 1.25rem; }
.scopes li { margin-bottom: 0.4rem; }
`;

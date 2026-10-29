/**
 * u18 の画面で共有するスタイルシート。
 *
 * `<style>` のインライン埋め込みにせず外部ファイルとして配信する。
 * 画面には `style-src 'self'` の CSP を掛けており、インラインにすると
 * `'unsafe-inline'` を足すことになる。CSP を緩めるくらいなら外部ファイルに
 * する、という判断（`@u18/web-ui` の `page-headers.ts` を参照）。
 *
 * ## 定義はここ 1 つ。配信は Worker ごとに行う
 *
 * auth-worker は `/ui/u18.css`、dashboard-worker は `/account/ui/u18.css` で
 * **この同じ定数を**配信する。両者は同じオリジン `auth.under18.dev` に載る
 * （仕様書 §14.1 決定 1）ので、dashboard から `/ui/u18.css` を直接参照する
 * ことも**できる**が、採っていない。
 *
 * 理由は 2 つ:
 *
 *  - **dashboard-worker が単体で成立する。** `wrangler dev` でも vitest でも、
 *    auth-worker を立てずにページが正しく表示される。参照先が他 Worker だと、
 *    ローカルでは常にスタイルの無い画面を見ることになる。
 *  - **auth-worker のアセット経路の変更が dashboard を黙って壊さない。**
 *    参照だけを持つと、パスが変わっても dashboard 側は型でも検査でも
 *    気づけず、本番で初めて素の HTML が出る。
 *
 * 代償は、ログイン画面とアカウント画面で**同じ内容を 2 つの URL から
 * 取る**こと（キャッシュが別になる）。数 KiB なので受け入れる。
 *
 * **定義を 2 つに分けないこと。** 分けると、同じサイトに見えるのに画面ごとに
 * 見た目が違う状態が生まれる。
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

  /*
   * ダッシュボード（#308 / #309）で足した段階。
   *
   * **既存の --bg / --card / --border は動かしていない。** ログイン画面と
   * 同意画面が同じスタイルシートを読んでいるので、基調を変えると
   * 「別のサイトに来た」ように見える。足りなかったのは**段階**のほうで、
   * 境界が 1 種類しか無いと、面が重なったときに奥行きが出ない。
   */
  --border-strong: #2e2e2e;
  --surface: #0f0f0f;
  --radius: 0.625rem;
  --radius-sm: 0.375rem;

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
/* 同じ form に並べるとき（ログイン済み画面の 2 種類のログアウト）。 */
.button + .button { margin-top: 0.6rem; }
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

/* 連携アプリ画面では一覧の行の中に入るので、余白を詰める。 */
.list .scopes {
  margin: 0.4rem 0 0;
  font-size: 0.8125rem;
  color: var(--muted-deep);
}

.list .scopes li { margin-bottom: 0.15rem; }
/* ------------------------------------------------------------------ *
 * アカウント管理画面（dashboard-worker）
 *
 * ログイン画面は 1 枚の .card に収まるが、アカウント画面は節が複数あり
 * 一覧が縦に伸びる。body の中央寄せのままだと、内容が増えたときに
 * 上がビューポートの外へ出るので、こちらは上端に寄せる。
 * ------------------------------------------------------------------ */

body.page-shell {
  align-items: flex-start;
  padding-top: 3rem;
  padding-bottom: 4rem;
}

.shell { width: 100%; max-width: 48rem; }

/* 画面間の移動。.links と違い常時出るので、現在地が分かる必要がある。 */
.nav {
  display: flex;
  gap: 1.5rem;
  margin: 0 0 2.5rem;
  font-size: 0.875rem;
}

.nav a {
  color: var(--muted);
  text-decoration: none;
  padding-bottom: 0.35rem;
  border-bottom: 1px solid transparent;
  transition:
    color 0.15s var(--ease),
    border-color 0.15s var(--ease);
}

.nav a:hover { color: var(--fg); }

/* 現在地。色だけで示すと、色覚特性によっては差が出ない。下線を併用する。 */
.nav a[aria-current="page"] {
  color: var(--fg);
  border-bottom-color: var(--accent);
}

.section {
  margin: 0 0 2.5rem;
  padding: 1.75rem;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 0.75rem;
}

.section > h2 { font-size: 1.125rem; }
.section > h2:not(:first-child) { margin-top: 2rem; }

.section-lead { margin: 0 0 1.5rem; color: var(--muted); font-size: 0.875rem; }

/* 一覧。<ul> で組む —— 項目数が 0 件になりうるので表より素直になる。 */
.list { margin: 0; padding: 0; list-style: none; }

.list > li {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1.25rem;
  padding: 1rem 0;
  border-top: 1px solid var(--border);
}

.list > li:first-child { border-top: 0; padding-top: 0; }
.list > li:last-child { padding-bottom: 0; }

.item-main { min-width: 0; }

/* セッションの User-Agent や client_id。長いので折り返させる。 */
.item-title {
  font-weight: 500;
  overflow-wrap: anywhere;
}

.item-meta {
  margin: 0.25rem 0 0;
  color: var(--muted-deep);
  font-size: 0.8125rem;
  overflow-wrap: anywhere;
}

.item-actions { flex: none; }

/* 「このブラウザ」など。アクセントは文字色だけに使い、塗らない。 */
.badge {
  display: inline-block;
  margin-left: 0.5rem;
  padding: 0.05rem 0.45rem;
  font-size: 0.75rem;
  font-weight: 500;
  color: var(--accent);
  border: 1px solid color-mix(in srgb, var(--accent) 35%, var(--border));
  border-radius: 999px;
  vertical-align: 0.1em;
}

/* 取り消しに失敗したときに行内へ出す。消えた行と混ざらないよう行内に置く。 */
.item-error {
  margin: 0.4rem 0 0;
  color: var(--danger);
  font-size: 0.8125rem;
}

/* 要約の下に出す User-Agent の原文。見出しより一段落として読み飛ばせるように。 */
.item-raw {
  margin: 0.2rem 0 0;
  color: var(--muted);
  font-family: var(--font-mono);
  font-size: 0.75rem;
  line-height: 1.5;
  overflow-wrap: anywhere;
}

/* 注意を促すバッジ。アクセント（青）は「問題なし」に読めるので使わない。 */
.badge-warn {
  color: var(--danger);
  border-color: color-mix(in srgb, var(--danger) 35%, var(--border));
}

.empty {
  margin: 0;
  padding: 1.5rem 0;
  color: var(--muted-deep);
  font-size: 0.875rem;
  text-align: center;
}

/* 定義リスト。プロフィールの「表示名 / ユーザー名 / メール」。 */
.facts { margin: 0; }

.facts > div {
  display: flex;
  gap: 1.25rem;
  padding: 0.75rem 0;
  border-top: 1px solid var(--border);
}

.facts > div:first-child { border-top: 0; padding-top: 0; }

.facts dt {
  flex: none;
  width: 7.5rem;
  color: var(--muted);
  font-size: 0.875rem;
}

.facts dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }

/* 一覧の行に置く小さいボタン。.button は幅 100% なのでここでは使えない。 */
.button-small {
  display: inline-block;
  width: auto;
  padding: 0.4rem 0.75rem;
  font-size: 0.875rem;
}

.button-danger {
  color: var(--danger);
  background: transparent;
  border-color: color-mix(in srgb, var(--danger) 35%, var(--border));
}

.button-danger:hover {
  background: color-mix(in srgb, var(--danger) 10%, transparent);
  border-color: color-mix(in srgb, var(--danger) 55%, var(--border));
}


/* ------------------------------------------------------------------ *
 * ダッシュボード（#308 / #309）
 *
 * 1 枚のカードに収まる画面（ログイン・同意）と、節が縦に伸びる画面
 * （アカウント設定）に続く 3 つ目の骨格。**左にサイドバー、右に本文。**
 *
 * ## なぜ横並びのナビでは足りなくなったか
 *
 * .nav は 3 項目を横に並べるだけで足りていた。入れる先が「アカウント」
 * だけだったからである。ここへ**カテゴリ**（開発・サービス）が入ると、
 * 横一列では「どれが同じ仲間か」を示す場所が無い。縦に積んで見出しを
 * 付けられる形にする。
 *
 * ## JS を使わずに畳む
 *
 * 狭い画面ではサイドバーを**上端の横スクロール**に変える。開閉ボタンに
 * すると JS が要り、**JS が落ちた端末でナビごと消える。** 一覧が読める
 * ことだけは JS 無しで成立させる、という既存の方針（決定 4 / 16）に揃える。
 * ------------------------------------------------------------------ */

body.page-dash {
  display: block;
  padding: 0;
  background: var(--bg);
}

.dash {
  display: grid;
  grid-template-columns: 15rem minmax(0, 1fr);
  min-height: 100dvh;
}

.dash-side {
  border-right: 1px solid var(--border);
  background: var(--surface);
  padding: 1.5rem 1rem;
}

.dash-main {
  min-width: 0;
  padding: 2.5rem 2.5rem 5rem;
}

/* 本文の読み幅。広い画面で 1 行が長くなりすぎると目が戻れない。 */
.dash-inner { width: 100%; max-width: 46rem; }

.side-brand {
  display: block;
  margin: 0 0 1.75rem;
  padding: 0 0.6rem;
  font-size: 0.8rem;
  font-weight: 500;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--muted-deep);
  text-decoration: none;
}

.side-brand:hover { color: var(--muted); }

.side-group { margin: 0 0 1.5rem; }

.side-group-label {
  margin: 0 0 0.4rem;
  padding: 0 0.6rem;
  font-size: 0.7rem;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--muted-deep);
}

.side-links { margin: 0; padding: 0; list-style: none; }

.side-link {
  display: block;
  padding: 0.45rem 0.6rem;
  border-radius: var(--radius-sm);
  color: var(--muted);
  font-size: 0.875rem;
  text-decoration: none;
  transition:
    background-color 0.15s var(--ease),
    color 0.15s var(--ease);
}

.side-link:hover { background: var(--bg-secondary); color: var(--fg); }

/*
 * 現在地。**背景だけで示さない** —— 色覚特性によっては差が出ないので、
 * 左の縦線と文字色を併用する（.nav で下線を併用しているのと同じ理由）。
 */
.side-link[aria-current="page"] {
  background: var(--bg-secondary);
  color: var(--fg);
  box-shadow: inset 2px 0 0 var(--accent);
}

.page-head { margin: 0 0 2rem; }
.page-head h1 { margin: 0; font-size: 1.5rem; font-weight: 600; letter-spacing: -0.02em; }
.page-head p { margin: 0.35rem 0 0; color: var(--muted); font-size: 0.875rem; }

/*
 * カード。.section と形は似ているが、**見出しと本文の間に境界を引く**
 * ぶん、節が複数ある画面で区切りが読みやすい。.section は既存の画面が
 * 使っているので残してある。
 */
.cards { display: grid; gap: 1.25rem; }
.cards-3 { grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr)); }

.panel {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  overflow: hidden;
}

.panel-header { padding: 1.25rem 1.5rem; border-bottom: 1px solid var(--border); }
.panel-title { margin: 0; font-size: 1rem; font-weight: 600; }
.panel-desc { margin: 0.3rem 0 0; color: var(--muted); font-size: 0.8125rem; }
.panel-body { padding: 1.25rem 1.5rem; }
.panel-footer {
  padding: 0.9rem 1.5rem;
  border-top: 1px solid var(--border);
  background: var(--bg-secondary);
  font-size: 0.8125rem;
  color: var(--muted);
}

/* ホームの数値タイル。数を先に、意味を後に読ませる。 */
.stat { display: block; padding: 1.25rem 1.5rem; text-decoration: none; color: inherit; }
.stat:hover { background: var(--bg-secondary); }
.stat-value { display: block; font-size: 1.75rem; font-weight: 600; letter-spacing: -0.02em; }
.stat-label { display: block; margin-top: 0.15rem; color: var(--muted); font-size: 0.8125rem; }

.badge-muted {
  color: var(--muted);
  border-color: var(--border);
}

@media (max-width: 52rem) {
  .dash { grid-template-columns: minmax(0, 1fr); }

  .dash-side {
    border-right: 0;
    border-bottom: 1px solid var(--border);
    padding: 1rem;
    overflow-x: auto;
  }

  .side-brand { margin-bottom: 0.75rem; }

  /* カテゴリ名は畳む。横並びになると見出しと項目の区別が付かない。 */
  .side-group { display: inline-block; margin: 0 1rem 0 0; vertical-align: top; }
  .side-group-label { display: none; }
  .side-links { display: flex; gap: 0.25rem; }
  .side-link { white-space: nowrap; }
  .side-link[aria-current="page"] { box-shadow: inset 0 -2px 0 var(--accent); }

  .dash-main { padding: 1.75rem 1.25rem 4rem; }
}
`;

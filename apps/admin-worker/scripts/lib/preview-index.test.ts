import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";
import { buildPreviewIndexHtml, type PreviewPage } from "./preview-index.mjs";

/**
 * `index.html`（プレビューのシェル）のライト/ダーク切り替えが
 * 実際に効くことの検査（services-3b の依頼）。
 *
 * **「ボタンが存在すること」だけでは足りない。** 押しても何も起きない
 * 配線のまま、`toContain("data-theme-mode")` のような検査は緑で通る——
 * ここでは `buildPreviewIndexHtml()` が返す本物の HTML を happy-dom に
 * 読み込み、実際にボタンをクリックして、iframe の `<html>` の class が
 * 本当に変わることまで見る。
 *
 * happy-dom は既定で JS を評価しない（`enableJavaScriptEvaluation:
 * false`）。生成した HTML は自分たちの出力であり外部の信頼できない
 * コードではないので、ここでだけ明示的に有効化する。
 */

function buildWindow(pages: readonly PreviewPage[]) {
  const window = new Window({
    settings: {
      enableJavaScriptEvaluation: true,
      enableIframePageLoading: true,
      suppressInsecureJavaScriptEnvironmentWarning: true,
    },
  });
  const document = window.document as unknown as Document;
  document.write(buildPreviewIndexHtml(pages));
  return { window, document };
}

async function waitForIframeLoad(window: InstanceType<typeof Window>): Promise<void> {
  await window.happyDOM.waitUntilComplete();
}

const FIXTURE_PAGES: readonly PreviewPage[] = [
  { name: "alpha", title: "アルファ", html: "<!doctype html><html><body>alpha</body></html>" },
  { name: "beta", title: "ベータ", html: "<!doctype html><html><body>beta</body></html>" },
];

describe("buildPreviewIndexHtml のライト/ダーク切り替え", () => {
  it("初期状態は system（light/dark どちらの class も付かない）", async () => {
    const { window, document } = buildWindow(FIXTURE_PAGES);
    await waitForIframeLoad(window);

    const iframe = document.getElementById("preview-frame") as HTMLIFrameElement;
    const root = iframe.contentDocument!.documentElement;
    expect(root.classList.contains("light")).toBe(false);
    expect(root.classList.contains("dark")).toBe(false);
  });

  it('「ダーク固定」ボタンを押すと、iframe の <html> に実際に class="dark" が付く', async () => {
    const { window, document } = buildWindow(FIXTURE_PAGES);
    await waitForIframeLoad(window);

    const darkButton = document.querySelector<HTMLButtonElement>('[data-theme-mode="dark"]')!;
    darkButton.click();

    const iframe = document.getElementById("preview-frame") as HTMLIFrameElement;
    const root = iframe.contentDocument!.documentElement;
    expect(root.classList.contains("dark")).toBe(true);
    expect(root.classList.contains("light")).toBe(false);
    // 押した側のボタン自身にも、押されたことが読み取れる状態が要る
    // （見た目の強調だけだと、スクリーンリーダー等では「押した」と
    // 分からない）。
    expect(darkButton.getAttribute("aria-pressed")).toBe("true");
  });

  it("「ライト固定」のあとに「OS 追従」を押すと、付けた class が両方とも外れる", async () => {
    const { window, document } = buildWindow(FIXTURE_PAGES);
    await waitForIframeLoad(window);

    const iframe = document.getElementById("preview-frame") as HTMLIFrameElement;
    const root = () => iframe.contentDocument!.documentElement;

    document.querySelector<HTMLButtonElement>('[data-theme-mode="light"]')!.click();
    expect(root().classList.contains("light")).toBe(true);

    document.querySelector<HTMLButtonElement>('[data-theme-mode="system"]')!.click();
    expect(root().classList.contains("light")).toBe(false);
    expect(root().classList.contains("dark")).toBe(false);
  });

  it("ダーク固定のまま別の画面へ切り替えると、新しい画面にも dark が当て直される", async () => {
    // **ここが一番壊れやすいところ。** iframe の中身は srcdoc の差し替えで
    // 丸ごと新しい document になる——load のたびに「いま選ばれている
    // モード」を当て直す配線を忘れると、「1 枚目はダークなのに次の画面は
    // 白いまま」という事故になる（34 枚を手で見比べる動機そのもの）。
    const { window, document } = buildWindow(FIXTURE_PAGES);
    await waitForIframeLoad(window);

    document.querySelector<HTMLButtonElement>('[data-theme-mode="dark"]')!.click();

    const betaLink = document.querySelector<HTMLAnchorElement>('a[data-page="beta"]')!;
    betaLink.click();
    await waitForIframeLoad(window);

    const iframe = document.getElementById("preview-frame") as HTMLIFrameElement;
    expect(iframe.contentDocument!.body.textContent).toContain("beta");
    expect(iframe.contentDocument!.documentElement.classList.contains("dark")).toBe(true);
  });

  it("ページの本文に <script> タグが含まれていても、埋め込みが壊れない", async () => {
    // 実物の17画面は admin-island.js を読む <script type="module"> を
    // 本文に持つ。`</script` の文字列をエスケープし忘れると、埋め込んだ
    // ページのところで外側の <script> が早期に閉じ、後続のボタンの配線が
    // 丸ごと本文として描画されてしまう（詳細は preview-index.mjs の
    // `embedAsScriptString` の JSDoc）。
    const pagesWithScript: readonly PreviewPage[] = [
      {
        name: "with-script",
        title: "スクリプト入り",
        html: '<!doctype html><html><body><script type="module" src="./admin-island.js"></script><p>hello</p></body></html>',
      },
    ];
    const { window, document } = buildWindow(pagesWithScript);
    await waitForIframeLoad(window);

    // 壊れていたら、本来ボタンの配線が効くはずの外側の <script> が
    // 途中で終わっているので、ボタンを押しても何も起きない。
    const darkButton = document.querySelector<HTMLButtonElement>('[data-theme-mode="dark"]')!;
    darkButton.click();

    const iframe = document.getElementById("preview-frame") as HTMLIFrameElement;
    expect(iframe.contentDocument!.documentElement.classList.contains("dark")).toBe(true);
    expect(iframe.contentDocument!.body.textContent).toContain("hello");
  });
});

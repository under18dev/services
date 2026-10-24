import { describe, expect, it } from "vitest";
import { isServableTargetUrl, validateTargetUrl } from "../src/domain/services/target-url";

/**
 * リダイレクト先の検証（仕様書 10「リダイレクトは`https:`に限定し、
 * 不正・危険なURLやフィッシングへの対策を行う」）。
 *
 * ここは Domain の純粋関数なので、D1 も Identity も要らない。
 */

const BLOCKED = ["https://auth.under18.dev", "https://go.under18.dev"];

describe("https: 以外を受け付けない", () => {
  it.each([
    "http://example.com/",
    "ftp://example.com/",
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "intent://example.com/#Intent;end",
    "file:///etc/passwd",
  ])("%s を拒否する", (raw) => {
    const result = validateTargetUrl(raw, BLOCKED);
    expect(result.ok).toBe(false);
  });

  it("http: は not_https として拒否される", () => {
    // 平文 HTTP は経路上で書き換えられる。カードの遷移先が
    // 攻撃者の用意した場所へすり替わる。
    expect(validateTargetUrl("http://example.com/", BLOCKED)).toEqual({
      ok: false,
      reason: "not_https",
    });
  });

  it("絶対 URL でなければ拒否する", () => {
    expect(validateTargetUrl("/relative/path", BLOCKED)).toEqual({
      ok: false,
      reason: "not_absolute",
    });
  });
});

describe("フィッシングに使える形を拒否する", () => {
  it("URL 内の資格情報を拒否する", () => {
    // `https://auth.under18.dev@evil.example/` は evil.example へ行くが、
    // 人の目には u18 のドメインに見える。
    expect(validateTargetUrl("https://auth.under18.dev@evil.example/", BLOCKED)).toEqual({
      ok: false,
      reason: "has_credentials",
    });
  });

  it("IdP 自身のオリジンを拒否する", () => {
    // 「u18 の正規ドメインへ飛ぶ短縮 URL」を利用者が自由に作れると、
    // ログイン画面・同意画面を踏ませる導線を外部から組み立てられる。
    expect(validateTargetUrl("https://auth.under18.dev/oauth/authorize", BLOCKED)).toEqual({
      ok: false,
      reason: "blocked_host",
    });
  });

  it("短縮 URL 自身のオリジンを拒否する", () => {
    // カード → カード の連鎖を作らせない。
    expect(validateTargetUrl("https://go.under18.dev/c/nfc_other", BLOCKED)).toEqual({
      ok: false,
      reason: "blocked_host",
    });
  });

  it("大文字小文字が違っても禁止オリジンとして扱う", () => {
    expect(validateTargetUrl("https://AUTH.under18.dev/", BLOCKED)).toEqual({
      ok: false,
      reason: "blocked_host",
    });
  });
});

describe("公開 Web でないホストを拒否する", () => {
  it.each([
    "https://127.0.0.1/",
    "https://192.168.1.1/admin",
    "https://10.0.0.1/",
    "https://[::1]/",
    "https://localhost/",
    "https://printer.local/",
    "https://router/",
    "https://service.internal/",
  ])("%s を拒否する", (raw) => {
    // カードをかざすのは第三者。その人のブラウザから、その人の LAN の
    // 機器へリクエストを飛ばす道具にしない。
    expect(validateTargetUrl(raw, BLOCKED)).toEqual({ ok: false, reason: "private_host" });
  });

  it("既定以外のポートを拒否する", () => {
    expect(validateTargetUrl("https://example.com:8443/", BLOCKED)).toEqual({
      ok: false,
      reason: "non_default_port",
    });
  });

  it("443 の明示は正規化で消えるので通る", () => {
    expect(validateTargetUrl("https://example.com:443/x", BLOCKED)).toEqual({
      ok: true,
      url: "https://example.com/x",
    });
  });
});

describe("受け付ける形", () => {
  it("正規化した URL を返す", () => {
    // OAuth の redirect_uri と違い、後で完全一致の照合をしないので
    // 正規化してよい（redirect-uri.ts との違い）。
    expect(validateTargetUrl("https://example.com", BLOCKED)).toEqual({
      ok: true,
      url: "https://example.com/",
    });
  });

  it("クエリとフラグメントを保つ", () => {
    const result = validateTargetUrl("https://example.com/p?a=1#top", BLOCKED);
    expect(result).toEqual({ ok: true, url: "https://example.com/p?a=1#top" });
  });

  it("長すぎる URL を拒否する", () => {
    const long = `https://example.com/${"a".repeat(2000)}`;
    expect(validateTargetUrl(long, BLOCKED)).toEqual({ ok: false, reason: "too_long" });
  });

  it("禁止オリジンを渡さなくても https 以外は落ちる", () => {
    expect(validateTargetUrl("http://example.com/").ok).toBe(false);
  });
});

describe("配信直前の最終確認", () => {
  it("https: だけを通す", () => {
    expect(isServableTargetUrl("https://example.com/")).toBe(true);
    expect(isServableTargetUrl("http://example.com/")).toBe(false);
    expect(isServableTargetUrl("javascript:alert(1)")).toBe(false);
    expect(isServableTargetUrl("not a url")).toBe(false);
  });
});

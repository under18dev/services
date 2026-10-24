/**
 * NFC カードのリダイレクト先 URL の検証（仕様書 10）。
 *
 * ## ここは OAuth の Redirect URI 検証とは別物である
 *
 * `apps/auth-worker/src/domain/services/redirect-uri.ts` と見た目は似ているが、
 * **同じ規則を使ってはならないし、同じ値を共有してもならない。**
 *
 * - OAuth の Redirect URI は「事前登録 → 認可時に完全一致」で、利用者が
 *   自由に書き換えられないことが安全性の根拠になっている。
 * - NFC の遷移先は**所有者がいつでも書き換えられる**。それが Phase 4 の
 *   完了条件そのもの（「カードを書き換えずに遷移先を変更可能」）である。
 *
 * したがって、ここで登録された URL を OIDC の `redirect_uri` として
 * 許可することは**絶対にできない**（仕様書 10 / #31）。許した瞬間、
 * 認可コードの宛先を利用者が実行時に差し替えられる経路、つまり
 * IdP 公認のオープンリダイレクタが出来上がる。auth-worker 側の
 * `oauth_redirect_uris` と、この `nfc_cards.target_url` は、
 * 値の経路としても型としても一切接続しないこと。
 *
 * ## 何を防ごうとしているのか
 *
 * 脅威は「カードの所有者が、カードをかざした通りすがりの人間のブラウザを
 * 任意の場所へ飛ばせる」こと。所有者は u18 の利用者であって信頼された
 * 運営者ではないので、遷移先は「普通の公開 Web ページ」に限る。
 *
 * 1. **`https:` のみ。** 平文 HTTP は経路上で書き換えられる（カードの
 *    遷移先が攻撃者に差し替わる）。`javascript:` / `data:` /
 *    `intent:` などは論外で、`Location` に入れた瞬間にスクリプト実行や
 *    アプリ起動の手段になる。許可リスト方式（https だけ）にして、
 *    新しいスキームが増えても既定で落ちるようにする。
 * 2. **URL 内の資格情報を拒否。** `https://auth.under18.dev@evil.example/`
 *    は `evil.example` へ行くが、人間の目には u18 のドメインに見える。
 *    これはフィッシングの古典で、u18 を騙る遷移先を作らせないために弾く。
 * 3. **IP リテラル・ループバック・イントラネット名を拒否。** カードを
 *    かざすのは第三者なので、`https://192.168.1.1/...` は「見知らぬ人の
 *    家庭内ルータへ、その人のブラウザから」リクエストを飛ばす道具になる。
 *    自分のサーバーへ向けるのと違い、被害者が他人である点が決定的。
 * 4. **既定ポート以外を拒否。** 公開 Web ページなら 443 で足りる。
 *    任意ポートを許すと、上と同じ理屈で内部ネットワークのポート走査に
 *    使える（遷移の成否が観測できる）。
 * 5. **IdP 自身のオリジンを拒否。** 遷移先を `https://auth.under18.dev/...`
 *    にできると、「u18 の正規ドメインへ飛ぶ短縮 URL」を利用者が自由に
 *    作れることになり、同意画面やログイン画面を踏ませる導線を外部から
 *    組み立てられる。禁止ホストは Env を知る層から渡す（Domain は
 *    `Env` を読まない）。
 *
 * ## 防げないこと（残余リスク）
 *
 * 任意の公開 https サイトを許す以上、「見た目が他社そっくりのフィッシング
 * サイト」そのものは静的検査では落とせない。ここは技術ではなく運用で受ける:
 * 所有者が userId で特定できること、全操作が `nfc_card_events` に残ること、
 * 運営がカード単位・ロット単位で即座に `disabled` にできること、
 * リダイレクトが 302 + `no-store` なので無効化が次のタップから効くこと。
 */

/** 遷移先として受け付けなかった理由。所有者に何を直せばよいか伝えるために使う。 */
export type TargetUrlRejection =
  /** 絶対 URL として解釈できない。 */
  | "not_absolute"
  /** 長すぎる。 */
  | "too_long"
  /** https: ではない。 */
  | "not_https"
  /** `https://user:pass@host/` 形式。 */
  | "has_credentials"
  /** 443 以外のポートが指定されている。 */
  | "non_default_port"
  /** IP リテラル・ループバック・イントラネット名など、公開 Web でないホスト。 */
  | "private_host"
  /** u18 自身のオリジン。 */
  | "blocked_host";

export type TargetUrlValidation =
  | { readonly ok: true; readonly url: string }
  | { readonly ok: false; readonly reason: TargetUrlRejection };

/**
 * 上限 1024 文字。
 *
 * `Location` ヘッダは多くの実装で 8KB 程度まで通るが、カードの遷移先に
 * それが要る場面は無い。上限を低く取るのは、長い URL が
 * 「リダイレクト連鎖の起点としてパラメータを詰め込む」用途に偏るため。
 */
const MAX_TARGET_URL_LENGTH = 1024;

/** 公開 Web ページとみなさないホスト名。 */
const NON_PUBLIC_HOSTS = new Set(["localhost"]);

/** 内部向けに予約・慣用されている TLD。 */
const NON_PUBLIC_SUFFIXES = [".local", ".localhost", ".internal", ".home.arpa", ".intranet"];

/** `192.0.2.1` のような IPv4 リテラルか。 */
function isIpv4Literal(hostname: string): boolean {
  const parts = hostname.split(".");
  if (parts.length !== 4) return false;
  return parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

/**
 * 公開インターネット上のホスト名として受け付けてよいか。
 *
 * ドットを含まない名前（`https://router/`）も落とす。これは社内 DNS や
 * mDNS で解決される名前の典型で、公開 Web ページには現れない。
 */
function isPublicHostname(hostname: string): boolean {
  const lower = hostname.toLowerCase();

  // WHATWG URL は IPv6 を `[::1]` の形で持つ。角括弧の時点で IP リテラル。
  if (lower.startsWith("[")) return false;
  if (isIpv4Literal(lower)) return false;
  if (NON_PUBLIC_HOSTS.has(lower)) return false;
  if (NON_PUBLIC_SUFFIXES.some((suffix) => lower.endsWith(suffix))) return false;
  if (!lower.includes(".")) return false;

  return true;
}

/**
 * 所有者が設定したリダイレクト先を検証し、保存してよい正規形を返す。
 *
 * ## なぜここでは正規化してよいのか
 *
 * `redirect-uri.ts` は正規形でない入力を**拒否**する。あちらは認可時に
 * バイト単位の完全一致で照合するので、保存時に黙って形を変えると
 * 「登録した文字列」と「送られてくる文字列」がずれて原因不明の失敗になるためだった。
 *
 * ここには照合が無い。保存した値をそのまま `Location` に載せるだけなので、
 * WHATWG URL の正規形（`https://example.com` → `https://example.com/`）を
 * そのまま採用してよい。むしろ利用者がブラウザからコピーした URL を
 * 「正規形でない」と拒否するほうが、得るものなく詰まらせる。
 *
 * @param blockedOrigins 遷移先にできないオリジン。IdP 自身の issuer などを
 *   Application 層から渡す（Domain は Env を読まない）。
 */
export function validateTargetUrl(
  raw: string,
  blockedOrigins: readonly string[] = [],
): TargetUrlValidation {
  if (raw.length > MAX_TARGET_URL_LENGTH) return { ok: false, reason: "too_long" };

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "not_absolute" };
  }

  // 許可リスト方式。`http:` はもちろん `javascript:` / `data:` もここで落ちる。
  if (url.protocol !== "https:") return { ok: false, reason: "not_https" };
  if (url.username !== "" || url.password !== "") return { ok: false, reason: "has_credentials" };

  // WHATWG URL は既定ポート (443) を空文字へ畳む。残っていれば明示指定。
  if (url.port !== "") return { ok: false, reason: "non_default_port" };

  if (!isPublicHostname(url.hostname)) return { ok: false, reason: "private_host" };

  const normalizedBlocked = blockedOrigins
    .map(parseOrigin)
    .filter((origin): origin is string => origin !== null);
  if (normalizedBlocked.includes(url.origin.toLowerCase())) {
    return { ok: false, reason: "blocked_host" };
  }

  return { ok: true, url: url.href };
}

/**
 * 保存済みの遷移先を配信してよいかの最終確認。
 *
 * 書き込み時に検証しているのに読み出し時にも見るのは、検証規則を後から
 * 厳しくしたとき、あるいは DB を別経路で書き換えられたときに、
 * 古い行がそのまま `Location` に載るのを防ぐため。保存時の検証を
 * 「過去に 1 度通ったこと」の記録としてしか信用しない。
 *
 * ここは `https:` だけを見る。ホスト規則まで再適用すると、規則を
 * 厳しくした瞬間に既存カードが一斉に沈黙し、利用者から見れば
 * 「カードが壊れた」になるため、そちらは次回の更新時に効かせる。
 */
export function isServableTargetUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function parseOrigin(value: string): string | null {
  try {
    return new URL(value).origin.toLowerCase();
  } catch {
    return null;
  }
}

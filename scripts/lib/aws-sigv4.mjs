/**
 * AWS Signature Version 4（R2 の S3 互換 API 用）。
 *
 * SDK を足さずに手で署名している。`@aws-sdk/client-s3` は依存とその推移的
 * 依存が大きく、**バックアップのためだけに供給網を広げたくない**
 * （docs/threat-model.md のサプライチェーン項）。必要なのは PutObject /
 * GetObject / ListObjectsV2 の 3 つだけで、その範囲なら仕様は短い。
 *
 * ## 検証できていること / いないこと
 *
 * 鍵導出（`deriveSigningKey`）は **AWS が公開しているテストベクタ 2 本**と
 * 一致することを `backup-d1.mjs self-check` が毎回確かめる。手計算した値を
 * 自分のコードで再現しても検証にならないので、外部の既知値に当てている。
 *
 * **正規化リクエストと string-to-sign は、実サービスに対して通していない。**
 * 実装は AWS のドキュメント（"Create a signed AWS API request"）の手順を
 * そのまま写しているが、R2 が有効化されるまで往復で確かめられない。
 * 通したら docs/runbook.md 12.6 のチェックを埋めること。
 *
 * ## R2 固有
 *
 * - region は `auto` 固定。R2 はリージョンを持たない。
 * - `x-amz-content-sha256` は S3 で必須。**`UNSIGNED-PAYLOAD` は使わない** ——
 *   実体のハッシュを載せれば、転送中に本文が壊れたら R2 側が弾く。
 *   バックアップの経路で「壊れたまま 200」が返るのは最悪なので、
 *   署名コストを払ってでも本文を署名対象に含める。
 */

import { createHash, createHmac } from "node:crypto";

const ALGORITHM = "AWS4-HMAC-SHA256";
const SERVICE = "s3";
const REGION = "auto";

const hmac = (key, data) => createHmac("sha256", key).update(data, "utf8").digest();
const sha256Hex = (data) => createHash("sha256").update(data).digest("hex");

/**
 * パスの各セグメントを URI エンコードする。
 *
 * **`/` は変換しない。** オブジェクトキーの階層区切りなので、エンコードすると
 * 別のキーを指すことになる（AWS の UriEncode の規則そのもの）。
 * `encodeURIComponent` が素通しする `!'()*` は手で潰す —— unreserved は
 * `A-Za-z0-9-._~` だけと定義されている。
 */
export function uriEncodePath(path) {
  return path
    .split("/")
    .map((segment) =>
      encodeURIComponent(segment).replace(
        /[!'()*]/g,
        (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
      ),
    )
    .join("/");
}

/** `20260224T123456Z` と `20260224`。 */
export function amzDate(now) {
  const stamp = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  return { amzDate: stamp, dateStamp: stamp.slice(0, 8) };
}

/**
 * 署名鍵を導出する。
 *
 * AWS のテストベクタ 2 本と一致することを self-check が確かめている。
 */
export function deriveSigningKey(secretKey, dateStamp, region = REGION, service = SERVICE) {
  let key = hmac(`AWS4${secretKey}`, dateStamp);
  key = hmac(key, region);
  key = hmac(key, service);
  return hmac(key, "aws4_request");
}

/**
 * 署名済みのヘッダを組み立てる。
 *
 * @param {object} input
 * @param {string} input.method        HTTP メソッド
 * @param {URL}    input.url           クエリを含む完全な URL
 * @param {Buffer|Uint8Array} input.body 本文（空なら長さ 0）
 * @param {Record<string,string>} input.headers 追加ヘッダ（content-type など）
 * @param {string} input.accessKey
 * @param {string} input.secretKey
 * @param {Date}   input.now
 */
export function signRequest({ method, url, body, headers = {}, accessKey, secretKey, now }) {
  const { amzDate: stamp, dateStamp } = amzDate(now);
  const payloadHash = sha256Hex(body ?? Buffer.alloc(0));

  const allHeaders = {
    ...headers,
    host: url.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": stamp,
  };

  // ヘッダ名は小文字・名前順。値は前後の空白を落とす。
  const names = Object.keys(allHeaders)
    .map((name) => name.toLowerCase())
    .sort();
  const canonicalHeaders = names
    .map((name) => {
      const [, value] = Object.entries(allHeaders).find(([k]) => k.toLowerCase() === name);
      return `${name}:${String(value).trim().replace(/\s+/g, " ")}\n`;
    })
    .join("");
  const signedHeaders = names.join(";");

  // クエリはエンコード後にキー名で並べ替える（順序が違うと署名が合わない）。
  const query = [...url.searchParams.entries()]
    .map(([k, v]) => [encodeURIComponent(k), encodeURIComponent(v)])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");

  const canonicalRequest = [
    method,
    uriEncodePath(url.pathname),
    query,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const scope = `${dateStamp}/${REGION}/${SERVICE}/aws4_request`;
  const stringToSign = [ALGORITHM, stamp, scope, sha256Hex(canonicalRequest)].join("\n");
  const signature = hmac(deriveSigningKey(secretKey, dateStamp), stringToSign).toString("hex");

  return {
    ...allHeaders,
    authorization: `${ALGORITHM} Credential=${accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

/**
 * AWS が公開しているテストベクタ。
 *
 * 自分で計算した値を自分で再現しても検証にならないので、**外部の既知値**に
 * 当てる。出典は AWS の SigV4 ドキュメントの鍵導出例。
 */
export const SIGNING_KEY_VECTORS = [
  {
    label: "20120215/us-east-1/iam",
    secretKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
    dateStamp: "20120215",
    region: "us-east-1",
    service: "iam",
    expected: "f4780e2d9f65fa895f9c67b32ce1baf0b0d8a43505a000a1a9e090d414db404d",
  },
  {
    label: "20150830/us-east-1/iam",
    secretKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
    dateStamp: "20150830",
    region: "us-east-1",
    service: "iam",
    expected: "c4afb1cc5771d871763a393e44b703571b55cc28424d1a5e86da6ed3c154a4b9",
  },
];

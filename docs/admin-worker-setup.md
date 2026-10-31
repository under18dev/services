# admin-worker のセットアップ（初回だけ）

**配る側（運営）が読むもの。** `admin.under18.dev` を動かすまでの、鶏と卵を解く手順。

## 0. この文書が前提にしていること（#390）

**u18 Identity 側には何も足さない。** `admin.under18.dev` には誰でも OIDC で
ログインできる——admin-worker はただの OAuth クライアントの 1 つである。
「誰が使ってよいか」は admin-worker 専用の D1（`ADMIN_DB`）が持つ
**承認リスト**だけで決まる。

**利用者の一覧・停止・失効のような Identity 側の操作は、まだこの画面から
できない。** `IdentityAdminRpcContract` の全メソッドが本物の Identity
セッション Cookie（`sessionToken`）を要求するが、admin-worker は別ホスト
なのでその Cookie を持たない——どう橋渡しするかはまだ決まっていない
（#390 のコメントを参照）。決まるまでは、承認リストとプレースホルダの
ホーム画面だけが動く。

---

## 1. OAuth クライアントを登録する（鶏と卵）

**admin-worker 自身を u18 Identity の OAuth クライアントとして登録する
必要があるが、登録するには管理画面が要る。** 最初の 1 つは CLI で登録する。

> **`--first-party` が CLI にしか無い。** 同意画面を省略するには
> 一次パーティ登録が要り、その入口は `apps/auth-worker/scripts/oauth-client.mjs`
> だけにしてある（RR-21 の緩和 2）。**「CLI を使うのは回避策ではなく唯一の
> 正規経路」である。**

### 手順

**`confidential` クライアントの `create` には `--out` が必須**（#445）。
`client_secret` を標準出力に出さず、指定したファイルへ書く——今夜
これが平文で人の目に触れた経路そのものだったため、`oauth-client.mjs`
自身がもう標準出力を選べないようにしてある。手順は `docs/runbook.md`
§9.6（`client_secret` を回す）と同じ形——ファイルへ書き、
`wrangler secret put` にファイルから読ませ、最後に消す。**人の手で値を
貼り直させないこと。**

```bash
# 1. まず SESSION_SECRET を用意して admin-worker に設定しておく
#    （この順序には意味が無いが、2〜4 を間を空けずに続けられるよう
#     先に済ませておく——平文の秘密がディスクに残る時間を短くするため）
node -e 'console.log(crypto.randomUUID()+crypto.randomUUID())'
cd apps/admin-worker
npx wrangler secret put SESSION_SECRET --env production
# 貼り付けて Enter

# 2. OAuth クライアントを登録する（--dry-run でまず SQL を確認してよい）。
#    client_secret は画面に出ず、--out で指定したファイルへ書かれる。
cd ../auth-worker
node scripts/oauth-client.mjs create \
  --client-id u18-admin --name "u18 Admin" --type confidential \
  --redirect-uri https://admin.under18.dev/callback \
  --first-party --out /tmp/u18-admin-secret.txt --remote

# 3. 生成された秘密を、間を置かずに admin-worker の Secret へ入れる。
#    ファイルの中身をそのまま渡すこと——cat で見てから打ち直さない。
cd ../admin-worker
npx wrangler secret put OIDC_CLIENT_SECRET --env production < /tmp/u18-admin-secret.txt

# 4. 秘密をディスクに残さない。
rm /tmp/u18-admin-secret.txt
```

**`redirect_uri` は `https://admin.under18.dev/callback` で固定。** OAuth の
Redirect URI は完全一致検証なので、`wrangler.jsonc` の `ADMIN_ORIGIN`
（本番）と揃っていること。

---

## 2. 承認リスト用の D1 を作る

```bash
cd apps/admin-worker
npx wrangler d1 create u18-admin
```

出力された `database_id` で `wrangler.jsonc` の 2 箇所
（既定 env と `env.production`）の `database_id` を置き換える
（プレースホルダ `00000000-0000-0000-0000-000000000000` のまま）。

```bash
npx wrangler d1 migrations apply u18-admin --remote
```

---

## 3. 最初の 1 人を承認リストへ入れる（CLI でゴリ押し）

**承認する側の画面（「誰が待っているか」の一覧）がまだ無いので、
最初の 1 人はこれでしか入れられない。**

```bash
cd apps/admin-worker

# 1. まず自分の sub を確かめる。admin.under18.dev でログインすると、
#    承認されていないので /pending へ送られる——この画面が自分の
#    sub と、そのまま貼れる grant コマンドを出す（ホームの
#    「サインインしました」は承認された後にしか見えないので、
#    最初の 1 人はここでは使えない）。
node scripts/admin-approval.mjs grant \
  --sub usr_xxx --actor <GitHubハンドルなど> --super --remote
```

**`--remote` で失敗したら、まず口座指定を疑うこと。**

```bash
npx wrangler whoami
CLOUDFLARE_ACCOUNT_ID=<口座 ID> node scripts/admin-approval.mjs grant ...
```

（`apps/auth-worker/scripts/admin-role.mjs` と同じ注意。2026-10-30、
複数口座の実機で確認済み。）

### 2 人目以降

**画面から承認する手段がまだ無い間は、同じ CLI で入れる。**

```bash
node scripts/admin-approval.mjs grant --sub usr_yyy --actor <実行者> --remote
node scripts/admin-approval.mjs list --remote
node scripts/admin-approval.mjs revoke --sub usr_yyy --actor <実行者> --remote
```

---

## 4. バックアップ対象が 1 つ増える

**`u18-admin`（ADMIN_DB）を `scripts/backup-d1.mjs` の対象に足すこと。**
忘れると、承認リストだけバックアップされない（#325）。

---

## 関連

- `docs/nfc-cards-operations.md` — 同じ形の「鶏と卵」をすでに解いた NFC の例
- `docs/u18-identity-spec.md` §14.1 決定 16 — 管理画面を別ホストへ分けるかの決定
- `packages/contracts/src/session-cookie.ts` — ホストを足すたびに戻ってくる 3 択

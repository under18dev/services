import type { OAuthClientSummary } from "@u18/contracts";
import {
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  KiwaShell,
  Separator,
} from "@u18/web-ui/kiwa";
import {
  EMPTY_CLASS,
  FIELD_CLASS,
  INPUT_CLASS,
  ITEM_BODY_CLASS,
  ITEM_META_CLASS,
  ITEM_RAW_CLASS,
  ITEM_TITLE_CLASS,
  LABEL_CLASS,
  LIST_CLASS,
} from "@u18/web-ui/kiwa/island-classes";
import type { FC } from "hono/jsx";
import { CSRF_FIELD_NAME } from "../csrf";
import { ADMIN_NAV_GROUPS } from "./nav";
import { KIWA_STYLESHEET_PATH } from "./asset-paths";
import { formatDateTime } from "./format";

/**
 * OAuth クライアントの管理（`admin.under18.dev/clients`、#308 / #333 / #390
 * 決定 16 ③ 段取り 3）。
 *
 * **`/account/admin/clients`（dashboard-worker、d5 が作ったもの、#380）から
 * 移した。** 画面の中身（一覧・登録・失効）はそのまま持ってきている。
 * 変わったのは呼び方（セッション Cookie 経由の UseCase →
 * `IdentityAdminDelegatedRPC` 経由）と置き場所だけ。
 *
 * ## この画面は JS を 1 行も要求しない（移行元と同じ理由）
 *
 * 一覧も登録も失効も**ただの form POST** である。アイランドを読まないのは、
 * **`client_secret` が 1 度しか返らない**ことと直結している —— JS の有無で
 * 出し分けると、**登録だけ済んで秘密を受け取れない**利用者が出る。秘密は
 * サーバーが描き、ブラウザは表示するだけ。
 *
 * コピーボタンを後から足すならアイランドでよい。**値そのものをアイランドに
 * 描かせないこと。**
 *
 * ## `client_secret` を URL に載せない（移行元と同じ理由）
 *
 * 登録は POST の応答をそのまま描く（PRG を挟まない）。リダイレクトすると
 * 秘密を次の GET へ運ぶ必要があり、クエリにもパスにも Cookie にも
 * 置きたくない。**再読み込みで再送される。** `client_id` は自動生成
 * （#408）なので「2 件目は `conflict` になる」とは言えないが、対策は
 * 入れていない —— 登録は運営だけが叩く稀な操作で、重複に気づいたら片方を
 * 失効させれば済むため、新しい状態保持の仕組みを足すほどの見合いが無い
 * （delegated 契約側の JSDoc も参照）。
 *
 * ## 一次パーティは押す前に分かる（移行元と同じ理由）
 *
 * `isFirstParty` のクライアントは失効させられない（delegated UseCase が
 * `conflict` を返す）。**押してから断られる形にしない** —— ボタンを出さず、
 * 理由を添える。
 *
 * ## `isAdmin` の出し分けは無い（移行元との違い）
 *
 * dashboard-worker 版は「管理者でない利用者」と同じ Worker で同居するので
 * `isAdmin` と `AdminNotFoundPage` を持っていた。admin-worker は承認済みの
 * 運営だけが `app.ts` のガードを通って辿り着く別アプリなので、ここへ来る
 * 時点で全員が運営である（`nfc-page.tsx` と同じ判断）。
 */

export type CreatedClient = {
  readonly client: OAuthClientSummary;
  readonly clientSecret: string | null;
};

export type ClientsPageProps = {
  readonly csrfToken: string;
  readonly clients: readonly OAuthClientSummary[];
  /** 直前の登録。**この応答にしか無い** `client_secret` を持つ。 */
  readonly created?: CreatedClient;
  /** 直前の操作が失敗したときの、人が読む 1 文。 */
  readonly error?: string;
  /** 直前の失効が成功したときの 1 文。 */
  readonly notice?: string;
};

/**
 * 1 度しか表示されない `client_secret`（移行元と同じ理由）。
 *
 * ## 操作の成否と、控えの成否を分けて言う
 *
 * 見出しは**先に「登録しました」と言い切る。** `client_id` は自動生成
 * なので、秘密を取り損ねた人が「失敗したのでもう一度」と押すと、
 * **`conflict` にはならず、別の `client_id` でもう 1 本登録される。**
 * 気づかないと、同じ用途のクライアントが 2 つ残ったまま運用されることに
 * なる。作成は済んでいる、という事実を最初に伝えるのは、この「気づかれない
 * 重複」を減らすためでもある。
 *
 * ## 空欄を出さない
 *
 * `clientSecret` が null（public クライアント）のときは**枠ごと出さない。**
 * 「二度と表示されません」と書いた枠に空欄があると、取り損ねたと読める。
 */
const SecretOnce: FC<{ readonly created: CreatedClient }> = ({ created }) => (
  <Card>
    <CardHeader>
      <CardTitle>「{created.client.name}」を登録しました</CardTitle>
    </CardHeader>
    <CardContent>
      {created.clientSecret === null ? (
        <p class={ITEM_META_CLASS}>
          public クライアントなので client_secret はありません。認可コードの交換には PKCE
          を使ってください。
        </p>
      ) : (
        <div class={ITEM_BODY_CLASS}>
          <p class={ITEM_META_CLASS}>
            <strong>client_secret はこの画面にしか表示されません。</strong>
            いま控えてください。保存されているのはハッシュだけなので、u18
            の側から読み出すことはできません。
          </p>
          {/*
            **`<input readonly>` で出す。** `<code>` だと選択しづらく、
            JS 無しでは全選択する手段が無い。値はサーバーが描いており、
            ここに JS は関わらない。
          */}
          <label class={FIELD_CLASS}>
            <span class={LABEL_CLASS}>client_secret</span>
            <input class={INPUT_CLASS} type="text" readonly value={created.clientSecret} />
          </label>
          <p class={ITEM_META_CLASS}>
            控えそこねた場合は、このクライアントを失効させて別の client_id で登録し直してください。
          </p>
        </div>
      )}
      <Separator />
      <p class={ITEM_RAW_CLASS}>client_id: {created.client.clientId}</p>
    </CardContent>
  </Card>
);

/** 1 行ぶん。失効のボタンは「押せるときだけ」出す。 */
const ClientRow: FC<{ readonly client: OAuthClientSummary; readonly csrfToken: string }> = ({
  client,
  csrfToken,
}) => (
  <li class={ITEM_BODY_CLASS}>
    <div class={ITEM_TITLE_CLASS}>
      <span>{client.name}</span>
      {client.isFirstParty ? <Badge variant="secondary">u18 公式</Badge> : null}
      {client.clientType === "public" ? <Badge variant="outline">public</Badge> : null}
      {client.disabledAt === null ? null : <Badge variant="destructive">失効済み</Badge>}
    </div>
    <p class={ITEM_RAW_CLASS}>{client.clientId}</p>
    <p class={ITEM_META_CLASS}>
      登録 {formatDateTime(client.createdAt)}
      {client.disabledAt === null ? "" : ` / 失効 ${formatDateTime(client.disabledAt)}`}
    </p>
    <p class={ITEM_META_CLASS}>scope: {client.scopes.join(" ")}</p>
    <ul class={LIST_CLASS}>
      {client.redirectUris.map((uri) => (
        /*
          **リンクにしない。** 登録された宛先は「認可コードを届けてよい
          場所」であって、運営が開いてよい場所ではない。押せるようにすると、
          一覧を見ただけで第三者のサーバーへ遷移する導線になる。
        */
        <li class={ITEM_RAW_CLASS}>{uri}</li>
      ))}
    </ul>
    {client.isFirstParty ? (
      <p class={ITEM_META_CLASS}>
        u18 公式のクライアントは、この画面からは失効させられません。
        ログイン画面そのものが止まるためです。
      </p>
    ) : client.disabledAt === null ? (
      <form method="post" action="/clients/disable">
        <input type="hidden" name={CSRF_FIELD_NAME} value={csrfToken} />
        <input type="hidden" name="client_id" value={client.clientId} />
        <button type="submit" class="text-sm text-destructive underline underline-offset-4">
          失効させる
        </button>
      </form>
    ) : null}
  </li>
);

export const ClientsPage: FC<ClientsPageProps> = ({
  csrfToken,
  clients,
  created,
  error,
  notice,
}) => (
  <KiwaShell
    title="OAuth クライアント"
    nav={ADMIN_NAV_GROUPS}
    current="clients"
    brandHref="/"
    stylesheet={KIWA_STYLESHEET_PATH}
    heading="OAuth クライアント"
    lead="u18 でログインできるアプリの登録と失効を行います。"
  >
    {error === undefined ? null : (
      <Card>
        <CardContent>
          <p class={ITEM_META_CLASS}>{error}</p>
        </CardContent>
      </Card>
    )}
    {notice === undefined ? null : (
      <Card>
        <CardContent>
          <p class={ITEM_META_CLASS}>{notice}</p>
        </CardContent>
      </Card>
    )}
    {created === undefined ? null : <SecretOnce created={created} />}

    <Card>
      <CardHeader>
        <CardTitle>新しいクライアントを登録する</CardTitle>
      </CardHeader>
      <CardContent>
        <form method="post" action="/clients" class={ITEM_BODY_CLASS}>
          <input type="hidden" name={CSRF_FIELD_NAME} value={csrfToken} />
          <label class={FIELD_CLASS}>
            <span class={LABEL_CLASS}>表示名</span>
            <input class={INPUT_CLASS} type="text" name="name" required maxlength={255} />
          </label>
          <fieldset class={FIELD_CLASS}>
            <span class={LABEL_CLASS}>種別</span>
            {/*
              **既定を confidential にしない。** 取り違えると、秘密を
              持てない SPA に秘密が発行される。選ばせる。
            */}
            <label class={ITEM_META_CLASS}>
              <input type="radio" name="client_type" value="confidential" required /> confidential
              （サーバー側で client_secret を保管できる）
            </label>
            <label class={ITEM_META_CLASS}>
              <input type="radio" name="client_type" value="public" required /> public （SPA
              やネイティブアプリ。PKCE を使う）
            </label>
          </fieldset>
          <label class={FIELD_CLASS}>
            <span class={LABEL_CLASS}>Redirect URI（1 行に 1 つ）</span>
            {/*
              **完全一致で照合される。** 末尾のスラッシュ 1 つで認可が
              通らなくなるので、登録した実物をそのまま書く。
            */}
            <textarea class={INPUT_CLASS} name="redirect_uris" rows={3} required />
          </label>
          <label class={FIELD_CLASS}>
            <span class={LABEL_CLASS}>scope（省略すると openid profile email）</span>
            <input class={INPUT_CLASS} type="text" name="scopes" maxlength={255} />
          </label>
          <label class={FIELD_CLASS}>
            <span class={LABEL_CLASS}>ロゴの URL（省略可。https のみ）</span>
            <input class={INPUT_CLASS} type="url" name="logo_url" maxlength={2048} />
          </label>
          {/*
            **`is_first_party` の欄は無い。** 契約の入力に項目が無く、
            ここから同意画面の省略は取れない。一次パーティの登録は
            `scripts/oauth-client.mjs --first-party` だけに残っている。
          */}
          <p class={ITEM_META_CLASS}>
            ここから登録したクライアントでは、利用者に必ず同意画面が表示されます。
          </p>
          <div>
            <button type="submit" class="text-sm text-foreground underline underline-offset-4">
              登録する
            </button>
          </div>
        </form>
      </CardContent>
    </Card>

    <Card>
      <CardHeader>
        <CardTitle>登録済みのクライアント</CardTitle>
      </CardHeader>
      <CardContent>
        {clients.length === 0 ? (
          <p class={EMPTY_CLASS}>まだ登録されていません。</p>
        ) : (
          <ul class={LIST_CLASS}>
            {clients.map((client) => (
              <ClientRow client={client} csrfToken={csrfToken} />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  </KiwaShell>
);

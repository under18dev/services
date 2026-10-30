import type { OAuthClientSummary } from "@u18/contracts";
import { Badge, Card, CardContent, CardHeader, CardTitle, Separator } from "@u18/web-ui/kiwa";
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
import { AccountShell } from "./account-shell";
import { ADMIN_CLIENTS_CREATE_PATH, ADMIN_CLIENTS_DISABLE_PATH } from "./asset-paths";
import { CSRF_FIELD_NAME } from "../csrf";
import { formatDateTime } from "./format";

/**
 * OAuth クライアントの管理（`/account/admin/clients`、#308 / #333）。
 *
 * ## この画面は JS を 1 行も要求しない
 *
 * 一覧も登録も失効も**ただの form POST** である。アイランドを読まない
 * のは、**`client_secret` が 1 度しか返らない**ことと直結している ——
 * JS の有無で出し分けると、**登録だけ済んで秘密を受け取れない**利用者が
 * 出る。秘密はサーバーが描き、ブラウザは表示するだけ。
 *
 * コピーボタンを後から足すならアイランドでよい。**値そのものを
 * アイランドに描かせないこと。**
 *
 * ## `client_secret` を URL に載せない
 *
 * 登録は POST の応答をそのまま描く（PRG を挟まない）。リダイレクトすると
 * 秘密を次の GET へ運ぶ必要があり、クエリにもパスにも Cookie にも
 * 置きたくない。**再読み込みで再送されるが、`client_id` は一意制約を
 * 持つので 2 件目は `conflict` になる**（`Idempotency-Key` は要らない）。
 *
 * ## 一次パーティは押す前に分かる
 *
 * `isFirstParty` のクライアントは失効させられない（UseCase が `conflict`
 * を返す）。**押してから断られる形にしない** —— ボタンを出さず、理由を
 * 添える。押せるのに断られる画面は、利用者に「壊れている」と読まれる。
 *
 * ## 名前も `client_id` も、ここが出す文字列は第三者由来ではない
 *
 * 登録できるのは管理者だけなので、`GrantsPage` のような「アプリ作者が
 * 付けた名前」の警戒は要らない。**それでもエスケープは hono/jsx に
 * 任せる**（`raw()` を使わない）—— 管理者が増えたときに前提が変わる。
 */

export type CreatedClient = {
  readonly client: OAuthClientSummary;
  readonly clientSecret: string | null;
};

export type AdminClientsPageProps = {
  readonly isAdmin: boolean;
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
 * 1 度しか表示されない `client_secret`。
 *
 * ## 操作の成否と、控えの成否を分けて言う
 *
 * 見出しは**先に「登録しました」と言い切る。** 秘密を取り損ねた人が
 * 「失敗したのでもう一度」と押すと、`client_id` が重複して `conflict` に
 * なり、**何が起きたのか分からなくなる。** 作成は済んでいる、という
 * 事実を最初に伝える。
 *
 * ## 復旧の手順もここに書く
 *
 * 部品として切り出していない。**呼ぶ側が 1 つしか無い**ので、汎用の枠と
 * 復旧の文言を分けても prop が 1 つ増えるだけである（2 つ目が出たときに
 * 切り出す）。
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
          場所」であって、管理者が開いてよい場所ではない。押せるように
          すると、一覧を見ただけで第三者のサーバーへ遷移する導線になる。
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
      <form method="post" action={ADMIN_CLIENTS_DISABLE_PATH}>
        <input type="hidden" name={CSRF_FIELD_NAME} value={csrfToken} />
        <input type="hidden" name="client_id" value={client.clientId} />
        <button type="submit" class="text-sm text-destructive underline underline-offset-4">
          失効させる
        </button>
      </form>
    ) : null}
  </li>
);

export const AdminClientsPage: FC<AdminClientsPageProps> = ({
  isAdmin,
  csrfToken,
  clients,
  created,
  error,
  notice,
}) => (
  <AccountShell
    isAdmin={isAdmin}
    title="OAuth クライアント"
    heading="OAuth クライアント"
    lead="u18 でログインできるアプリの登録と失効を行います。"
    current="clients"
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
        <form method="post" action={ADMIN_CLIENTS_CREATE_PATH} class={ITEM_BODY_CLASS}>
          <input type="hidden" name={CSRF_FIELD_NAME} value={csrfToken} />
          <label class={FIELD_CLASS}>
            <span class={LABEL_CLASS}>client_id</span>
            <input class={INPUT_CLASS} type="text" name="client_id" required maxlength={255} />
          </label>
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
              通らなくなるので、登録した実物をそのまま書く
              （`domain/services/redirect-uri.ts`）。
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
            **`is_first_party` の欄は無い。** 契約の入力に項目が無く
            （RR-21 の緩和 2）、ここから同意画面の省略は取れない。
            一次パーティの登録は `scripts/oauth-client.mjs --first-party`
            だけに残っている。
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
  </AccountShell>
);

/**
 * 管理者でない人がこの URL を直接開いたときの画面。
 *
 * **「権限がありません」と書かない。** auth-worker が `not_found` を
 * 返しているのと同じ理由で、**管理機能が存在することを教えない**
 * （`application/use-cases/admin-access.ts`）。サイドバーに出ないことと
 * 揃える。
 */
export const AdminNotFoundPage: FC = () => (
  <AccountShell title="ページが見つかりません" heading="ページが見つかりません" isAdmin={false}>
    <Card>
      <CardHeader>
        <CardTitle>お探しのページはありません。</CardTitle>
      </CardHeader>
    </Card>
  </AccountShell>
);

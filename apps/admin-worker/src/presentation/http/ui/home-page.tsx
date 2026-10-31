import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  KiwaShell,
} from "@u18/web-ui/kiwa";
import { ITEM_RAW_CLASS } from "@u18/web-ui/kiwa/island-classes";
import type { FC } from "hono/jsx";
import { ADMIN_NAV_GROUPS } from "./nav";
import { KIWA_STYLESHEET_PATH } from "./asset-paths";

/**
 * ホーム（`/`、#443）。**承認済みの人だけが来る**（`app.ts` のガード）。
 *
 * #390 の骨組み段階では「画面はここに積む」というプレースホルダの
 * 生テキストのままだった。4 枚（NFC・クライアント・利用者・監査ログ）が
 * 揃った now では、ここも同じ Kiwa の外枠で描く——承認されたあと
 * 最初に見る画面でもある。
 */
export type HomePageProps = {
  readonly sub: string;
};

export const HomePage: FC<HomePageProps> = ({ sub }) => (
  <KiwaShell
    title="u18 Admin"
    nav={ADMIN_NAV_GROUPS}
    current="home"
    brandHref="/"
    stylesheet={KIWA_STYLESHEET_PATH}
    heading="u18 Admin"
    lead="左のメニューから操作を選んでください。"
  >
    <Card>
      <CardHeader>
        <CardTitle>サインインしました</CardTitle>
        <CardDescription>
          ID: <span class={ITEM_RAW_CLASS}>{sub}</span>
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ul class="flex flex-col gap-2">
          {ADMIN_NAV_GROUPS.flatMap((group) => group.items).map((item) => (
            <li>
              <a href={item.href} class="text-sm text-foreground underline underline-offset-4">
                {item.label}
              </a>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  </KiwaShell>
);

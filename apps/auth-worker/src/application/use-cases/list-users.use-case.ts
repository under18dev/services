import type { User } from "../../domain/entities/user";
import { decodeCursor, nextCursorOf } from "../../domain/services/keyset-cursor";
import type { UserRepository } from "../ports/user.repository";
import { requireAdminSession, type AdminAccessDeps } from "./admin-access";
import { err, ok, type UseCaseResult } from "./types";

export type ListUsersCommand = {
  readonly sessionToken: string;
  readonly query?: string;
  readonly cursor?: string;
  readonly limit?: number;
};

export type ListUsersOutput = {
  readonly users: readonly User[];
  readonly nextCursor: string | null;
};

export type ListUsersDeps = AdminAccessDeps & {
  readonly users: UserRepository;
};

/** 既定で返す件数。画面 1 枚に収まる量。 */
const DEFAULT_LIMIT = 50;
/** 1 回の上限。**「名簿を 1 リクエストで吸い出す口」にしないため。** */
const MAX_LIMIT = 200;

/**
 * 利用者の一覧（#375 / #382）。**管理者のみ。**
 *
 * ## これまでと違うところ
 *
 * **他人を指す最初の UseCase である。** `sessionToken` は「誰が聞いて
 * いるか」だけを決め、**何が返るかは聞いている人と無関係**になった。
 * だからこそ `requireAdminSession` が最初に来る —— ここを通らない限り、
 * 1 行も読まない。
 *
 * ## 監査ログに行を作らない
 *
 * `ListOAuthClientsUseCase` と同じ判断である。読み取りで状態が変わらない
 * ことに加え、**拒否のたびに 1 行書くと、有効なセッションを持つ相手が
 * 呼ぶだけで `audit_logs` を伸ばせる**（RPC 経路にレート制限は無い）。
 * 拒否は `admin.denied` として observability に出る。
 *
 * **この UseCase は `AuditLogger` を依存に持たない。** 書きようがない形。
 *
 * ## 「誰が誰を見たか」は残らない
 *
 * **これは意図した欠落であり、再検討の余地がある。** 上の理由で拒否を
 * 書かないのと違い、**成功した閲覧**は管理者の数で頭打ちになるので
 * 書いても伸びない。書いていないのは、**いまは「一覧を引いた」以上の
 * 情報が無い**（誰を見たかまでは分からない）ためで、個人を開く画面が
 * 入るときに作り直すこと。
 */
export class ListUsersUseCase {
  constructor(private readonly deps: ListUsersDeps) {}

  async execute(command: ListUsersCommand): Promise<UseCaseResult<ListUsersOutput>> {
    const admin = await requireAdminSession(this.deps, command.sessionToken, "listUsers");
    if (!admin.ok) return admin;

    const limit = Math.min(command.limit ?? DEFAULT_LIMIT, MAX_LIMIT);

    const after = command.cursor === undefined ? undefined : decodeCursor(command.cursor);
    if (command.cursor !== undefined && after === null) {
      return err("invalid_input", "cursor is malformed");
    }

    // **1 件多く読む。** 「続きがあるか」を `count(*)` で聞かないため。
    // 総数を数えると行が増えるほど重くなるうえ、**知りたいのは次が
    // あるかどうかだけ**である。
    const rows = await this.deps.users.listForAdmin({
      ...(command.query === undefined ? {} : { query: command.query }),
      ...(after === undefined || after === null ? {} : { after }),
      limit: limit + 1,
    });

    return ok({
      users: rows.slice(0, limit),
      // **「ちょうど limit 件あった」を「続きがある」と言わない。**
      // 余分に読んだ 1 件が実在したときだけカーソルを返す
      // （共通処理は keyset-cursor.ts、#375 のネガティブ確認で学んだ形）。
      nextCursor: nextCursorOf(rows, limit),
    });
  }
}

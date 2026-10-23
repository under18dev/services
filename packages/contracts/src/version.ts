/**
 * RPC 契約のバージョン。
 *
 * 破壊的変更を入れるときは MAJOR を上げ、呼び出し元 Worker を先にデプロイできるよう
 * 旧メソッドを 1 バージョン分は残す（仕様書 4.4「RPC 契約変更時は後方互換性を確認し、
 * Worker のデプロイ順を管理する」）。
 */
export const CONTRACT_VERSION = "1.0.0" as const;
export type ContractVersion = typeof CONTRACT_VERSION;

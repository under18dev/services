import { describe, expect, it } from "vitest";
import {
  ALL_DEFINED_PERMISSIONS,
  effectivePermissions,
  formatPermissions,
  hasPermission,
  parsePermissions,
  PERMISSION_BITS,
  permissionNames,
} from "../src/domain/permissions";

describe("ALL_DEFINED_PERMISSIONS", () => {
  it("255 と一致する（0002 のバックフィル値と独立に固定する）", () => {
    // マイグレーションの SQL は定数をハードコードしているので、ここが
    // ずれても気づけない。両方が 255 を指していることを両側から固定する。
    expect(ALL_DEFINED_PERMISSIONS).toBe(255n);
  });

  it("定義したビットの数だけ違う値を使っている（重複が無い）", () => {
    const bits = Object.values(PERMISSION_BITS);
    expect(new Set(bits).size).toBe(bits.length);
  });
});

describe("parsePermissions / formatPermissions", () => {
  it("往復する", () => {
    expect(formatPermissions(parsePermissions("255"))).toBe("255");
  });

  it("壊れた値は丸めずに例外にする", () => {
    expect(() => parsePermissions("not-a-number")).toThrow();
  });
});

describe("effectivePermissions / hasPermission", () => {
  it("super は保存された permissions を無視し、常に通す", () => {
    const effective = effectivePermissions({ isSuperApprover: true, permissions: 0n });
    expect(hasPermission(effective, PERMISSION_BITS.NFC_WRITE)).toBe(true);
    expect(hasPermission(effective, PERMISSION_BITS.APPROVAL_GRANT)).toBe(true);
  });

  it("非 super は持っているビットだけ通す", () => {
    const effective = effectivePermissions({
      isSuperApprover: false,
      permissions: PERMISSION_BITS.NFC_READ | PERMISSION_BITS.NFC_WRITE,
    });
    expect(hasPermission(effective, PERMISSION_BITS.NFC_READ)).toBe(true);
    expect(hasPermission(effective, PERMISSION_BITS.NFC_WRITE)).toBe(true);
    expect(hasPermission(effective, PERMISSION_BITS.USER_READ)).toBe(false);
  });

  it("ビットを持たなければ 0 でも通らない", () => {
    const effective = effectivePermissions({ isSuperApprover: false, permissions: 0n });
    expect(hasPermission(effective, PERMISSION_BITS.NFC_READ)).toBe(false);
  });
});

describe("permissionNames（表示）", () => {
  it("super は ALL を返し、ビットを列挙しない", () => {
    // **ここが肝。** 保存された全ビットから作ると、ビットを足した日に
    // super の表示だけ古いままになる。
    const effective = effectivePermissions({ isSuperApprover: true, permissions: 0n });
    expect(permissionNames(effective)).toBe("ALL");
  });

  it("super は、保存された permissions が 0 でも ALL のまま", () => {
    // 移行直後の実際の値（255）を渡しても、将来ビットを足して
    // 255 が「全部」ではなくなっても、表示が狂わないことを固定する。
    const effective = effectivePermissions({ isSuperApprover: true, permissions: 255n });
    expect(permissionNames(effective)).toBe("ALL");
  });

  it("非 super は持っているビットの名前だけを返す", () => {
    const effective = effectivePermissions({
      isSuperApprover: false,
      permissions: PERMISSION_BITS.NFC_READ | PERMISSION_BITS.AUDIT_READ,
    });
    expect(permissionNames(effective)).toEqual(["NFC_READ", "AUDIT_READ"]);
  });

  it("非 super で 0 件なら空配列", () => {
    const effective = effectivePermissions({ isSuperApprover: false, permissions: 0n });
    expect(permissionNames(effective)).toEqual([]);
  });
});

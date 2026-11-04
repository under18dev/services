import { describe, expect, it } from "vitest";
import {
  checkApprovalRevocation,
  checkPermissionRevocation,
  checkSuperApproverChange,
} from "../src/domain/approval-guard";
import { PERMISSION_BITS } from "../src/domain/permissions";

describe("checkSuperApproverChange", () => {
  it("昇格(非super→super)は常に通る", () => {
    const result = checkSuperApproverChange({
      actorSub: "usr_a",
      targetSub: "usr_b",
      targetIsCurrentlySuperApprover: false,
      newIsSuperApprover: true,
      totalSuperApproverCount: 1,
    });
    expect(result.ok).toBe(true);
  });

  it("他人を、他に super がいる状態で降格するのは通る", () => {
    const result = checkSuperApproverChange({
      actorSub: "usr_a",
      targetSub: "usr_b",
      targetIsCurrentlySuperApprover: true,
      newIsSuperApprover: false,
      totalSuperApproverCount: 2,
    });
    expect(result.ok).toBe(true);
  });

  it("自分自身を降格するのは、他に super が何人いても拒否する", () => {
    const result = checkSuperApproverChange({
      actorSub: "usr_a",
      targetSub: "usr_a",
      targetIsCurrentlySuperApprover: true,
      newIsSuperApprover: false,
      totalSuperApproverCount: 5,
    });
    expect(result.ok).toBe(false);
  });

  it("最後の super を他人が降格しようとしても拒否する", () => {
    const result = checkSuperApproverChange({
      actorSub: "usr_a",
      targetSub: "usr_b",
      targetIsCurrentlySuperApprover: true,
      newIsSuperApprover: false,
      totalSuperApproverCount: 1,
    });
    expect(result.ok).toBe(false);
  });
});

describe("checkApprovalRevocation", () => {
  it("super でない相手の剥奪は常に通る(自分自身でも)", () => {
    const result = checkApprovalRevocation({
      actorSub: "usr_a",
      targetSub: "usr_a",
      targetIsCurrentlySuperApprover: false,
      totalSuperApproverCount: 1,
    });
    expect(result.ok).toBe(true);
  });

  it("他に super がいる状態で、他人の super 承認を剥奪するのは通る", () => {
    const result = checkApprovalRevocation({
      actorSub: "usr_a",
      targetSub: "usr_b",
      targetIsCurrentlySuperApprover: true,
      totalSuperApproverCount: 2,
    });
    expect(result.ok).toBe(true);
  });

  it("自分自身が super のとき、自分の承認を剥奪できない", () => {
    const result = checkApprovalRevocation({
      actorSub: "usr_a",
      targetSub: "usr_a",
      targetIsCurrentlySuperApprover: true,
      totalSuperApproverCount: 3,
    });
    expect(result.ok).toBe(false);
  });

  it("最後の super の承認を剥奪できない", () => {
    const result = checkApprovalRevocation({
      actorSub: "usr_a",
      targetSub: "usr_b",
      targetIsCurrentlySuperApprover: true,
      totalSuperApproverCount: 1,
    });
    expect(result.ok).toBe(false);
  });
});

describe("checkPermissionRevocation", () => {
  it("他人の APPROVAL_GRANT を剥奪するのは通る", () => {
    const result = checkPermissionRevocation({
      actorSub: "usr_a",
      targetSub: "usr_b",
      bit: PERMISSION_BITS.APPROVAL_GRANT,
    });
    expect(result.ok).toBe(true);
  });

  it("自分自身の APPROVAL_GRANT 以外のビットは自分で落とせる", () => {
    const result = checkPermissionRevocation({
      actorSub: "usr_a",
      targetSub: "usr_a",
      bit: PERMISSION_BITS.NFC_WRITE,
    });
    expect(result.ok).toBe(true);
  });

  it("自分自身の APPROVAL_GRANT は落とせない", () => {
    const result = checkPermissionRevocation({
      actorSub: "usr_a",
      targetSub: "usr_a",
      bit: PERMISSION_BITS.APPROVAL_GRANT,
    });
    expect(result.ok).toBe(false);
  });
});

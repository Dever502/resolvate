import { describe, expect, it } from "vitest";
import { ApiError } from "../api/client";
import {
  confirmation, fitsNotice, formatProblem, newReceipt, outcome, readReceipt, receiptKey, receiptText, removeReceipt,
  writeReceipt,
} from "./commandAttempt";

const command = (name: string, args = "") => ({ name, description: "", arguments: args, mutation: true });

describe("outcome", () => {
  it("an answer is completed only when the server says so", () => {
    expect(outcome({ status: "completed" })).toBe("completed");
    expect(outcome({ status: "unknown" })).toBe("unknown");
    expect(outcome({})).toBe("unknown");
  });

  it("errors the endpoint returns before reserving the key are refusals; anything else is unknown", () => {
    for (const status of [400, 401, 403, 404, 413, 422, 429]) expect(outcome(null, new ApiError("нет", status))).toBe("rejected");
    // 409: the key is someone else's; 5xx: the action may have run; 0: no answer at all.
    for (const status of [409, 500, 502, 503, 504, 0]) expect(outcome(null, new ApiError("?", status))).toBe("unknown");
    expect(outcome(null, new DOMException("aborted", "AbortError"))).toBe("unknown");
    expect(outcome(null, new Error("lost"))).toBe("unknown");
  });
});

describe("receipts", () => {
  it("keep the key and the arguments, never a note's text", () => {
    const gift = newReceipt("gift", "30", "f1");
    expect(gift).toMatchObject({ fingerprint: "f1", command: "gift", arguments: "30" });
    expect(gift.key).toMatch(/^[0-9a-f-]{36}$/);
    expect(receiptText(gift)).toBe("/gift 30");
    expect(receiptText(newReceipt("resetkey", "", "f2"))).toBe("/resetkey");
    const note = newReceipt("note", "секрет клиента", "f3");
    expect(note.arguments).toBeNull();
    expect(JSON.stringify(note)).not.toContain("секрет");
    expect(receiptText(note)).toBeNull();
    // A receipt of the previous version has no command: only its draft can repeat it.
    expect(receiptText({ fingerprint: "f", key: "k" })).toBeNull();
  });

  it("are read back, and a damaged one fails closed", () => {
    sessionStorage.clear();
    expect(readReceipt(sessionStorage, "a:p:t")).toBeNull();
    writeReceipt(sessionStorage, "a:p:t", { fingerprint: "f", key: "k", command: "gift", arguments: "3" });
    expect(readReceipt(sessionStorage, "a:p:t")).toEqual({ fingerprint: "f", key: "k", command: "gift", arguments: "3" });
    sessionStorage.setItem(receiptKey("a:p:t"), "{broken");
    expect(() => readReceipt(sessionStorage, "a:p:t")).toThrow();
    sessionStorage.setItem(receiptKey("a:p:t"), JSON.stringify({ key: 1 }));
    expect(() => readReceipt(sessionStorage, "a:p:t")).toThrow();
    removeReceipt(sessionStorage, "a:p:t");
    expect(readReceipt(sessionStorage, "a:p:t")).toBeNull();
  });
});

describe("formatProblem", () => {
  it("checks arguments as the server does", () => {
    expect(formatProblem(command("gift", "<дни>"), "30")).toBeNull();
    for (const value of ["0", "10000", "1.5", "", "30 x"]) expect(formatProblem(command("gift", "<дни>"), value)).toBe("Формат: /gift <дни>");
    expect(formatProblem(command("note", "<текст>"), "")).toBe("Формат: /note <текст>");
    expect(formatProblem(command("info"), "лишнее")).toBe("Формат: /info");
    expect(formatProblem(command("resolvepanel", "<UUID> applied|not_applied"), "123e4567-e89b-12d3-a456-426614174000 applied")).toBeNull();
  });
});

describe("confirmation", () => {
  it("reading, a note, closing without a notice and unblocking run without one", () => {
    for (const name of ["info", "subinfo", "notes", "note", "hidestop", "unblock"]) expect(confirmation(name, "", "Анна", "Поддержка")).toBeNull();
  });

  it("every action with consequences asks, saying what changes for whom", () => {
    for (const name of ["stop", "block", "gift", "resetkey", "revokelink", "resetdevices", "resolvepanel", "closeall"]) {
      const ask = confirmation(name, name === "gift" ? "30" : name === "resolvepanel" ? "u applied" : "", "Анна", "Поддержка");
      expect(ask, name).not.toBeNull();
      expect(ask!.description).not.toMatch(/уверены/i);
    }
    const gift = confirmation("gift", "30", "Анна Смирнова", "Поддержка")!;
    expect(gift.title).toBe("Продлить подписку?");
    expect(gift.description).toContain("«Анна Смирнова»");
    expect(gift.description).toContain("на 30 дней");
    expect(gift.confirmLabel).toBe("Продлить на 30 дней");
    expect(confirmation("gift", "1", "", "")!.confirmLabel).toBe("Продлить на 1 день");
    expect(confirmation("gift", "22", "", "")!.confirmLabel).toBe("Продлить на 22 дня");
    expect(confirmation("gift", "11", "", "")!.confirmLabel).toBe("Продлить на 11 дней");
    expect(confirmation("revokelink", "", "Анна", "")!.description).toContain("Прежняя ссылка подписки клиента «Анна» станет недействительной");
    expect(confirmation("block", "", "Анна", "")!.danger).toBe(true);
    const all = confirmation("closeall", "", "Анна", "Поддержка")!;
    expect(all.description).toContain("проекта «Поддержка»");
    expect(all.description).toContain("без уведомления");
    expect(all.typeToConfirm).toBe("Поддержка");
  });
});

it("a short single line fits a notice; anything longer is read in full", () => {
  expect(fitsNotice("Заметка добавлена.")).toBe(true);
  expect(fitsNotice("Строка\nещё")).toBe(false);
  expect(fitsNotice("x".repeat(121))).toBe(false);
});

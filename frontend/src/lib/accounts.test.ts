import { describe, expect, it } from "vitest";
import { loginProblem, nameProblem, passwordProblem, telegramId, telegramIdProblem } from "./accounts";

describe("account rules", () => {
  it("accepts the logins the server normalizes and accepts", () => {
    for (const login of ["anna", " Anna.Smirnova ", "op_1", "a-b"]) expect(loginProblem(login)).toBe("");
    for (const login of ["ab", ".anna", "анна", "with space", "x".repeat(65)]) expect(loginProblem(login)).not.toBe("");
  });

  it("counts characters as the server does, not UTF-16 units", () => {
    expect(passwordProblem("😀".repeat(11))).not.toBe("");
    expect(passwordProblem("😀".repeat(12))).toBe("");
    expect(passwordProblem("p".repeat(129))).not.toBe("");
    expect(nameProblem("   ")).not.toBe("");
    expect(nameProblem("Я".repeat(100))).toBe("");
  });

  it("allows an empty Telegram ID and refuses anything but a positive integer within the server's range", () => {
    expect(telegramIdProblem("")).toBe("");
    expect(telegramIdProblem(" 123 ")).toBe("");
    for (const value of ["0", "-5", "1.5", "12ab", String(2 ** 52)]) expect(telegramIdProblem(value)).not.toBe("");
    expect([telegramId(""), telegramId(" 42 ")]).toEqual([null, 42]);
  });
});

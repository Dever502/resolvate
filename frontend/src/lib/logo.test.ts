import { describe, expect, it } from "vitest";
import { MAX_LOGO_BYTES, fileSize, logoProblem } from "./logo";

const file = (type: string, size: number) => new File([new Uint8Array(size)], "logo", { type });

describe("project logo files", () => {
  it("takes PNG, JPEG and WebP up to 2 MiB, as the server does, with the server's words", () => {
    for (const type of ["image/png", "image/jpeg", "image/webp"]) expect(logoProblem(file(type, 10))).toBe("");
    expect(logoProblem(file("image/png", MAX_LOGO_BYTES))).toBe("");
    for (const type of ["image/svg+xml", "image/gif", "", "application/octet-stream"]) {
      expect(logoProblem(file(type, 10))).toBe("Логотип: PNG, JPEG или WebP до 2 МБ.");
    }
    expect(logoProblem(file("image/png", 0))).toBe("Логотип пустой или больше 2 МБ.");
    expect(logoProblem(file("image/png", MAX_LOGO_BYTES + 1))).toBe("Логотип пустой или больше 2 МБ.");
  });

  it("shows sizes in Russian units", () => {
    expect([fileSize(512), fileSize(1536), fileSize(MAX_LOGO_BYTES)]).toEqual(["512 Б", "1,5 КБ", "2 МБ"]);
  });
});

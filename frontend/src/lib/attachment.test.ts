import { describe, expect, it } from "vitest";
import {
  FILE_EMPTY, FILE_TOO_LARGE, FILE_UNSUPPORTED, MAX_FILE_BYTES, MAX_TEXT, MAX_TEXT_WITH_FILE, attachmentKind, fileProblem,
  textLength, textProblem,
} from "./attachment";

// The browser's checks against the server's own rules (src/resolvate/console.py, media_storage.py).
const sized = (name: string, type: string, size: number): File => {
  const file = new File(["x"], name, { type });
  Object.defineProperty(file, "size", { value: size });
  return file;
};

describe("reply text", () => {
  it("counts like the server: code points after Python's strip()", () => {
    expect(textLength("  Привет\n")).toBe(6);
    // Emoji are one code point each, or several: a skin tone, a family, a flag.
    expect(textLength("👍")).toBe(1);
    expect(textLength("👍🏽")).toBe(2);
    expect(textLength("👨‍👩‍👧")).toBe(5);
    expect(textLength("🇷🇺")).toBe(2);
    expect(textLength("é")).toBe(2);
    // Python strips U+001C–U+001F and U+0085 at the edges, keeps U+FEFF; JavaScript's trim() does the opposite.
    expect(textLength("\x1c\x85 текст 　")).toBe(5);
    expect(textLength("﻿текст")).toBe(6);
    expect(textLength(" \t\n")).toBe(0);
  });

  it("takes 3900 without a file and 800 with one, inside the edges' whitespace", () => {
    const file = new File(["%PDF"], "a.pdf", { type: "application/pdf" });
    expect(textProblem("я".repeat(MAX_TEXT), null)).toBeNull();
    expect(textProblem("я".repeat(MAX_TEXT + 1), null)).toBe("Можно отправить не больше 3900 символов: сократите текст. Сейчас 3901.");
    expect(textProblem(`  ${"я".repeat(MAX_TEXT)}  `, null)).toBeNull();
    expect(textProblem("я".repeat(MAX_TEXT_WITH_FILE), file)).toBeNull();
    expect(textProblem("я".repeat(MAX_TEXT_WITH_FILE + 1), file))
      .toBe("С вложением можно отправить не больше 800 символов: сократите текст или уберите вложение. Сейчас 801.");
    // 800 emoji are 1600 UTF-16 units: still 800 for the server.
    expect(textProblem("😀".repeat(MAX_TEXT_WITH_FILE), file)).toBeNull();
    expect(textProblem("😀".repeat(MAX_TEXT_WITH_FILE + 1), file)).not.toBeNull();
    expect(textProblem("😀".repeat(MAX_TEXT), null)).toBeNull();
  });
});

describe("reply file", () => {
  it("takes the formats the server takes, by declared type or, without one, by extension", () => {
    for (const [name, type, kind] of [
      ["a.jpg", "image/jpeg", "image"], ["a.png", "image/png", "image"], ["a.webp", "image/webp", "image"],
      ["a.mp4", "video/mp4", "video"], ["a.mov", "video/quicktime", "video"], ["a.pdf", "application/pdf", "document"],
      ["a.ogg", "audio/ogg", "audio"], ["a.opus", "audio/opus", "audio"], ["a.ogg", "application/ogg", "audio"],
      ["voice.opus", "", "audio"], ["photo.JPEG", "application/octet-stream", "image"], ["scan.pdf", "", "document"],
    ] as const) {
      expect(attachmentKind({ name, type }), `${name} ${type}`).toBe(kind);
    }
    for (const [name, type] of [
      ["a.svg", "image/svg+xml"], ["a.gif", "image/gif"], ["a.txt", "text/plain"], ["a.jpg", "image/jpg"],
      ["a.ogg", "video/ogg"], ["a.webm", "video/webm"], ["notes", ""], ["archive.zip", "application/octet-stream"],
      [".jpg", ""], ["photo.jpg.exe", ""],
    ] as const) {
      expect(attachmentKind({ name, type }), `${name} ${type}`).toBeNull();
    }
  });

  it("refuses an unsupported format first, then an empty file, then one over 20 MiB", () => {
    expect(fileProblem(sized("a.pdf", "application/pdf", 1))).toBeNull();
    expect(fileProblem(sized("a.pdf", "application/pdf", MAX_FILE_BYTES - 1))).toBeNull();
    expect(fileProblem(sized("a.pdf", "application/pdf", MAX_FILE_BYTES))).toBeNull();
    expect(fileProblem(sized("a.pdf", "application/pdf", MAX_FILE_BYTES + 1))).toBe(FILE_TOO_LARGE);
    expect(fileProblem(sized("a.pdf", "application/pdf", 0))).toBe(FILE_EMPTY);
    expect(fileProblem(sized("a.txt", "text/plain", MAX_FILE_BYTES + 1))).toBe(FILE_UNSUPPORTED);
    expect(fileProblem(sized("a.txt", "text/plain", 0))).toBe(FILE_UNSUPPORTED);
  });
});

// What the server takes in one reply (src/resolvate/console.py send, media_storage.py), checked in the
// browser first: a reply that cannot go is said before it is sent. One place for the file picker, the
// attachment preview, the send, a dropped and a pasted file. The server still checks the file's
// content: an extension or a MIME type proves nothing about it.

export const MAX_TEXT = 3900;
export const MAX_TEXT_WITH_FILE = 800;
export const MAX_FILE_BYTES = 20 * 1024 * 1024;
/**
 * Files one reply of the operator may take. The console's own limit: the server takes one file per
 * request, and the files of a reply go one after another, each a message of its own (stores/chat.ts).
 */
export const MAX_FILES = 5;

export const FILE_TOO_LARGE = "Файл больше 20 МБ.";
export const FILE_EMPTY = "Файл пустой. Прикрепите другой файл.";
export const FILE_UNSUPPORTED =
  "Этот формат не поддерживается. Можно прикрепить фото JPEG, PNG или WebP, видео MP4 или MOV, PDF или голосовое OGG/Opus.";
export const FILES_LIMIT = `К одному ответу можно прикрепить не больше ${MAX_FILES} файлов.`;
/** Why a file was not taken, said next to its name when several are listed. */
const SHORT: Readonly<Record<string, string>> = {
  [FILE_TOO_LARGE]: "больше 20 МБ",
  [FILE_EMPTY]: "файл пустой",
  [FILE_UNSUPPORTED]: "формат не поддерживается",
  [FILES_LIMIT]: `в ответе уже ${MAX_FILES} файлов`,
};

export type AttachmentKind = "image" | "video" | "document" | "audio";
/** Where a file of a reply is in its send: on its way, waiting for the files before it, or its outcome unknown. */
export type AttachmentStatus = "sending" | "waiting" | "unknown" | null;

/**
 * Types a browser may declare for a supported file. The server compares the declared type with the
 * content: other names for the same content (image/jpg, video/ogg) are refused there, so here too.
 * "application/ogg" and "audio/opus" are the server's own aliases for Ogg audio.
 */
const TYPES: Readonly<Record<string, AttachmentKind>> = {
  "image/jpeg": "image", "image/png": "image", "image/webp": "image",
  "video/mp4": "video", "video/quicktime": "video",
  "application/pdf": "document",
  "audio/ogg": "audio", "audio/opus": "audio", "application/ogg": "audio",
};
/** Without a declared type (some pickers leave it empty, notably for .opus) the extension decides. */
const EXTENSIONS: Readonly<Record<string, AttachmentKind>> = {
  jpg: "image", jpeg: "image", png: "image", webp: "image",
  mp4: "video", mov: "video", pdf: "document", ogg: "audio", opus: "audio",
};

/** What the file is taken for, or null when it is not a supported format. */
export function attachmentKind(file: Pick<File, "name" | "type">): AttachmentKind | null {
  const type = file.type.toLowerCase();
  if (type && type !== "application/octet-stream") return TYPES[type] ?? null;
  const dot = file.name.lastIndexOf(".");
  return dot > 0 ? EXTENSIONS[file.name.slice(dot + 1).toLowerCase()] ?? null : null;
}

/** Why the file cannot be attached, or null. */
export function fileProblem(file: File): string | null {
  if (!attachmentKind(file)) return FILE_UNSUPPORTED;
  if (file.size === 0) return FILE_EMPTY;
  if (file.size > MAX_FILE_BYTES) return FILE_TOO_LARGE;
  return null;
}

/** A file's name in a sentence: a very long one is shortened. */
export function quoted(name: string): string {
  const chars = [...name];
  return `«${chars.length > 60 ? `${chars.slice(0, 59).join("")}…` : name}»`;
}

/**
 * What to say about the files of one pick, drop or paste that were not attached (`problem` from
 * fileProblem() or FILES_LIMIT), or "" when all were. One file alone is said as before; several, and
 * any file over the limit, are named with their reasons.
 */
export function refusal(refused: { name: string; problem: string }[], offered: number): string {
  if (!refused.length) return "";
  const [first] = refused;
  if (refused.length === 1 && offered === 1 && first!.problem !== FILES_LIMIT) return first!.problem;
  const limit = refused.some((item) => item.problem === FILES_LIMIT) ? ` ${FILES_LIMIT}` : "";
  if (refused.length === 1) return `Файл ${quoted(first!.name)} не прикреплён: ${SHORT[first!.problem] ?? first!.problem}.${limit}`;
  return `Не прикреплены: ${refused.map((item) => `${quoted(item.name)} — ${SHORT[item.problem] ?? item.problem}`).join("; ")}.${limit}`;
}

const PASTED_TYPES: Readonly<Record<string, string>> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };

/**
 * A file pasted from the clipboard, with a name an operator can tell apart: a screenshot comes without
 * one, or as the browser's generic "image.png". Its type and bytes stay as they are; a name it has of
 * its own (a copied file) stays too. `index` tells apart several pasted at once.
 */
export function pastedFile(file: File, at: Date, index = 0): File {
  const extension = PASTED_TYPES[file.type.toLowerCase()];
  if (!extension || (file.name && !/^image\.(png|jpe?g|webp)$/i.test(file.name))) return file;
  const pad = (value: number) => String(value).padStart(2, "0");
  const stamp = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}-${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`;
  return new File([file], `clipboard-${stamp}${index ? `-${index + 1}` : ""}.${extension}`, {
    type: file.type, lastModified: file.lastModified || at.getTime(),
  });
}

// Python's str.strip() with no arguments: the characters str.isspace() accepts. JavaScript's trim()
// differs at the edges (it strips U+FEFF and keeps U+001C–U+001F and U+0085).
const SPACE = "\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const EDGES = new RegExp(`^[${SPACE}]+|[${SPACE}]+$`, "g");

/** The length of a reply's text as the server counts it: code points after strip(). */
export function textLength(text: string): number {
  return [...text.replace(EDGES, "")].length;
}

/** The longest text that goes with a file (the caption of a reply's first file), or without one. */
export function textLimit(file: unknown): number {
  return file ? MAX_TEXT_WITH_FILE : MAX_TEXT;
}

/** What to say about a text over the limit; the count is shown apart. */
export function tooLong(file: unknown): string {
  return file
    ? `С вложением можно отправить не больше ${MAX_TEXT_WITH_FILE} символов: сократите текст или уберите вложение.`
    : `Можно отправить не больше ${MAX_TEXT} символов: сократите текст.`;
}

/** Why the text cannot go with this file (or without one), with its length, or null. */
export function textProblem(text: string, file: unknown): string | null {
  const length = textLength(text);
  return length > textLimit(file) ? `${tooLong(file)} Сейчас ${length}.` : null;
}

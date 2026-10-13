// What the server takes in one reply (src/resolvate/console.py send, media_storage.py), checked in the
// browser first: a reply that cannot go is said before it is sent. One place for the file picker, the
// attachment preview, the send and, later, a dropped file. The server still checks the file's content:
// an extension or a MIME type proves nothing about it.

export const MAX_TEXT = 3900;
export const MAX_TEXT_WITH_FILE = 800;
export const MAX_FILE_BYTES = 20 * 1024 * 1024;

export const FILE_TOO_LARGE = "Файл больше 20 МБ.";
export const FILE_EMPTY = "Файл пустой. Прикрепите другой файл.";
export const FILE_UNSUPPORTED =
  "Этот формат не поддерживается. Можно прикрепить фото JPEG, PNG или WebP, видео MP4 или MOV, PDF или голосовое OGG/Opus.";

export type AttachmentKind = "image" | "video" | "document" | "audio";

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

// Python's str.strip() with no arguments: the characters str.isspace() accepts. JavaScript's trim()
// differs at the edges (it strips U+FEFF and keeps U+001C–U+001F and U+0085).
const SPACE = "\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const EDGES = new RegExp(`^[${SPACE}]+|[${SPACE}]+$`, "g");

/** The length of a reply's text as the server counts it: code points after strip(). */
export function textLength(text: string): number {
  return [...text.replace(EDGES, "")].length;
}

/** The longest text that goes with a file, or without one. */
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

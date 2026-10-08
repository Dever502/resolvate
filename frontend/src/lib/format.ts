// Display helpers shared by the ticket list and the dialogue (same output as the classic console).

export type AvatarTone = "sage" | "clay" | "slate" | "sand";

/** A stable colour for a ticket's avatar: a visual cue only, not a status or a permission. */
export function avatarTone(identity: string): AvatarTone {
  let hash = 0;
  for (const char of identity) hash = (hash * 31 + char.codePointAt(0)!) >>> 0;
  return (["sage", "clay", "slate", "sand"] as const)[hash % 4]!;
}

/** "14:05" today, "3 окт." on other days. */
export function listTime(value: string, now = new Date()): string {
  const date = new Date(value);
  return date.toDateString() === now.toDateString()
    ? date.toLocaleTimeString("ru", { hour: "2-digit", minute: "2-digit" })
    : date.toLocaleDateString("ru", { day: "numeric", month: "short" });
}

/** "3 окт., 14:05" for message headers. */
export function messageTime(value: string): string {
  return new Date(value).toLocaleString("ru", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

export function channelName(channel: string | undefined | null): string {
  return channel === "telegram" ? "Telegram" : "Сайт · API";
}

/** "report.pdf · 1.4 МБ" for a file waiting in the composer. */
export function fileLabel(file: { name: string; size: number }): string {
  return `${file.name} · ${(file.size / 1024 / 1024).toFixed(1)} МБ`;
}

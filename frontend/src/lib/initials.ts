/** Up to two initials, as in the classic console (letters and digits of the first two words). */
export function initials(name: string | null | undefined): string {
  return (String(name || "").match(/[\p{L}\p{N}][\p{L}\p{M}\p{N}]*/gu) || ["?"])
    .slice(0, 2)
    .map((part) => [...part][0] || "")
    .join("")
    .toLocaleUpperCase("ru");
}

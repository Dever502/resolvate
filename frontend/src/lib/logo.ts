// Project logos (src/resolvate/project_branding.py): PNG, JPEG or WebP up to 2 MiB; the server checks
// the bytes again and stores a metadata-free PNG of at most 512×512. The texts are the server's own.
export const MAX_LOGO_BYTES = 2 * 1024 * 1024;
export const LOGO_TYPES = ["image/png", "image/jpeg", "image/webp"];

export function logoProblem(file: File): string {
  if (!LOGO_TYPES.includes(file.type)) return "Логотип: PNG, JPEG или WebP до 2 МБ.";
  if (!file.size || file.size > MAX_LOGO_BYTES) return "Логотип пустой или больше 2 МБ.";
  return "";
}

export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} Б`;
  const unit = bytes < 1024 ** 2 ? "КБ" : "МБ";
  return `${(bytes / (unit === "КБ" ? 1024 : 1024 ** 2)).toLocaleString("ru", { maximumFractionDigits: 1 })} ${unit}`;
}

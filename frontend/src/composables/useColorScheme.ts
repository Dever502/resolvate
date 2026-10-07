import { onScopeDispose, watchEffect } from "vue";
import { THEME_KEY, useThemeStore } from "../stores/theme";

/**
 * Browser side of the theme: follows the system scheme and other tabs, and keeps
 * <html data-theme> in sync. The first value is set by the boot script before the first paint.
 */
export function useColorScheme(): void {
  const theme = useThemeStore();
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const followSystem = (): void => {
    theme.systemDark = media.matches;
  };
  const followOtherTabs = (event: StorageEvent): void => {
    if (event.key === THEME_KEY || event.key === null) theme.adopt(event.key === null ? null : event.newValue);
  };
  followSystem();
  media.addEventListener("change", followSystem);
  window.addEventListener("storage", followOtherTabs);
  watchEffect(() => {
    document.documentElement.dataset.theme = theme.resolved;
  });
  onScopeDispose(() => {
    media.removeEventListener("change", followSystem);
    window.removeEventListener("storage", followOtherTabs);
  });
}

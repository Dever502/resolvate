import { onScopeDispose, ref, type Ref } from "vue";

/** The narrow screens' layout, as app.css declares it (@custom-variant narrow). */
export const NARROW_QUERY = "(max-width: 700px)";

/**
 * True while the window is narrow, following resizes. For parts that exist in one layout only (the
 * narrow app bar's drawer, the wide list's account footer): one account menu in the page, not a hidden
 * second one.
 */
export function useNarrowScreen(): Readonly<Ref<boolean>> {
  const query = typeof matchMedia === "function" ? matchMedia(NARROW_QUERY) : null;
  const narrow = ref(query?.matches ?? false);
  const follow = (event: MediaQueryListEvent): void => {
    narrow.value = event.matches;
  };
  query?.addEventListener("change", follow);
  onScopeDispose(() => query?.removeEventListener("change", follow));
  return narrow;
}

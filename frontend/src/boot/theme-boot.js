"use strict";

// Runs before the first paint: applies the saved theme to the whole page (sign-in included).
// Switching, system changes and other tabs are handled by the app's theme store.
(() => {
  let preference = null;
  try {
    preference = localStorage.getItem("resolvate.theme");
  } catch {
    // Storage may be unavailable in private or restricted browser contexts.
  }
  const dark = preference === "dark" ||
    (preference !== "light" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
})();

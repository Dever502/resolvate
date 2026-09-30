"use strict";

// Login is always light; the saved preference applies only to the workspace.
(() => {
  const key = "resolvate.theme";
  const system = window.matchMedia("(prefers-color-scheme: dark)");
  const normalize = value => ["light", "dark"].includes(value) ? value : "system";
  let preference = "system";
  try { preference = normalize(localStorage.getItem(key)); } catch { /* Optional storage. */ }

  function apply() {
    const workspace = document.getElementById("workspace");
    const chosen = preference === "system" ? (system.matches ? "dark" : "light") : preference;
    document.documentElement.dataset.theme = workspace && !workspace.hidden ? chosen : "light";
    for (const button of document.querySelectorAll("[data-theme-toggle]")) {
      const label = document.documentElement.dataset.theme === "dark"
        ? "Включить светлую тему" : "Включить тёмную тему";
      button.setAttribute("aria-label", label);
      button.title = label;
    }
  }
  apply();
  system.addEventListener("change", apply);
  window.addEventListener("storage", event => {
    if (event.key !== key && event.key !== null) return;
    preference = normalize(event.newValue);
    apply();
  });
  document.addEventListener("DOMContentLoaded", () => {
    new MutationObserver(apply).observe(document.getElementById("workspace"), {
      attributes: true, attributeFilter: ["hidden"],
    });
    for (const button of document.querySelectorAll("[data-theme-toggle]")) {
      button.addEventListener("click", () => {
        preference = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
        apply();
        try {
          localStorage.setItem(key, preference);
        } catch { /* Keep the selected theme for this page even without storage. */ }
      });
    }
    apply();
  });
})();

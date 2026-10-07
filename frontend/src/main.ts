// Entry: stylesheet and the session check only. Nothing else is imported statically, so the
// check starts as soon as this small script runs instead of after the application code loads.
import "./styles/app.css";

// The session store bounds the check with a deadline and aborts a stalled one through `controller`.
const controller = new AbortController();
const session = fetch("/console/me", {
  credentials: "same-origin",
  headers: { Accept: "application/json" },
  signal: controller.signal,
});
session.catch(() => undefined); // Handled by the session store once the application has loaded.

function showLoadError(): void {
  const message = document.createElement("p");
  message.className = "error px-6";
  message.setAttribute("role", "alert");
  message.textContent = "Не удалось загрузить панель. Обновите страницу.";
  const reload = document.createElement("button");
  reload.type = "button";
  reload.className = "primary mx-6";
  reload.textContent = "Обновить страницу";
  reload.addEventListener("click", () => location.reload());
  document.getElementById("app")?.replaceChildren(message, reload);
}

// After a deploy an open tab may request chunks that no longer exist.
window.addEventListener("vite:preloadError", (event) => {
  event.preventDefault();
  showLoadError();
});

import("./app").then(({ start }) => start(session, controller), showLoadError);

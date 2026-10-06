"use strict";

const $ = (id) => document.getElementById(id);

// A browser-local layout preference, independent of accounts and project data.
(() => {
  const root = document.documentElement;
  const handle = $("sidebar-resizer");
  const storageKey = "resolvate.sidebar-width";
  let preferred = null;
  let drag = null;
  try {
    const saved = Number(localStorage.getItem(storageKey));
    if (Number.isFinite(saved) && saved > 0) preferred = saved;
  } catch { /* Storage may be unavailable in private/restricted browser contexts. */ }

  function limits() {
    const style = getComputedStyle(root);
    const min = parseFloat(style.getPropertyValue("--sidebar-width")) * parseFloat(style.fontSize);
    return {min, max: Math.max(min, root.clientWidth / 3)};
  }
  function render() {
    const {min, max} = limits();
    const width = Math.min(max, Math.max(min, preferred ?? min));
    root.style.setProperty("--sidebar-preferred-width", `${width}px`);
    handle.setAttribute("aria-valuemin", String(Math.round(min)));
    handle.setAttribute("aria-valuemax", String(Math.round(max)));
    handle.setAttribute("aria-valuenow", String(Math.round(width)));
    handle.setAttribute("aria-valuetext", `${Math.round(width)} пикселей`);
    const disabled = root.clientWidth <= 700 || max <= min;
    handle.setAttribute("aria-disabled", String(disabled));
    handle.tabIndex = disabled ? -1 : 0;
  }
  function save() {
    try {
      if (preferred === null) localStorage.removeItem(storageKey);
      else localStorage.setItem(storageKey, String(preferred));
    } catch { /* Resizing still works without persistence. */ }
  }
  function setWidth(width) {
    const {min, max} = limits();
    preferred = Math.min(max, Math.max(min, width));
    render();
  }
  function finish(event) {
    if (!drag || (event && event.pointerId !== drag.id)) return;
    const id = drag.id;
    drag = null;
    root.classList.remove("resizing-sidebar");
    if (handle.hasPointerCapture(id)) handle.releasePointerCapture(id);
    save();
  }
  handle.addEventListener("pointerdown", event => {
    if (!event.isPrimary || event.button !== 0 || handle.getAttribute("aria-disabled") === "true") return;
    event.preventDefault();
    handle.focus({preventScroll: true});
    drag = {id: event.pointerId, x: event.clientX, width: $("ticket-sidebar").getBoundingClientRect().width};
    handle.setPointerCapture(event.pointerId);
    root.classList.add("resizing-sidebar");
  });
  handle.addEventListener("pointermove", event => {
    if (drag && event.pointerId === drag.id) setWidth(drag.width + event.clientX - drag.x);
  });
  for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) handle.addEventListener(type, finish);
  window.addEventListener("blur", () => finish());
  window.addEventListener("resize", () => { finish(); render(); });
  handle.addEventListener("keydown", event => {
    if (handle.getAttribute("aria-disabled") === "true") return;
    const {min, max} = limits();
    const width = $("ticket-sidebar").getBoundingClientRect().width;
    const step = event.shiftKey ? 40 : 10;
    const values = {ArrowLeft: width - step, ArrowRight: width + step, Home: min, End: max};
    if (!(event.key in values)) return;
    event.preventDefault();
    setWidth(values[event.key]);
    save();
  });
  handle.addEventListener("dblclick", () => { preferred = null; render(); save(); });
  render();
})();

const imageViewer = new ImageViewer();
let passwordTarget = null;
let passwordBusy = false;
const state = {
  account: null,
  project: null,
  projects: [],
  csrf: "",
  ticket: null,
  detail: null,
  archived: false,
  tickets: new Map(),
  messages: new Map(),
  drafts: new Map(),
  pages: 1,
  before: null,
  older: false,
  syncing: false,
  sending: false,
  replies: [],
  replyIndex: 0,
  epoch: 0,
  searchEpoch: 0,
  listEpoch: 0,
  loadingOlder: false,
  folders: [],
  folderFilter: "",
  folderRequest: 0,
  detailRequest: 0,
  folderMoveBusy: false,
  folderContext: 0,
  chatCache: new Map(),
  historyUpdatedAt: 0,
  opening: null,
  messageRequest: 0,
};

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}
// Local, decorative icons. No remote fonts, HTML interpolation or icon dependency.
const iconPaths = {
  resolve: "M6 20V5h6a5 5 0 0 1 0 10H6m6 0 6 5",
  search: "M10.5 17a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13Zm5-1 5 5",
  settings: "M4 7h7m4 0h5M4 17h3m4 0h9M11 4v6M7 14v6",
  folder: "M3 7V5h6l2 2h10v13H3Z",
  archive: "M3 3h18v5H3Zm2 5v13h14V8m-10 4h6",
  appearance: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 0v18m3-16v14m3-11v8",
  users: "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2m18 0v-2a4 4 0 0 0-3-3.87M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm7-7.87a4 4 0 0 1 0 7.75",
  lock: "M7 10V7a5 5 0 0 1 10 0v3M5 10h14v11H5Zm7 4v3",
  logout: "M9 4H4v16h5m5-13 5 5-5 5m-7-5h12",
  chat: "M5 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-6 4V6a2 2 0 0 1 2-2Zm2 5h10M7 13h6",
  back: "m14 6-6 6 6 6",
  info: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Zm0-11v6m0-10h.01",
  close: "m6 6 12 12M6 18 18 6",
  attach: "m8 13 6-6a3 3 0 0 1 4 4l-8 8a5 5 0 0 1-7-7l9-9a2 2 0 0 1 3 3l-9 9",
  send: "M12 20V4m-6 6 6-6 6 6",
  plus: "M12 5v14M5 12h14",
  minus: "M5 12h14",
  check: "m5 12 4 4L19 6",
  star: "m12 3 2.78 5.63L21 9.53l-4.5 4.39 1.06 6.2L12 17.2l-5.56 2.92 1.06-6.2L3 9.53l6.22-.9Z",
};
function icon(name, className = "") {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("class", `icon ${className}`.trim());
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  const path = document.createElementNS(svg.namespaceURI, "path");
  path.setAttribute("d", iconPaths[name]);
  svg.append(path);
  return svg;
}
for (const placeholder of document.querySelectorAll("[data-icon]")) {
  placeholder.replaceWith(icon(placeholder.dataset.icon, placeholder.className));
}
function initials(name) {
  return (String(name || "").match(/[\p{L}\p{N}][\p{L}\p{M}\p{N}]*/gu) || ["?"]).slice(0, 2)
    .map((part) => [...part][0] || "").join("").toLocaleUpperCase("ru");
}
function avatarTone(identity) {
  // A stable visual cue, not a status or a permission indicator.
  let hash = 0;
  for (const char of String(identity)) hash = (hash * 31 + char.codePointAt(0)) >>> 0;
  return ["sage", "clay", "slate", "sand"][hash % 4];
}
function resizeComposer() {
  const field = $("message-text");
  field.style.height = "auto";
  if (field.getClientRects().length) field.style.height = `${Math.min(160, field.scrollHeight)}px`;
}
function statusText(id, text, success = false) {
  $(id).textContent = text;
  $(id).classList.toggle("success", success);
}
function notice(text = "") {
  $("global-error").textContent = text;
  $("global-error").hidden = !text;
}
function fail(error) {
  notice(error.message || "Не удалось выполнить действие.");
}
async function api(path, { method = "GET", data, form, key, signal } = {}) {
  const scoped = /^(folders(?:\/|$)|tickets(?:\/|$)|media\/|retry\/|replies(?:\?|$))/.test(path);
  if (scoped) {
    if (!state.project) throw new Error("Выберите доступный проект.");
    path = `projects/${state.project}/${path}`;
  }
  const headers = {};
  if (method !== "GET") headers["X-CSRF-Token"] = state.csrf;
  if (data !== undefined) headers["Content-Type"] = "application/json";
  if (key) headers["X-Idempotency-Key"] = key;
  const response = await fetch(`/console/${path}`, {
    method,
    headers,
    credentials: "same-origin",
    signal,
    body: form || (data !== undefined ? JSON.stringify(data) : undefined),
  });
  let result;
  try {
    result = await response.json();
  } catch {
    result = {};
  }
  if (!response.ok) {
    if (response.status === 401 && path !== "login") showLogin();
    const error = new Error(
      typeof result.detail === "string"
        ? result.detail
        : "Запрос не выполнен. Повторите позже.",
    );
    error.status = response.status;
    throw error;
  }
  return result;
}
function known(map) {
  return Object.fromEntries(
    [...map].slice(-5000).map(([id, value]) => [id, value.revision]),
  );
}
function clock(value) {
  return new Date(value).toLocaleTimeString("ru", {
    hour: "2-digit",
    minute: "2-digit",
  });
}
function timeLabel(value) {
  const date = new Date(value);
  return date.toDateString() === new Date().toDateString()
    ? clock(value)
    : date.toLocaleDateString("ru", { day: "numeric", month: "short" });
}
function showLogin() {
  resetChatCache();
  state.epoch++;
  state.account = null;
  state.project = null;
  resetFolders();
  state.projects = [];
  state.csrf = "";
  state.ticket = null;
  state.drafts.clear();
  state.messages.clear();
  state.tickets.clear();
  $("accounts-dialog").close();
  $("projects-dialog").close();
  closePassword();
  imageViewer.close();
  $("workspace").hidden = true;
  $("login-screen").hidden = false;
  $("message-list").replaceChildren();
  $("ticket-list").replaceChildren();
  $("file").value = "";
  $("message-text").value = "";
  $("project-logo").hidden = true;
  $("project-logo").removeAttribute("src");
}
async function enter(result) {
  state.account = result.account;
  state.csrf = result.csrf;
  $("account-name").textContent = result.account.name;
  $("account-avatar").textContent = initials(result.account.name);
  $("account-role").textContent =
    result.account.role === "admin" ? "Администратор установки" : "Сотрудник";
  $("accounts-open").hidden = result.account.role !== "admin";
  $("login-screen").hidden = true;
  $("workspace").hidden = false;
  $("dialogue").hidden = true;
  $("empty").hidden = false;
  $("workspace").classList.remove("open-chat");
  await refreshProjects();
  const requested = new URLSearchParams(location.search);
  const projectId = requested.get("project"), ticketId = requested.get("ticket");
  if (projectId && ticketId) {
    const available = state.projects.find((item) => item.id === projectId && item.role && item.active);
    if (available) {
      selectProject(projectId);
      await syncTickets();
      await openTicket(ticketId);
    } else notice("Нет доступа к проекту из ссылки.");
  }
}
$("login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.submitter;
  button.disabled = true;
  $("login-error").textContent = "";
  try {
    const fields = Object.fromEntries(new FormData(event.target));
    const result = await api("login", { method: "POST", data: fields });
    event.target.reset();
    await enter(result);
  } catch (error) {
    statusText("login-error", error.message);
  } finally {
    button.disabled = false;
  }
});
$("logout").onclick = async () => {
  try {
    await api("logout", { method: "POST" });
    showLogin();
  } catch (error) {
    fail(error);
  }
};

function openPassword(account = null) {
  passwordTarget = account;
  $("password-form").reset();
  $("password-error").textContent = "";
  $("password-title").textContent = account ? `Сброс пароля: ${account.login}` : "Сменить пароль";
  $("password-description").textContent = account
    ? "Подтвердите своим паролем. Все сессии сотрудника будут завершены; его права не изменятся."
    : "После смены пароля потребуется войти заново на всех устройствах.";
  $("password-dialog").showModal();
}
$("password-open").onclick = () => openPassword();
function closePassword() {
  $("password-form").reset();
  passwordTarget = null;
  $("password-dialog").close();
}
$("password-close").onclick = () => { if (!passwordBusy) closePassword(); };
$("password-dialog").addEventListener("cancel", (event) => {
  if (passwordBusy) event.preventDefault();
});
$("password-dialog").addEventListener("close", () => {
  if ($("password-dialog").open) return;
  $("password-form").reset();
  passwordTarget = null;
});
$("password-form").onsubmit = async (event) => {
  event.preventDefault();
  const fields = Object.fromEntries(new FormData(event.target));
  if (fields.new_password !== fields.confirmation) {
    $("password-error").textContent = "Новые пароли не совпадают.";
    return;
  }
  const target = passwordTarget;
  const own = !target || target.id === state.account?.id;
  event.submitter.disabled = true;
  passwordBusy = true;
  $("password-error").textContent = "";
  try {
    await api(target ? `accounts/${target.id}/password` : "password", {
      method: "POST",
      data: {current_password: fields.current_password, new_password: fields.new_password},
    });
    closePassword();
    if (own) {
      showLogin();
      statusText("login-error", "Пароль изменён. Войдите с новым паролем.", true);
    } else {
      statusText("account-error", "Пароль сотрудника изменён. Старые сессии завершены.", true);
    }
  } catch (error) {
    $("password-error").textContent = error.message;
  } finally {
    passwordBusy = false;
    event.submitter.disabled = false;
  }
};

let folderEdit = null, folderDelete = null, folderBusy = false;

function resetFolderForm() {
  folderEdit = null;
  $("folder-form").reset();
  $("folder-form-label").textContent = "Новая папка";
  $("folder-save").textContent = "Создать";
  $("folder-cancel").hidden = true;
}
function resetFolders() {
  state.folderContext++;
  state.folders = [];
  state.folderFilter = "";
  state.folderRequest++;
  state.detailRequest++;
  state.folderMoveBusy = false;
  folderDelete = null;
  $("folders-dialog").close();
  $("folder-delete-dialog").close();
  resetFolderForm();
  $("folder-list").replaceChildren();
  $("folder-move-status").textContent = "";
  $("folder-error").textContent = "";
  renderFolderOptions();
  $("ticket-folder").disabled = true;
}
function fillFolderSelect(select, entries, selected) {
  const signature = JSON.stringify(entries);
  if (select.dataset.options !== signature) {
    select.replaceChildren(...entries.map(([value, name]) => {
      const option = node("option", "", name);
      option.value = value;
      return option;
    }));
    select.dataset.options = signature;
  }
  select.value = selected;
}
function renderFolderOptions() {
  renderFolderTabs();
  $("folders-open").disabled = !state.project;
  renderTicketFolder();
}
function renderFolderTabs() {
  const list = $("folder-tabs");
  const focused = list.contains(document.activeElement) ? document.activeElement : null;
  const previousSelection = list.querySelector('[aria-selected="true"]')?.dataset.folder;
  const existing = new Map([...list.children].map(button => [button.dataset.folder, button]));
  const entries = [["", "Все"], ...state.folders.map(f => [f.id, f.name])];
  const retainFocus = focused && entries.some(([id]) => id === focused.dataset.folder);
  let previous = null, selected;
  for (const [id, name] of entries) {
    let button = existing.get(id);
    if (!button) {
      button = node("button", "folder-tab");
      button.type = "button";
      button.dataset.folder = id;
      button.setAttribute("role", "tab");
      button.setAttribute("aria-controls", "ticket-list");
      button.onclick = () => {
        if (state.folderFilter === id) return;
        state.folderFilter = id;
        state.pages = 1;
        renderFolderTabs();
        syncTickets().catch(fail);
      };
    }
    existing.delete(id);
    if (button.textContent !== name) button.textContent = name;
    button.title = name;
    button.disabled = !state.project;
    const active = id === state.folderFilter;
    button.setAttribute("aria-selected", String(active));
    button.tabIndex = (retainFocus ? button === focused : active) ? 0 : -1;
    if (active) selected = button;
    const next = previous ? previous.nextSibling : list.firstChild;
    if (next !== button) list.insertBefore(button, next);
    previous = button;
  }
  for (const button of existing.values()) button.remove();
  // Polling must not rebuild focused tabs or reset a user's manual scroll position.
  if (retainFocus && document.activeElement !== focused) focused.focus({preventScroll: true});
  if (focused && !list.contains(focused)) selected?.focus({preventScroll: true});
  if (previousSelection !== state.folderFilter || (focused && !list.contains(focused))) {
    selected?.scrollIntoView({block: "nearest", inline: "nearest"});
  }
}
$("folder-tabs").addEventListener("keydown", event => {
  const buttons = [...$("folder-tabs").querySelectorAll("button:not(:disabled)")];
  const index = buttons.indexOf(document.activeElement);
  if (index < 0) return;
  let next;
  if (event.key === "ArrowRight") next = (index + 1) % buttons.length;
  else if (event.key === "ArrowLeft") next = (index - 1 + buttons.length) % buttons.length;
  else if (event.key === "Home") next = 0;
  else if (event.key === "End") next = buttons.length - 1;
  else return;
  event.preventDefault();
  buttons.forEach((button, index) => { button.tabIndex = index === next ? 0 : -1; });
  buttons[next].focus({preventScroll: true});
  buttons[next].scrollIntoView({block: "nearest", inline: "nearest"});
});
$("folder-tabs").addEventListener("focusout", event => {
  if (!$("folder-tabs").contains(event.relatedTarget)) {
    for (const button of $("folder-tabs").children) {
      button.tabIndex = button.getAttribute("aria-selected") === "true" ? 0 : -1;
    }
  }
});
$("folder-tabs").addEventListener("wheel", event => {
  const list = $("folder-tabs");
  if (event.ctrlKey || Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return;
  const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? list.clientWidth : 1;
  const next = Math.max(0, Math.min(list.scrollWidth - list.clientWidth, list.scrollLeft + event.deltaY * scale));
  if (next !== list.scrollLeft) {
    event.preventDefault();
    list.scrollLeft = next;
  }
}, {passive: false});
function renderTicketFolder() {
  if (state.folderMoveBusy) return;
  const entries = [["", "Без папки"], ...state.folders.map(f => [f.id, f.name])];
  const selected = state.detail?.folder_id || "";
  // A detail response can precede the next folder-list poll. Never display a false
  // "unfiled" assignment while the actual folder name is still being fetched.
  if (selected && !state.folders.some(f => f.id === selected)) entries.push([selected, "Папка…"]);
  fillFolderSelect($("ticket-folder"), entries, selected);
  $("ticket-folder").disabled = !state.detail || !state.ticket;
}
function renderFolderList() {
  if (!$("folders-dialog").open) return;
  const rows = state.folders.map(folder => {
    const row = node("div", "folder-row");
    const rename = node("button", "quiet", "Изменить");
    rename.type = "button";
    rename.setAttribute("aria-label", `Переименовать папку ${folder.name}`);
    rename.onclick = () => {
      if (folderBusy) return;
      folderEdit = {...folder};
      $("folder-name").value = folder.name;
      $("folder-form-label").textContent = "Название папки";
      $("folder-save").textContent = "Сохранить";
      $("folder-cancel").hidden = false;
      $("folder-error").textContent = "";
      $("folder-name").focus();
    };
    const remove = node("button", "quiet", "Удалить");
    remove.type = "button";
    remove.setAttribute("aria-label", `Удалить папку ${folder.name}`);
    remove.onclick = () => {
      if (folderBusy) return;
      folderDelete = {...folder};
      $("folder-delete-name").textContent = folder.name;
      $("folder-delete-dialog").showModal();
      $("folder-delete-cancel").focus();
    };
    row.append(node("strong", "", folder.name), rename, remove);
    return row;
  });
  $("folder-list").replaceChildren(...rows);
  if (!rows.length) $("folder-list").append(node("p", "muted", "Папок пока нет. Создайте первую ниже."));
}
async function refreshFolders() {
  if (!state.project) return;
  const project = state.project, request = ++state.folderRequest;
  const folders = await api("folders");
  if (project !== state.project || request !== state.folderRequest) return;
  const changed = JSON.stringify(folders) !== JSON.stringify(state.folders);
  state.folders = folders;
  if (state.folderFilter && !folders.some(f => f.id === state.folderFilter)) {
    state.folderFilter = "";
    state.pages = 1;
    notice("Папка удалена другим оператором. Показаны все диалоги.");
  }
  renderFolderOptions();
  if (changed) renderFolderList();
}
$("folders-open").onclick = async () => {
  resetFolderForm();
  $("folder-error").textContent = "";
  $("folders-dialog").showModal();
  renderFolderList();
  try { await refreshFolders(); } catch (error) { statusText("folder-error", error.message); }
};
$("folders-close").onclick = () => $("folders-dialog").close();
$("folder-cancel").onclick = resetFolderForm;
$("folder-delete-cancel").onclick = () => $("folder-delete-dialog").close();
async function changeFolder(perform, button, deletedId = null) {
  if (folderBusy) return;
  const project = state.project, context = state.folderContext;
  folderBusy = true;
  state.folderRequest++;
  button.disabled = true;
  $("folder-error").textContent = "";
  try {
    await perform();
    if (context !== state.folderContext) return;
    if (deletedId && state.folderFilter === deletedId) {
      state.folderFilter = "";
      state.pages = 1;
    }
    resetFolderForm();
    statusText("folder-error", "Изменения сохранены для всей команды.", true);
  } catch (error) {
    if (context !== state.folderContext) return;
    if (error.status === 409 || error.status === 404) resetFolderForm();
    statusText("folder-error", error.message);
  } finally {
    folderBusy = false;
    button.disabled = false;
    if (context === state.folderContext) {
      $("folder-delete-dialog").close();
      try {
        await refreshFolders();
        if (project === state.project) {
          renderFolderList();
          await syncTickets();
          if (state.ticket) await syncDetail(state.ticket, state.epoch);
        }
      } catch (error) { if (project === state.project) statusText("folder-error", error.message); }
    }
  }
}
$("folder-form").onsubmit = (event) => {
  event.preventDefault();
  const name = $("folder-name").value, editing = folderEdit;
  return changeFolder(() => api(editing ? `folders/${editing.id}/rename` : "folders", {
    method: "POST", data: editing ? {name, revision: editing.revision} : {name},
  }), event.submitter);
};
$("folder-delete-confirm").onclick = () => {
  const target = folderDelete;
  if (!target) return;
  return changeFolder(() => api(`folders/${target.id}/delete`, {
    method: "POST", data: {revision: target.revision},
  }), $("folder-delete-confirm"), target.id);
};
$("ticket-folder").onchange = async () => {
  if (!state.detail || state.folderMoveBusy) return;
  const project = state.project, ticket = state.ticket, epoch = state.epoch;
  const revision = state.detail.folder_revision, folder_id = $("ticket-folder").value || null;
  state.folderMoveBusy = true;
  state.detailRequest++;
  $("ticket-folder").disabled = true;
  $("folder-move-status").textContent = "Сохраняем…";
  try {
    await api(`tickets/${ticket}/folder`, {method: "POST", data: {folder_id, revision}});
    if (epoch === state.epoch) $("folder-move-status").textContent = "Сохранено для команды";
  } catch (error) {
    if (epoch === state.epoch) $("folder-move-status").textContent = error.message;
  } finally {
    if (epoch === state.epoch && project === state.project) {
      state.folderMoveBusy = false;
      try {
        await syncDetail(ticket, epoch);
        await syncTickets();
      } catch (error) { if (epoch === state.epoch) fail(error); }
      renderTicketFolder();
    }
  }
};

async function syncTickets() {
  if (!state.project) return;
  const project = state.project, account = state.account;
  await refreshFolders();
  if (project !== state.project || account !== state.account) return;
  const listEpoch = ++state.listEpoch;
  const epoch = state.epoch,
    query = $("search").value,
    archived = state.archived,
    folderFilter = state.folderFilter;
  const order = [];
  for (let page = 0; page < state.pages; page++) {
    const result = await api("tickets/sync", {
      method: "POST",
      data: {
        known: known(state.tickets),
        query,
        archived,
        offset: page * 50,
        folder_id: folderFilter || null,
      },
    });
    if (
      listEpoch !== state.listEpoch ||
      epoch !== state.epoch ||
      query !== $("search").value ||
      archived !== state.archived ||
      folderFilter !== state.folderFilter
    )
      return;
    for (const item of result.items) state.tickets.set(item.id, item);
    order.push(...result.order);
    $("more-tickets").hidden = result.order.length < 50;
  }
  const unique = [...new Set(order)];
  for (const id of state.tickets.keys())
    if (!unique.includes(id)) state.tickets.delete(id);
  const fragment = document.createDocumentFragment();
  const focusedTicket = $("ticket-list").contains(document.activeElement)
    ? document.activeElement.closest(".ticket")?.dataset.id : null;
  for (const id of unique) {
    const item = state.tickets.get(id),
      button = node(
        "button",
        "ticket" + (id === state.ticket ? " selected" : ""),
      );
    button.dataset.id = id;
    button.classList.toggle("unread", Boolean(item.unread));
    if (id === state.ticket) button.setAttribute("aria-current", "true");
    const avatar = node("span", `avatar ${avatarTone(id)}`, initials(item.name));
    avatar.setAttribute("aria-hidden", "true");
    const copy = node("div", "ticket-copy");
    const top = node("div", "ticket-top"),
      preview = node("div", "ticket-preview");
    top.append(
      node("span", "ticket-name", item.name),
      node("time", "ticket-time", timeLabel(item.time)),
    );
    preview.append(node("span", "", item.preview));
    if (item.unread)
      preview.append(
        node("span", "count", item.unread > 99 ? "99+" : item.unread),
      );
    copy.append(top, preview);
    button.append(avatar, copy);
    button.onclick = () => openTicket(id).catch(fail);
    fragment.append(button);
  }
  if (!unique.length)
    fragment.append(
      node(
        "p",
        "list-empty",
        query ? "Клиенты не найдены" : "Здесь пока нет диалогов",
      ),
    );
  $("ticket-list").replaceChildren(fragment);
  if (focusedTicket) {
    [...$("ticket-list").children].find((item) => item.dataset.id === focusedTicket)
      ?.focus({preventScroll: true});
  }
}
function draft() {
  if (!state.drafts.has(state.ticket))
    state.drafts.set(state.ticket, { text: "", file: null, key: null });
  return state.drafts.get(state.ticket);
}
function saveDraft() {
  if (state.ticket) draft().text = $("message-text").value;
}
function renderFile() {
  const file = state.ticket ? draft().file : null;
  $("attachment").hidden = !file;
  $("attachment-name").textContent = file
    ? `${file.name} · ${(file.size / 1024 / 1024).toFixed(1)} МБ`
    : "";
}
async function openTicket(id) {
  if (state.sending) return;
  saveDraft();
  rememberChat();
  state.opening?.abort();
  const controller = new AbortController();
  state.opening = controller;
  imageViewer.close();
  state.epoch++;
  state.ticket = id;
  state.detail = null;
  state.folderMoveBusy = false;
  $("folder-move-status").textContent = "";
  renderTicketFolder();
  const epoch = state.epoch;
  const cached = state.chatCache.get(id);
  const snapshot = cached && Date.now() - cached.updatedAt < 120000 ? cached : null;
  state.messages = new Map(snapshot?.messages);
  state.historyUpdatedAt = snapshot?.updatedAt || 0;
  state.before = snapshot?.before || null;
  state.older = snapshot?.older || false;
  state.loadingOlder = false;
  $("older").disabled = false;
  $("older").hidden = !state.older;
  $("message-list").replaceChildren();
  const preview = state.tickets.get(id);
  renderDetail(snapshot?.detail || {
    display_name: preview?.name, channel: preview?.channel, status: preview?.status,
  }, id);
  state.detail = null; // Cached metadata must not enable actions before authorization refresh.
  $("lifecycle").disabled = true;
  renderTicketFolder();
  renderMessages();
  $("messages").scrollTop = $("messages").scrollHeight;
  for (const button of $("ticket-list").querySelectorAll(".ticket")) {
    const selected = button.dataset.id === id;
    button.classList.toggle("selected", selected);
    if (selected) button.setAttribute("aria-current", "true");
    else button.removeAttribute("aria-current");
  }
  $("reply-options").hidden = true;
  $("customer-card").hidden = true;
  $("customer-open").setAttribute("aria-expanded", "false");
  $("message-text").value = draft().text;
  $("file").value = "";
  renderFile();
  $("dialogue").hidden = false;
  $("empty").hidden = true;
  $("workspace").classList.add("open-chat");
  resizeComposer();
  $("messages").scrollTop = $("messages").scrollHeight;
  $("message-text").focus({preventScroll: true});
  try {
    await Promise.all([
      syncDetail(id, epoch, controller.signal),
      syncMessages(true, false, controller.signal),
    ]);
  } catch (error) {
    if (epoch !== state.epoch || controller.signal.aborted) return;
    controller.abort();
    if ([401, 403, 404].includes(error.status)) {
      state.chatCache.delete(id);
      state.messages.clear();
      state.historyUpdatedAt = 0;
      state.detail = null;
      renderDetail({}, id);
      $("lifecycle").disabled = true;
      renderTicketFolder();
      $("message-list").replaceChildren();
    }
    throw error;
  } finally {
    if (state.opening === controller) state.opening = null;
  }
}
// In-memory only, scoped to the current account/project. Bound both age and size.
function resetChatCache() {
  state.opening?.abort();
  state.opening = null;
  state.chatCache.clear();
  state.historyUpdatedAt = 0;
}
function rememberChat() {
  if (!state.ticket) return;
  state.chatCache.delete(state.ticket);
  if (!state.historyUpdatedAt || state.messages.size > 200) return;
  state.chatCache.set(state.ticket, {
    messages: new Map(state.messages), detail: state.detail,
    before: state.before, older: state.older, updatedAt: state.historyUpdatedAt,
  });
  while (state.chatCache.size > 20) state.chatCache.delete(state.chatCache.keys().next().value);
}
async function syncDetail(id, epoch, signal) {
  const request = ++state.detailRequest;
  const detail = await api(`tickets/${id}`, {signal});
  if (signal?.aborted || epoch !== state.epoch || id !== state.ticket || request !== state.detailRequest) return;
  state.detail = detail;
  renderTicketFolder();
  renderDetail(detail, id);
  $("lifecycle").disabled = false;
}
function renderDetail(detail, id) {
  $("customer-name").textContent =
    detail.display_name || detail.username || "Клиент";
  $("customer-avatar").textContent = initials($("customer-name").textContent);
  $("customer-avatar").className = `avatar ${avatarTone(id)}`;
  $("customer-channel").textContent =
    detail.channel === "telegram" ? "Telegram" : "Сайт · API";
  const closed = detail.status === "closed";
  $("closed-label").hidden = !closed;
  $("lifecycle").textContent = closed ? "Возобновить" : "Завершить";
  const fields = [
    ["Имя", detail.display_name],
    ["Канал", detail.channel === "telegram" ? "Telegram" : "Сайт · API"],
    ["Username", detail.username],
    ["Email", detail.email],
    ["Идентификатор", detail.identity_value],
    ["Remnawave ID", detail.remnawave_user_uuid],
    ["Первое обращение", detail.created_at ? new Date(detail.created_at).toLocaleString("ru") : null],
  ];
  $("customer-fields").replaceChildren();
  for (const [key, value] of fields)
    if (value)
      $("customer-fields").append(node("dt", "", key), node("dd", "", value));
  for (const author of $("message-list").querySelectorAll("[data-customer-author]")) {
    author.textContent = $("customer-name").textContent;
  }
}
function renderMessage(item) {
  const outgoing = item.direction === "operator_to_user";
  const element = node(
    "article",
    "message" +
      (outgoing && !item.system ? " outgoing" : "") +
      (item.system ? " system" : item.channel === "internal_note" ? " internal" : ""),
  );
  element.dataset.id = item.id;
  element.dataset.revision = item.revision;
  const meta = node("div", "message-meta");
  meta.append(
    node(
      "span",
      "",
      item.system ? "Система" : outgoing ? item.author : $("customer-name").textContent || "Клиент",
    ),
    node(
      "time",
      "",
      new Date(item.time).toLocaleString("ru", {
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      }),
    ),
  );
  if (!outgoing && !item.system) meta.firstChild.dataset.customerAuthor = "";
  const bubble = node("div", "bubble");
  if (item.media_id) {
    const url = `/console/projects/${state.project}/media/${encodeURIComponent(item.media_id)}`;
    if (item.sticker) {
      element.classList.add("sticker-message");
      const sticker = document.createElement("resolvate-sticker");
      Object.assign(sticker, {
        src: url, mime: item.mime || "", emoji: item.sticker_emoji || "",
        openImage: (source) => imageViewer.open(source),
      });
      bubble.append(sticker);
    } else if (item.mime?.startsWith("image/")) {
      const image = node("img");
      image.src = url;
      image.alt = "Фото из переписки";
      image.loading = "lazy";
      image.onerror = () => {
        image.replaceWith(node("span", "muted", "Фото больше не доступно"));
      };
      const open = node("button", "image-preview");
      open.type = "button";
      open.setAttribute("aria-label", "Открыть изображение");
      open.onclick = () => imageViewer.open(url);
      open.append(image);
      bubble.append(open);
    } else if (item.mime?.startsWith("audio/")) {
      const audio = node("audio");
      audio.src = url;
      audio.controls = true;
      audio.preload = "metadata";
      audio.setAttribute("aria-label", "Голосовое сообщение");
      bubble.append(audio);
    } else if (item.mime?.startsWith("video/")) {
      const video = node("video");
      video.src = url;
      video.controls = true;
      video.preload = "metadata";
      bubble.append(video);
    } else {
      const link = node("a", "", "↓ Скачать PDF");
      link.href = url;
      bubble.append(link);
    }
  } else if (item.attachment)
    bubble.append(node("span", "muted", "Вложение недоступно в Web"));
  if (item.rating) {
    bubble.classList.add("rating-card");
    const data = item.rating;
    bubble.append(node("p", "rating-title", "Оценка поддержки"));
    const value = node("div", "rating-value"), stars = node("span", "rating-stars");
    stars.setAttribute("aria-hidden", "true");
    for (let index = 1; index <= 5; index++) stars.append(icon("star", index <= data.score ? "filled" : ""));
    const score = node("strong", "", `${data.score}/5`);
    score.setAttribute("aria-label", `Оценка: ${data.score} из 5`);
    value.append(stars, score);
    bubble.append(value, node("div", "rating-customer", data.display_name || data.username || "Клиент"));
    for (const [label, content] of [
      ["", data.username ? `@${data.username}` : null],
      ["Telegram ID: ", data.telegram_user_id],
      ["Email: ", data.email],
      ["ID клиента: ", data.telegram_user_id == null ? data.identity_value : null],
    ]) {
      if (content != null && content !== "") bubble.append(node("span", "rating-identity", label + content));
    }
  } else if (item.system && item.text === "✅ Обращение закрыто") {
    const event = node("span", "system-event");
    event.append(icon("check"), document.createTextNode("Обращение закрыто"));
    bubble.append(event);
  } else if (item.text) {
    bubble.append(document.createTextNode(item.text));
  }
  element.append(meta, bubble);
  if (item.failed?.length) {
    const error = node("div", "message-error", "Не удалось отправить ");
    const retry = node("button", "quiet", "Повторить");
    retry.onclick = async () => {
      retry.disabled = true;
      try {
        for (const id of item.failed)
          await api(`retry/${item.command}/${id}`, { method: "POST" });
        await syncMessages();
      } catch (err) {
        fail(err);
      } finally {
        retry.disabled = false;
      }
    };
    error.append(retry);
    element.append(error);
  }
  return element;
}
async function syncMessages(initial = false, older = false, signal) {
  const id = state.ticket,
    epoch = state.epoch;
  if (!id) return;
  const request = ++state.messageRequest;
  const hadHistory = Boolean(state.historyUpdatedAt);
  const result = await api(`tickets/${id}/sync`, {
    method: "POST",
    signal,
    data: {
      known: older ? {} : known(state.messages),
      before: older ? state.before : null,
    },
  });
  if (signal?.aborted || epoch !== state.epoch || id !== state.ticket || request !== state.messageRequest) return;
  const area = $("messages"),
    height = area.scrollHeight,
    top = area.scrollTop;
  const bottom = height - top - area.clientHeight < 100;
  if (result.reset) {
    state.messages.clear();
    initial = true;
  }
  for (const item of result.items) state.messages.set(item.id, item);
  if (!older)
    for (const removed of result.removed) state.messages.delete(removed);
  if (older || result.reset || (initial && !hadHistory)) {
    state.before = result.before;
    state.older = result.has_older;
  }
  $("older").hidden = !state.older;
  state.historyUpdatedAt = Date.now();
  const ordered = renderMessages();
  if (initial || (bottom && !older)) area.scrollTop = area.scrollHeight;
  else if (older) area.scrollTop = top + area.scrollHeight - height;
  if (ordered.some((item) => item.uncertain))
    notice(
      "Результат одной из отправок неизвестен. Проверьте Telegram перед повторной отправкой.",
    );
  if (
    ordered.length &&
    !document.hidden &&
    $("dialogue").getClientRects().length &&
    (bottom || initial) &&
    !older
  ) {
    // A receipt must not hold up rendering or start a full list/folder reload.
    api(`tickets/${id}/read/${ordered[ordered.length - 1].id}`, {
      method: "POST", signal,
    }).catch(error => {
      if (!signal?.aborted && epoch === state.epoch) fail(error);
    });
  }
}
function renderMessages() {
  const existing = new Map(
    [...$("message-list").children].map((element) => [
      element.dataset.id,
      element,
    ]),
  );
  const ordered = [...state.messages.values()].sort(
    (a, b) => a.time.localeCompare(b.time) || a.id.localeCompare(b.id),
  );
  const list = $("message-list");
  for (const [ident, element] of existing)
    if (!state.messages.has(ident)) element.remove();
  let previous = null;
  for (const item of ordered) {
    const old = existing.get(item.id);
    const element =
      old?.dataset.revision === item.revision ? old : renderMessage(item);
    if (old && old !== element) old.replaceWith(element);
    const next = previous ? previous.nextSibling : list.firstChild;
    if (next !== element) list.insertBefore(element, next);
    previous = element;
  }
  return ordered;
}
$("older").onclick = async () => {
  if (state.loadingOlder || state.syncing || state.opening) return;
  const epoch = state.epoch;
  state.loadingOlder = true;
  $("older").disabled = true;
  try {
    await syncMessages(false, true);
  } catch (error) {
    fail(error);
  } finally {
    if (epoch === state.epoch) {
      state.loadingOlder = false;
      $("older").disabled = false;
    }
  }
};
$("messages").addEventListener("scroll", () => {
  if ($("messages").scrollTop < 40 && state.older) $("older").click();
});
$("more-tickets").onclick = () => {
  state.pages++;
  syncTickets().catch(fail);
};
$("back").onclick = () => $("workspace").classList.remove("open-chat");
$("customer-open").onclick = () => {
  $("customer-card").hidden = !$("customer-card").hidden;
  $("customer-open").setAttribute("aria-expanded", String(!$("customer-card").hidden));
};
$("customer-close").onclick = () => {
  $("customer-card").hidden = true;
  $("customer-open").setAttribute("aria-expanded", "false");
  $("customer-open").focus();
};
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !document.querySelector("dialog[open]") && !$("customer-card").hidden) {
    $("customer-close").click();
  }
});
$("archive-toggle").onclick = () => {
  state.archived = !state.archived;
  state.pages = 1;
  $("inbox-title").textContent = state.archived ? "Архив" : "Диалоги";
  const button = $("archive-toggle");
  const label = state.archived ? "К активным диалогам" : "Открыть архив";
  button.setAttribute("aria-label", label);
  button.title = label;
  button.replaceChildren(icon(state.archived ? "back" : "archive"));
  syncTickets().catch(fail);
};
let searchTimer;
$("search").addEventListener("input", () => {
  clearTimeout(searchTimer);
  state.pages = 1;
  searchTimer = setTimeout(() => syncTickets().catch(fail), 250);
});
$("lifecycle").onclick = async () => {
  if (!state.detail) return;
  const button = $("lifecycle");
  button.disabled = true;
  try {
    await api(
      `tickets/${state.ticket}/${state.detail.status === "closed" ? "reopen" : "close"}`,
      { method: "POST" },
    );
    await syncDetail(state.ticket, state.epoch);
    await syncTickets();
  } catch (error) {
    fail(error);
  } finally {
    button.disabled = false;
  }
};
$("attach").onclick = () => $("file").click();
$("file").onchange = () => {
  const file = $("file").files[0];
  if (!file || !state.ticket) return;
  if (file.size > 20 * 1024 * 1024) {
    notice("Файл больше 20 МБ.");
    $("file").value = "";
    return;
  }
  draft().file = file;
  draft().key = null;
  renderFile();
};
$("remove-file").onclick = () => {
  draft().file = null;
  draft().key = null;
  $("file").value = "";
  renderFile();
};
$("composer").onsubmit = async (event) => {
  event.preventDefault();
  if (!state.ticket || state.sending) return;
  saveDraft();
  const item = draft(),
    id = state.ticket;
  if (!item.text.trim() && !item.file) return;
  item.key ||= crypto.randomUUID();
  const form = new FormData();
  form.set("text", item.text);
  if (item.file) form.set("file", item.file);
  state.sending = true;
  $("project-select").disabled = true;
  $("projects-open").disabled = true;
  $("send").disabled = true;
  $("message-text").disabled = true;
  $("attach").disabled = true;
  $("remove-file").disabled = true;
  try {
    await api(`tickets/${id}/send`, { method: "POST", form, key: item.key });
    state.drafts.delete(id);
    $("message-text").value = "";
    resizeComposer();
    $("file").value = "";
    renderFile();
    notice();
    await syncMessages();
    await syncTickets();
    await syncDetail(id, state.epoch);
  } catch (error) {
    fail(error);
  } finally {
    state.sending = false;
    $("project-select").disabled = false;
    $("projects-open").disabled = false;
    $("send").disabled = false;
    $("message-text").disabled = false;
    $("attach").disabled = false;
    $("remove-file").disabled = false;
    $("message-text").focus();
  }
};
function chooseReply(index) {
  const reply = state.replies[index];
  if (!reply) return;
  $("message-text").value = reply.text;
  resizeComposer();
  draft().key = null;
  saveDraft();
  $("reply-options").hidden = true;
  $("message-text").focus();
}
let replyTimer;
$("message-text").oninput = () => {
  resizeComposer();
  if (!state.ticket) return;
  draft().key = null;
  saveDraft();
  const text = $("message-text").value,
    sequence = ++state.searchEpoch;
  clearTimeout(replyTimer);
  $("reply-options").hidden = true;
  if (!/^\/[^\n]*$/.test(text)) return;
  replyTimer = setTimeout(async () => {
    try {
      const replies = await api(
        `replies?q=${encodeURIComponent(text.slice(1).slice(0, 100))}`,
      );
      if (sequence !== state.searchEpoch || $("message-text").value !== text)
        return;
      state.replies = replies;
      state.replyIndex = 0;
      $("reply-options").replaceChildren();
      replies.forEach((reply, index) => {
        const button = node("button", "reply-option", reply.text.slice(0, 240));
        button.type = "button";
        button.setAttribute("role", "option");
        button.onclick = () => chooseReply(index);
        button.classList.toggle("selected", index === 0);
        $("reply-options").append(button);
      });
      if (!replies.length)
        $("reply-options").append(
          node("p", "list-empty", "Готовые ответы не найдены"),
        );
      $("reply-options").hidden = false;
    } catch (error) {
      fail(error);
    }
  }, 180);
};
$("message-text").onkeydown = (event) => {
  if (event.isComposing) return;
  if (!$("reply-options").hidden) {
    if (event.key === "Escape") {
      event.preventDefault();
      $("reply-options").hidden = true;
      return;
    }
    if (["ArrowDown", "ArrowUp"].includes(event.key) && state.replies.length) {
      event.preventDefault();
      state.replyIndex =
        (state.replyIndex +
          (event.key === "ArrowDown" ? 1 : -1) +
          state.replies.length) %
        state.replies.length;
      [...$("reply-options").children].forEach((item, index) =>
        item.classList.toggle("selected", index === state.replyIndex),
      );
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      chooseReply(state.replyIndex);
      return;
    }
  }
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    $("composer").requestSubmit();
  }
};
async function refreshAccounts() {
  const accounts = await api("accounts");
  $("account-list").replaceChildren();
  for (const account of accounts) {
    const row = node("div", "account-row"),
      description = node("div");
    description.append(
      node("strong", "", account.name),
      node(
        "span",
        "small muted",
        `${account.login} · ${account.role === "admin" ? "Администратор" : "Оператор"}${account.active ? "" : " · отключён"}`,
      ),
    );
    const button = node(
      "button",
      "secondary",
      account.active ? "Отключить" : "Включить",
    );
    button.onclick = async () => {
      button.disabled = true;
      try {
        await api(
          `accounts/${account.id}/${account.active ? "disable" : "enable"}`,
          { method: "POST" },
        );
        await refreshAccounts();
      } catch (error) {
        statusText("account-error", error.message);
      } finally {
        button.disabled = false;
      }
    };
    const identity = node("form", "identity-form");
    const telegramId = node("input");
    telegramId.type = "number";
    telegramId.min = "1";
    telegramId.value = account.telegram_id || "";
    telegramId.placeholder = "Telegram ID";
    telegramId.setAttribute("aria-label", `Telegram ID: ${account.login}`);
    const save = node("button", "quiet", "Сохранить ID");
    save.type = "submit";
    identity.append(telegramId, save);
    identity.onsubmit = async (event) => {
      event.preventDefault();
      save.disabled = true;
      try {
        await api(`accounts/${account.id}/identity/telegram`, {method:"POST", data:{telegram_id:telegramId.value ? Number(telegramId.value) : null}});
        await refreshAccounts();
      } catch (error) { statusText("account-error", error.message); }
      finally { save.disabled = false; }
    };
    description.append(identity);
    const resetPassword = node("button", "secondary", "Сбросить пароль");
    resetPassword.onclick = () => openPassword(account);
    const actions = node("div", "row-actions");
    actions.append(resetPassword, button);
    row.append(description, actions);
    $("account-list").append(row);
  }
}
$("accounts-open").onclick = async () => {
  $("account-error").textContent = "";
  $("accounts-dialog").showModal();
  try {
    await refreshAccounts();
  } catch (error) {
    statusText("account-error", error.message);
  }
};
$("accounts-close").onclick = () => {
  $("account-form").reset();
  $("accounts-dialog").close();
};
$("account-form").onsubmit = async (event) => {
  event.preventDefault();
  event.submitter.disabled = true;
  $("account-error").textContent = "";
  try {
    const values = Object.fromEntries(new FormData(event.target));
    values.telegram_id = values.telegram_id ? Number(values.telegram_id) : null;
    await api("accounts", {
      method: "POST",
      data: values,
    });
    event.target.reset();
    await refreshAccounts();
  } catch (error) {
    statusText("account-error", error.message);
  } finally {
    event.submitter.disabled = false;
  }
};
function selectProject(id) {
  if (state.sending) return;
  resetChatCache();
  imageViewer.close();
  state.epoch++;
  state.listEpoch++;
  state.searchEpoch++;
  state.project = id || null;
  resetFolders();
  state.ticket = null;
  state.detail = null;
  state.pages = 1;
  state.before = null;
  state.older = false;
  state.replies = [];
  // Never carry drafts, attachments or cached results into a different project.
  state.drafts.clear();
  state.messages.clear();
  state.tickets.clear();
  $("ticket-list").replaceChildren();
  $("message-list").replaceChildren();
  $("message-text").value = "";
  $("file").value = "";
  $("search").value = "";
  $("customer-fields").replaceChildren();
  $("customer-card").hidden = true;
  $("customer-open").setAttribute("aria-expanded", "false");
  $("reply-options").hidden = true;
  $("attachment").hidden = true;
  $("dialogue").hidden = true;
  $("more-tickets").hidden = true;
  $("empty").hidden = false;
  $("workspace").classList.remove("open-chat");
  $("empty-title").textContent = id ? "Выберите диалог" : "Нет активного проекта";
  $("empty-description").textContent = id
    ? "Здесь появится история обращения."
    : "Откройте «Проекты» или попросите администратора выдать доступ.";
  $("project-select").value = id || "";
  renderProjectLogo();
  notice();
}
function logoSource(project) {
  return `/console/projects/${encodeURIComponent(project.id)}/logo?v=${encodeURIComponent(project.logo)}`;
}
function renderProjectLogo() {
  const project = state.projects.find((item) => item.id === state.project);
  $("project-initial").textContent = initials(project?.name || "R");
  const image = $("project-logo");
  image.hidden = !project?.logo;
  if (project?.logo) {
    const source = logoSource(project);
    if (image.getAttribute("src") !== source) image.src = source;
  }
  else image.removeAttribute("src");
  image.onerror = () => { image.hidden = true; };
}
async function refreshProjects(initial = true) {
  const account = state.account;
  const projects = await api("projects");
  if (state.account !== account) return;
  const changed = JSON.stringify(projects) !== JSON.stringify(state.projects);
  state.projects = projects;
  if (!changed && !initial) return;
  const available = projects.filter((project) => project.role && project.active);
  $("project-select").replaceChildren(node("option", "", "Выберите проект"));
  $("project-select").firstChild.value = "";
  for (const project of available) {
    const option = node("option", "", project.name);
    option.value = project.id;
    $("project-select").append(option);
  }
  const current = available.find((project) => project.id === state.project);
  if (!current) selectProject(initial ? available[0]?.id : null);
  else $("project-select").value = current.id;
  renderProjectLogo();
  if (initial) await syncTickets();
}
$("project-select").onchange = () => {
  selectProject($("project-select").value);
  syncTickets().catch(fail);
};

let managedProject = null;
let managementEpoch = 0;
const projectError = (error) => statusText("project-error", error.message);

async function renderProjects() {
  await refreshProjects(false);
  $("project-list").replaceChildren();
  const owner = state.account.role === "admin";
  $("project-create-form").hidden = !owner;
  $("project-create-section").hidden = !owner;
  for (const project of state.projects) {
    const row = node("div", "project-row");
    const description = node("div");
    description.append(node("strong", "", project.name), node("span", "muted small",
      `${project.active ? "Активен" : "Отключён"} · ${project.role === "admin" ? "Вы — администратор" : project.role ? "Вы — оператор" : "Доступ к перепискам не выдан"}`));
    row.append(description);
    const actions = node("div", "row-actions");
    if (project.role && project.active) {
      const open = node("button", "secondary", "Открыть");
      open.onclick = () => {
        selectProject(project.id);
        $("projects-dialog").close();
        syncTickets().catch(fail);
      };
      actions.append(open);
    }
    if (owner || project.role === "admin") {
      const manage = node("button", "quiet", "Настроить");
      manage.onclick = () => openManagement(project).catch(projectError);
      actions.append(manage);
    }
    if (owner) {
      const active = node("button", "quiet", project.active ? "Отключить" : "Включить");
      active.onclick = async () => {
        active.disabled = true;
        try {
          await api(`projects/${project.id}/active`, {method: "POST", data: {active: !project.active}});
          await renderProjects();
        } catch (error) { projectError(error); }
        finally { active.disabled = false; }
      };
      actions.append(active);
      if (!project.role) {
        const join = node("button", "quiet", "Выдать себе доступ");
        join.onclick = async () => {
          try {
            await api(`projects/${project.id}/members`, {method: "POST", data: {login: state.account.login}});
            await renderProjects();
          } catch (error) { projectError(error); }
        };
        actions.append(join);
      }
    }
    row.append(actions);
    $("project-list").append(row);
  }
  if (!state.projects.length) $("project-list").append(node("p", "muted", "Пока нет доступных проектов."));
}
async function openManagement(project) {
  managedProject = project;
  managementEpoch++;
  $("project-error").textContent = "";
  $("managed-project-name").textContent = project.name;
  $("project-management").hidden = false;
  $("projects-overview").hidden = true;
  $("projects-back").hidden = false;
  $("projects-title").textContent = "Настройки проекта";
  $("projects-dialog").querySelector(".preferences-body").scrollTop = 0;
  $("project-admin-form").hidden = state.account.role !== "admin";
  $("project-admin-section").hidden = state.account.role !== "admin";
  $("settings-tab").hidden = project.role !== "admin";
  $("branding-tab").hidden = project.role !== "admin";
  $("project-branding-form").reset();
  $("branding-status").textContent = "";
  $("project-settings-form").reset();
  $("project-setting-fields").replaceChildren();
  $("members-tab").click();
  $("members-tab").focus();
  await refreshMembers();
}
async function refreshMembers() {
  const id = managedProject.id, epoch = managementEpoch;
  const members = await api(`projects/${id}/members`);
  if (epoch !== managementEpoch) return;
  $("member-list").replaceChildren();
  for (const member of members) {
    const row = node("div", "account-row"), description = node("div");
    description.append(node("strong", "", member.name), node("span", "small muted",
      `${member.login} · ${member.role === "admin" ? "Администратор проекта" : "Оператор"}${member.active ? "" : " · аккаунт отключён"}`));
    row.append(description);
    if (member.role !== "admin") {
      const remove = node("button", "quiet", "Отозвать доступ");
      remove.onclick = async () => {
        remove.disabled = true;
        try {
          await api(`projects/${id}/members/remove`, {method: "POST", data: {login: member.login}});
          if (epoch === managementEpoch) await refreshMembers();
          await refreshProjects(false);
        } catch (error) { projectError(error); }
        finally { remove.disabled = false; }
      };
      row.append(remove);
    }
    $("member-list").append(row);
  }
}
function managementTab(tab) {
  $("members-section").hidden = tab !== "members";
  $("project-settings-form").hidden = tab !== "settings";
  $("project-branding-form").hidden = tab !== "branding";
  for (const [id, selected] of [["members-tab", tab === "members"], ["settings-tab", tab === "settings"], ["branding-tab", tab === "branding"]]) {
    $(id).classList.toggle("selected", selected);
    $(id).setAttribute("aria-pressed", String(selected));
  }
}
$("members-tab").onclick = () => managementTab("members");
function renderBranding() {
  const project = state.projects.find((item) => item.id === managedProject?.id);
  const image = $("branding-preview");
  image.hidden = !project?.logo;
  $("branding-remove").hidden = !project?.logo;
  if (project?.logo) {
    const source = logoSource(project);
    if (image.getAttribute("src") !== source) image.src = source;
  }
  else image.removeAttribute("src");
  image.onerror = () => { image.hidden = true; };
}
$("branding-tab").onclick = () => {
  if (!managedProject || managedProject.role !== "admin") return;
  renderBranding();
  managementTab("branding");
};
async function changeBranding(remove = false) {
  const id = managedProject.id, epoch = managementEpoch;
  const form = $("project-branding-form");
  const buttons = [...form.querySelectorAll("button")];
  buttons.forEach((button) => { button.disabled = true; });
  $("branding-status").textContent = "";
  try {
    if (remove) await api(`projects/${id}/logo/remove`, {method: "POST"});
    else {
      const file = $("branding-file").files[0];
      if (!file || file.size > 2 * 1024 * 1024) throw new Error("Выберите изображение до 2 МБ.");
      const upload = new FormData(); upload.set("file", file);
      await api(`projects/${id}/logo`, {method: "POST", form: upload});
    }
    await refreshProjects(false);
    if (epoch === managementEpoch) {
      form.reset(); renderBranding();
      $("branding-status").textContent = remove ? "Логотип удалён." : "Логотип сохранён.";
    }
  } catch (error) { if (epoch === managementEpoch) projectError(error); }
  finally { buttons.forEach((button) => { button.disabled = false; }); }
}
$("project-branding-form").onsubmit = (event) => { event.preventDefault(); changeBranding(); };
$("branding-remove").onclick = () => changeBranding(true);
const settingSections = [
  ["Telegram", [
    ["support_bot_token", "Токен бота", "password"],
    ["support_group_id", "ID группы поддержки", "number"],
  ]],
  ["API для вашего сайта", [
    ["web_api_enabled", "Принимать обращения через API", "checkbox"],
    ["web_api_token", "Ключ Web API", "password"],
    ["web_identity_mode", "Идентификация клиентов", "identity"],
    ["api_enabled", "Разрешить Operator API", "checkbox"],
    ["api_admin_token", "Ключ Operator API", "password"],
  ]],
  ["Remnawave", [
    ["remnawave_enabled", "Включить интеграцию", "checkbox"],
    ["remnawave_base_url", "Адрес API", "url"],
    ["remnawave_api_token", "Ключ интеграции", "password"],
  ]],
  ["Webhook", [
    ["notification_webhook_enabled", "Отправлять события", "checkbox"],
    ["notification_webhook_url", "Адрес получателя", "url"],
    ["notification_webhook_secret", "Секрет подписи", "password"],
  ]],
];
$("settings-tab").onclick = async () => {
  if (!managedProject || managedProject.role !== "admin") return;
  const id = managedProject.id, epoch = managementEpoch;
  try {
    const values = await api(`projects/${id}/settings`);
    if (epoch !== managementEpoch) return;
    const fields = $("project-setting-fields");
    fields.replaceChildren();
    fields.append(node("p", "muted small", `Базовый адрес API: ${location.origin}/projects/${id}/api/v1`));
    for (const [title, settings] of settingSections) {
      const section = node("fieldset");
      section.append(node("legend", "", title));
      for (const [key, label, type] of settings) {
        const wrapper = node("label", type === "checkbox" ? "checkbox-label" : "", label);
        const input = node(type === "identity" ? "select" : "input");
        input.name = key;
        if (type === "identity") {
          for (const [value, text] of [["external_id", "ID на вашем сайте"], ["email", "Email"]]) {
            const option = node("option", "", text); option.value = value; input.append(option);
          }
          input.value = values[key] || "external_id";
        } else {
          input.type = type;
          if (type === "checkbox") input.checked = Boolean(values[key]);
          else if (type === "password") {
            input.autocomplete = "new-password";
            input.placeholder = values[key] ? "Ключ сохранён" : "Не настроено";
          } else input.value = values[key] ?? "";
        }
        wrapper.append(input);
        section.append(wrapper);
      }
      fields.append(section);
    }
    managementTab("settings");
  } catch (error) { projectError(error); }
};
$("projects-open").onclick = async () => {
  $("project-error").textContent = "";
  projectsOverview();
  $("projects-dialog").showModal();
  try { await renderProjects(); } catch (error) { projectError(error); }
};
function projectsOverview() {
  managedProject = null;
  managementEpoch++;
  $("project-management").hidden = true;
  $("projects-overview").hidden = false;
  $("projects-back").hidden = true;
  $("projects-title").textContent = "Проекты";
  $("project-settings-form").reset();
  $("project-branding-form").reset();
}
$("projects-back").onclick = () => {
  projectsOverview();
  $("project-error").textContent = "";
  $("project-list").querySelector("button")?.focus();
};
$("projects-close").onclick = () => {
  managementEpoch++;
  $("project-settings-form").reset();
  $("projects-dialog").close();
};
$("projects-dialog").addEventListener("close", () => { if (!$("projects-dialog").open) projectsOverview(); });
function managementForm(id, perform) {
  $(id).onsubmit = async (event) => {
    event.preventDefault();
    const epoch = managementEpoch;
    event.submitter.disabled = true;
    $("project-error").textContent = "";
    try {
      await perform(Object.fromEntries(new FormData(event.target)), event.target);
    } catch (error) { if (epoch === managementEpoch) projectError(error); }
    finally { event.submitter.disabled = false; }
  };
}
managementForm("project-create-form", async (values, form) => {
  await api("projects", {method: "POST", data: values});
  form.reset();
  await renderProjects();
});
managementForm("member-form", async (values, form) => {
  const epoch = managementEpoch;
  await api(`projects/${managedProject.id}/members`, {method: "POST", data: values});
  if (epoch !== managementEpoch) return;
  form.reset();
  await refreshMembers();
});
managementForm("project-admin-form", async (values, form) => {
  const id = managedProject.id, epoch = managementEpoch;
  await api(`projects/${id}/admin`, {method: "POST", data: values});
  form.reset();
  await renderProjects();
  if (epoch !== managementEpoch) return;
  await openManagement(state.projects.find((project) => project.id === id));
});
managementForm("project-settings-form", async (_, form) => {
  const id = managedProject.id, epoch = managementEpoch;
  const settings = {};
  for (const input of form.elements) {
    if (!input.name) continue;
    if (input.type === "checkbox") settings[input.name] = input.checked;
    else if (input.type === "password") { if (input.value) settings[input.name] = input.value; }
    else settings[input.name] = input.type === "number" ? Number(input.value) : input.value || null;
  }
  await api(`projects/${id}/settings`, {method: "POST", data: {settings}});
  if (epoch !== managementEpoch) return;
  form.reset();
  await $("settings-tab").onclick();
  if (epoch !== managementEpoch) return;
  statusText("project-error", "Подключения сохранены. Активный проект перезапустится автоматически.", true);
});
$("owner-transfer-form").onsubmit = async (event) => {
  event.preventDefault();
  event.submitter.disabled = true;
  try {
    await api("installation/admin", {method: "POST", data: Object.fromEntries(new FormData(event.target))});
    event.target.reset();
    showLogin();
  } catch (error) { statusText("account-error", error.message); }
  finally { event.submitter.disabled = false; }
};

async function poll() {
  if (
    state.account &&
    !document.hidden &&
    !state.syncing &&
    !state.opening &&
    !state.sending &&
    !state.loadingOlder
  ) {
    const epoch = state.epoch;
    state.syncing = true;
    try {
      await refreshProjects(false);
      await syncTickets();
      if (state.ticket && epoch === state.epoch && !state.opening) {
        await Promise.all([syncDetail(state.ticket, epoch), syncMessages()]);
      }
    } catch (error) {
      fail(error);
    } finally {
      state.syncing = false;
    }
  }
  setTimeout(poll, 3000);
}
api("me")
  .then(enter)
  .catch(() => showLogin())
  .finally(poll);

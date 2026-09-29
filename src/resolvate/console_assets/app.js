"use strict";

const $ = (id) => document.getElementById(id);
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
};

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}
function notice(text = "") {
  $("global-error").textContent = text;
  $("global-error").hidden = !text;
}
function fail(error) {
  notice(error.message || "Не удалось выполнить действие.");
}
async function api(path, { method = "GET", data, form, key } = {}) {
  const scoped = /^(tickets(?:\/|$)|media\/|retry\/|replies(?:\?|$))/.test(path);
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
    throw new Error(
      typeof result.detail === "string"
        ? result.detail
        : "Запрос не выполнен. Повторите позже.",
    );
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
  state.epoch++;
  state.account = null;
  state.project = null;
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
    $("login-error").textContent = error.message;
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
      $("login-error").textContent = "Пароль изменён. Войдите с новым паролем.";
    } else {
      $("account-error").textContent = "Пароль сотрудника изменён. Старые сессии завершены.";
    }
  } catch (error) {
    $("password-error").textContent = error.message;
  } finally {
    passwordBusy = false;
    event.submitter.disabled = false;
  }
};

async function syncTickets() {
  if (!state.project) return;
  const listEpoch = ++state.listEpoch;
  const epoch = state.epoch,
    query = $("search").value,
    archived = state.archived;
  const order = [];
  for (let page = 0; page < state.pages; page++) {
    const result = await api("tickets/sync", {
      method: "POST",
      data: {
        known: known(state.tickets),
        query,
        archived,
        offset: page * 50,
      },
    });
    if (
      listEpoch !== state.listEpoch ||
      epoch !== state.epoch ||
      query !== $("search").value ||
      archived !== state.archived
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
  for (const id of unique) {
    const item = state.tickets.get(id),
      button = node(
        "button",
        "ticket" + (id === state.ticket ? " selected" : ""),
      );
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
    button.append(top, preview);
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
  state.epoch++;
  state.ticket = id;
  const epoch = state.epoch;
  state.messages.clear();
  state.before = null;
  state.older = false;
  $("message-list").replaceChildren();
  $("reply-options").hidden = true;
  $("customer-card").hidden = true;
  $("message-text").value = draft().text;
  $("file").value = "";
  renderFile();
  $("dialogue").hidden = false;
  $("empty").hidden = true;
  $("workspace").classList.add("open-chat");
  await syncDetail(id, epoch);
  await syncMessages(true);
  await syncTickets();
  $("message-text").focus();
}
async function syncDetail(id, epoch) {
  const detail = await api(`tickets/${id}`);
  if (epoch !== state.epoch || id !== state.ticket) return;
  state.detail = detail;
  $("customer-name").textContent =
    detail.display_name || detail.username || "Клиент";
  $("customer-channel").textContent =
    detail.channel === "telegram" ? "Telegram" : "Сайт · API";
  const closed = detail.status === "closed";
  $("closed-label").hidden = !closed;
  $("lifecycle").textContent = closed ? "Возобновить" : "Завершить";
  const fields = [
    ["Имя", detail.display_name],
    ["Канал", detail.channel],
    ["Username", detail.username],
    ["Email", detail.email],
    ["Идентификатор", detail.identity_value],
    ["Remnawave ID", detail.remnawave_user_uuid],
    ["Первое обращение", new Date(detail.created_at).toLocaleString("ru")],
  ];
  $("customer-fields").replaceChildren();
  for (const [key, value] of fields)
    if (value)
      $("customer-fields").append(node("dt", "", key), node("dd", "", value));
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
  const bubble = node("div", "bubble");
  if (item.media_id) {
    const url = `/console/projects/${state.project}/media/${encodeURIComponent(item.media_id)}`;
    if (item.mime?.startsWith("image/")) {
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
  if (item.text) bubble.append(document.createTextNode(item.text));
  if (item.rating) {
    bubble.classList.add("rating-card");
    const link = node("a", "ticket-link", "📂 Перейти к тикету");
    const project = state.project;
    link.href = `/console/?project=${encodeURIComponent(project)}&ticket=${encodeURIComponent(item.rating.ticket_id)}`;
    link.onclick = (event) => {
      if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      if (state.project === project) openTicket(item.rating.ticket_id).catch(fail);
    };
    bubble.append(link);
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
async function syncMessages(initial = false, older = false) {
  const id = state.ticket,
    epoch = state.epoch;
  if (!id) return;
  const result = await api(`tickets/${id}/sync`, {
    method: "POST",
    data: {
      known: older ? {} : known(state.messages),
      before: older ? state.before : null,
    },
  });
  if (epoch !== state.epoch || id !== state.ticket) return;
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
  if (initial || older) {
    state.before = result.before;
    state.older = result.has_older;
  }
  $("older").hidden = !state.older;
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
    await api(`tickets/${id}/read/${ordered[ordered.length - 1].id}`, {
      method: "POST",
    });
  }
}
$("older").onclick = async () => {
  if (state.loadingOlder || state.syncing) return;
  state.loadingOlder = true;
  $("older").disabled = true;
  try {
    await syncMessages(false, true);
  } catch (error) {
    fail(error);
  } finally {
    state.loadingOlder = false;
    $("older").disabled = false;
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
};
$("customer-close").onclick = () => {
  $("customer-card").hidden = true;
};
for (const [id, archived] of [
  ["active-tab", false],
  ["archive-tab", true],
])
  $(id).onclick = () => {
    state.archived = archived;
    state.pages = 1;
    for (const [tab, selected] of [
      ["active-tab", !archived],
      ["archive-tab", archived],
    ]) {
      $(tab).classList.toggle("selected", selected);
      $(tab).setAttribute("aria-pressed", String(selected));
    }
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
  draft().key = null;
  saveDraft();
  $("reply-options").hidden = true;
  $("message-text").focus();
}
let replyTimer;
$("message-text").oninput = () => {
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
        $("account-error").textContent = error.message;
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
      } catch (error) { $("account-error").textContent = error.message; }
      finally { save.disabled = false; }
    };
    description.append(identity);
    const resetPassword = node("button", "secondary", "Сбросить пароль");
    resetPassword.onclick = () => openPassword(account);
    row.append(description, resetPassword, button);
    $("account-list").append(row);
  }
}
$("accounts-open").onclick = async () => {
  $("account-error").textContent = "";
  $("accounts-dialog").showModal();
  try {
    await refreshAccounts();
  } catch (error) {
    $("account-error").textContent = error.message;
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
    $("account-error").textContent = error.message;
  } finally {
    event.submitter.disabled = false;
  }
};
function selectProject(id) {
  if (state.sending) return;
  imageViewer.close();
  state.epoch++;
  state.listEpoch++;
  state.searchEpoch++;
  state.project = id || null;
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
const projectError = (error) => { $("project-error").textContent = error.message; };

async function renderProjects() {
  await refreshProjects(false);
  $("project-list").replaceChildren();
  const owner = state.account.role === "admin";
  $("project-create-form").hidden = !owner;
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
  $("project-admin-form").hidden = state.account.role !== "admin";
  $("settings-tab").hidden = project.role !== "admin";
  $("branding-tab").hidden = project.role !== "admin";
  $("project-branding-form").reset();
  $("branding-status").textContent = "";
  $("project-settings-form").reset();
  $("project-setting-fields").replaceChildren();
  $("members-tab").click();
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
  $("project-management").hidden = true;
  $("projects-dialog").showModal();
  try { await renderProjects(); } catch (error) { projectError(error); }
};
$("projects-close").onclick = () => {
  managementEpoch++;
  $("project-settings-form").reset();
  $("projects-dialog").close();
};
function managementForm(id, perform) {
  $(id).onsubmit = async (event) => {
    event.preventDefault();
    event.submitter.disabled = true;
    $("project-error").textContent = "";
    try {
      await perform(Object.fromEntries(new FormData(event.target)), event.target);
    } catch (error) { projectError(error); }
    finally { event.submitter.disabled = false; }
  };
}
managementForm("project-create-form", async (values, form) => {
  await api("projects", {method: "POST", data: values});
  form.reset();
  await renderProjects();
});
managementForm("member-form", async (values, form) => {
  await api(`projects/${managedProject.id}/members`, {method: "POST", data: values});
  form.reset();
  await refreshMembers();
});
managementForm("project-admin-form", async (values, form) => {
  const id = managedProject.id;
  await api(`projects/${id}/admin`, {method: "POST", data: values});
  form.reset();
  await renderProjects();
  await openManagement(state.projects.find((project) => project.id === id));
});
managementForm("project-settings-form", async (_, form) => {
  const settings = {};
  for (const input of form.elements) {
    if (!input.name) continue;
    if (input.type === "checkbox") settings[input.name] = input.checked;
    else if (input.type === "password") { if (input.value) settings[input.name] = input.value; }
    else settings[input.name] = input.type === "number" ? Number(input.value) : input.value || null;
  }
  await api(`projects/${managedProject.id}/settings`, {method: "POST", data: {settings}});
  form.reset();
  await $("settings-tab").onclick();
  $("project-error").textContent = "Подключения сохранены. Активный проект перезапустится автоматически.";
});
$("owner-transfer-form").onsubmit = async (event) => {
  event.preventDefault();
  event.submitter.disabled = true;
  try {
    await api("installation/admin", {method: "POST", data: Object.fromEntries(new FormData(event.target))});
    event.target.reset();
    showLogin();
  } catch (error) { $("account-error").textContent = error.message; }
  finally { event.submitter.disabled = false; }
};

async function poll() {
  if (
    state.account &&
    !document.hidden &&
    !state.syncing &&
    !state.sending &&
    !state.loadingOlder
  ) {
    state.syncing = true;
    try {
      await refreshProjects(false);
      await syncTickets();
      if (state.ticket) {
        await syncDetail(state.ticket, state.epoch);
        await syncMessages();
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

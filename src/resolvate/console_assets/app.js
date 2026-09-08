"use strict";

const $ = (id) => document.getElementById(id);
const state = {
  account: null,
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
  state.csrf = "";
  state.ticket = null;
  state.drafts.clear();
  state.messages.clear();
  state.tickets.clear();
  $("accounts-dialog").close();
  $("workspace").hidden = true;
  $("login-screen").hidden = false;
  $("message-list").replaceChildren();
  $("ticket-list").replaceChildren();
  $("file").value = "";
  $("message-text").value = "";
}
async function enter(result) {
  state.account = result.account;
  state.csrf = result.csrf;
  $("account-name").textContent = result.account.name;
  $("account-role").textContent =
    result.account.role === "admin" ? "Администратор" : "Оператор";
  $("accounts-open").hidden = result.account.role !== "admin";
  $("login-screen").hidden = true;
  $("workspace").hidden = false;
  $("dialogue").hidden = true;
  $("empty").hidden = false;
  $("workspace").classList.remove("open-chat");
  await syncTickets();
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

async function syncTickets() {
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
      (outgoing ? " outgoing" : "") +
      (item.channel === "internal_note" ? " internal" : ""),
  );
  element.dataset.id = item.id;
  element.dataset.revision = item.revision;
  const meta = node("div", "message-meta");
  meta.append(
    node(
      "span",
      "",
      outgoing ? item.author : $("customer-name").textContent || "Клиент",
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
    const url = `/console/media/${encodeURIComponent(item.media_id)}`;
    if (item.mime?.startsWith("image/")) {
      const image = node("img");
      image.src = url;
      image.alt = "Фото из переписки";
      image.loading = "lazy";
      image.onerror = () => {
        image.replaceWith(node("span", "muted", "Фото больше не доступно"));
      };
      bubble.append(image);
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
    row.append(description, button);
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
    await api("accounts", {
      method: "POST",
      data: Object.fromEntries(new FormData(event.target)),
    });
    event.target.reset();
    await refreshAccounts();
  } catch (error) {
    $("account-error").textContent = error.message;
  } finally {
    event.submitter.disabled = false;
  }
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

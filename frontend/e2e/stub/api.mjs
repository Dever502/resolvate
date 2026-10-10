// In-memory stand-in for the project console API (src/resolvate/console.py, console_service.py,
// console_folders.py, project_routes.py): the same paths, request bodies and response shapes,
// including revision deltas, history cursors, folder revisions and the server-sent event stream.
import { createHash, randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";

const PAGE = 50;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// A 1×1 PNG stands in for photos, thumbnails and logos.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64",
);
// A valid, empty Lottie animation: enough for the TGS player to load under the console CSP.
const TGS = gzipSync(JSON.stringify({ v: "5.7.4", fr: 30, ip: 0, op: 30, w: 512, h: 512, nm: "stub", ddd: 0, assets: [], layers: [] }));
export const OPERATOR = "Оператор Тест";

let state;
const streams = new Set();

const fingerprint = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const withRevision = (item) => ({ ...item, revision: fingerprint(item) });
const byTime = (a, b) => a.time.localeCompare(b.time) || a.id.localeCompare(b.id);

function message(fields) {
  return {
    id: randomUUID(), direction: "user_to_operator", channel: "telegram", text: "", system: false, rating: null,
    author: "Клиент", media_id: null, mime: null, sticker: false, sticker_emoji: null, attachment: false,
    failed: [], uncertain: false, command: null, ...fields,
  };
}

/** Fresh data for a test. `many` adds enough dialogues for a second page. */
export function reset(options = {}) {
  const now = Date.now();
  const at = (minutes) => new Date(now - minutes * 60_000).toISOString();
  const projects = [
    { id: "p1", name: "Поддержка", active: true, admin_id: "a0", role: "operator", logo: "logo-v1" },
    { id: "p2", name: "Второй проект", active: true, admin_id: "a0", role: "operator", logo: null },
    { id: "p3", name: "Отключённый", active: false, admin_id: "a0", role: "operator", logo: null },
    { id: "p4", name: "Без доступа", active: true, admin_id: "a0", role: null, logo: null },
  ];
  const tickets = [
    { project: "p1", id: "t1", name: "Анна Смирнова", username: "anna", email: null, channel: "telegram", status: "open", folder_id: null, folder_revision: 0, created_at: at(600) },
    { project: "p1", id: "t2", name: "Борис Петров", username: null, email: "boris@example.com", channel: "web", status: "open", folder_id: "f1", folder_revision: 1, created_at: at(300) },
    { project: "p1", id: "t3", name: "Вера Архивная", username: "vera", email: null, channel: "telegram", status: "closed", folder_id: null, folder_revision: 0, created_at: at(900) },
    { project: "p2", id: "t4", name: "Григорий из второго", username: null, email: null, channel: "web", status: "open", folder_id: null, folder_revision: 0, created_at: at(120) },
  ];
  if (options.many) {
    for (let index = 0; index < 60; index++) {
      tickets.push({ project: "p1", id: `m${index}`, name: `Клиент ${index + 1}`, username: null, email: null, channel: "telegram",
        status: "open", folder_id: null, folder_revision: 0, created_at: at(2000 + index) });
    }
  }
  const messages = new Map(tickets.map((ticket) => [ticket.id, []]));
  // Sixty messages for Анна: the newest fifty arrive first, the rest via "older".
  for (let index = 0; index < 60; index++) {
    messages.get("t1").push(message({
      direction: index % 2 ? "operator_to_user" : "user_to_operator",
      author: index % 2 ? OPERATOR : "Клиент",
      text: `Сообщение ${index + 1}`,
      time: at(200 - index * 2),
    }));
  }
  const media = new Map([
    ["photo-1", { mime: "image/png", body: PNG }],
    ["sticker-1", { mime: "application/x-tgsticker", body: TGS }],
  ]);
  messages.get("t1").push(
    message({ text: "", media_id: "photo-1", mime: "image/png", attachment: true, time: at(70) }),
    message({ text: "", media_id: "sticker-1", mime: "application/x-tgsticker", sticker: true, sticker_emoji: "👍", attachment: true, time: at(69) }),
    message({ text: "Как подключить тариф?", time: at(5) }),
    message({ text: "И ещё вопрос про оплату", time: at(4) }),
  );
  messages.get("t2").push(message({ channel: "web", text: "Здравствуйте, нужна помощь", time: at(30) }));
  messages.get("t3").push(
    message({ text: "Спасибо!", time: at(800) }),
    message({ channel: "system", system: true, direction: "operator_to_user", author: "Система", text: "✅ Обращение закрыто", time: at(799) }),
  );
  messages.get("t4").push(message({ channel: "web", text: "Вопрос во втором проекте", time: at(60) }));
  for (const ticket of tickets) {
    if (!messages.get(ticket.id).length) messages.get(ticket.id).push(message({ text: `Привет от ${ticket.name}`, time: ticket.created_at }));
  }
  state = {
    projects, tickets, messages, media,
    folders: new Map([["p1", [{ id: "f1", name: "VIP", revision: 0 }]], ["p2", []]]),
    replyGroups: new Map([["p1", [{ id: "g1", name: "общее", revision: 0 }, { id: "g2", name: "оплата", revision: 0 }]], ["p2", []]]),
    replies: new Map([["p1", [
      { id: "r1", text: "Здравствуйте! Чем могу помочь?", group_id: "g1", revision: 0 },
      { id: "r2", text: "Спасибо за обращение, хорошего дня.", group_id: "g1", revision: 0 },
      { id: "r3", text: "Проверьте, пожалуйста, настройки тарифа.", group_id: "g2", revision: 0 },
    ]], ["p2", []]]),
    // Everything up to t1's first page is read; the last two customer messages are unread.
    reads: new Map([["t1", at(6)]]),
    sent: new Map(),
  };
  for (const stream of streams) stream.response.end();
  streams.clear();
}
reset();

const ticket = (project, id) => state.tickets.find((item) => item.project === project && item.id === id);
const history = (id) => [...state.messages.get(id)].sort(byTime);

function view(item) {
  const all = history(item.id);
  const last = all.at(-1);
  const read = state.reads.get(item.id);
  const unread = all.filter((entry) => entry.direction === "user_to_operator" && !entry.system && (!read || entry.time > read)).length;
  const preview = last.rating ? "⭐ Оценка поддержки" : last.channel === "system" ? "Системное уведомление" : last.text || "Вложение";
  return withRevision({
    id: item.id, name: item.name, channel: item.channel, status: item.status, time: last.time,
    preview: preview.slice(0, 180), unread, folder_id: item.folder_id, folder_revision: item.folder_revision,
  });
}

function detail(item) {
  return {
    id: item.id, user_id: 1, telegram_user_id: item.channel === "telegram" ? 1000 : null, display_name: item.name,
    username: item.username, topic_id: null, status: item.status, created_at: item.created_at, updated_at: item.created_at,
    last_activity_at: history(item.id).at(-1).time, closed_at: null, close_cycle: 0, reopened: false, channel: item.channel,
    email: item.email, identity_provider: item.channel, identity_value: item.channel === "web" ? `web-${item.id}` : null,
    remnawave_user_uuid: null, folder_id: item.folder_id, folder_revision: item.folder_revision,
  };
}

function ticketPage(project, { known = {}, archived = false, query = "", offset = 0, folder_id = null }) {
  const needle = query.toLowerCase();
  const rows = state.tickets
    .filter((item) => item.project === project && (archived ? item.status === "closed" : item.status !== "closed"))
    .filter((item) => !folder_id || item.folder_id === folder_id)
    .filter((item) => !needle || item.name.toLowerCase().includes(needle) || (item.username ?? "").includes(needle) || item.id === query)
    .map(view)
    .sort((a, b) => b.time.localeCompare(a.time) || b.id.localeCompare(a.id))
    .slice(offset, offset + PAGE);
  return { order: rows.map((row) => row.id), items: rows.filter((row) => known[row.id] !== row.revision) };
}

function messagePage(id, { known = {}, before = null }) {
  const all = history(id).map(withRevision);
  let start = Math.max(0, all.length - PAGE);
  let end = all.length;
  if (before) {
    end = Number(String(before).split(":")[1]);
    start = Math.max(0, end - PAGE);
  }
  let rows = all.slice(start, end);
  const cursor = rows.length ? `i:${start}` : null;
  const older = start > 0;
  if (!before && Object.keys(known).length) {
    const first = Math.min(...Object.keys(known).map((ident) => all.findIndex((item) => item.id === ident)).filter((index) => index >= 0));
    if (Number.isFinite(first)) rows = all.slice(first);
  }
  const order = rows.map((row) => row.id);
  return {
    order, items: rows.filter((row) => known[row.id] !== row.revision), before: cursor, reset: false, has_older: older,
    removed: Object.keys(known).filter((ident) => !order.includes(ident)),
  };
}

function multipart(body, type) {
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/.exec(type ?? "");
  const fields = {};
  const files = [];
  if (!boundary) return { fields, files };
  const marker = Buffer.from(`--${boundary[1] ?? boundary[2]}`);
  let position = body.indexOf(marker);
  while (position >= 0) {
    const next = body.indexOf(marker, position + marker.length);
    if (next < 0) break;
    const part = body.subarray(position + marker.length + 2, next - 2);
    const split = part.indexOf("\r\n\r\n");
    const head = part.subarray(0, split).toString("utf8");
    const content = part.subarray(split + 4);
    const name = /name="([^"]*)"/.exec(head)?.[1];
    const filename = /filename="([^"]*)"/.exec(head)?.[1];
    if (filename !== undefined) files.push({ name, filename, type: /Content-Type:\s*([^\r\n]+)/i.exec(head)?.[1] ?? "", size: content.length, content });
    else if (name) fields[name] = content.toString("utf8");
    position = next;
  }
  return { fields, files };
}

/** Tells every open event stream of the project that something changed. */
export function changed(project) {
  for (const stream of streams) if (stream.project === project) stream.response.write("event: change\ndata: {}\n\n");
}

/** Control: a customer writes into a dialogue. */
export function incoming({ ticket: id, text }) {
  const item = state.tickets.find((entry) => entry.id === id);
  state.messages.get(id).push(message({ channel: item.channel === "web" ? "web" : "telegram", text, time: new Date().toISOString() }));
  changed(item.project);
}

/** Control: the server revokes the project's event streams (401: session, 403: access). */
export function revoke({ project, status }) {
  for (const stream of [...streams]) {
    if (stream.project !== project) continue;
    stream.response.end(`event: revoked\ndata: {"status":${status}}\n\n`);
    streams.delete(stream);
  }
}

export function openStreams(project) {
  return [...streams].filter((stream) => stream.project === project).length;
}

/**
 * Answers a console API request, or returns false for paths it does not know.
 * `tools` brings the server's helpers: json, send, readBody, hasSession, headers.
 */
export async function handle(request, response, path, url, tools) {
  const { json, send, readBody } = tools;
  if (!path.startsWith("/console/projects")) return false;
  if (!tools.hasSession(request)) return json(response, 401, { detail: "Войдите в панель." }), true;
  if (path === "/console/projects" && request.method === "GET") return json(response, 200, state.projects), true;
  const scoped = /^\/console\/projects\/([^/]+)\/(.+)$/.exec(path);
  if (!scoped) return false;
  const [, projectId, rest] = scoped;
  const project = state.projects.find((item) => item.id === projectId);
  if (rest === "logo" && request.method === "GET") {
    if (!project?.logo) return json(response, 404, { detail: "Логотип не задан." }), true;
    return send(response, 200, { ...tools.headers.api, "content-type": "image/png" }, PNG), true;
  }
  if (!project || !project.role || !project.active) return json(response, 404, { detail: "Проект недоступен." }), true;
  const post = request.method === "POST";
  const body = post ? await readBody(request) : Buffer.alloc(0);
  const data = () => {
    try {
      return JSON.parse(body.toString("utf8") || "{}");
    } catch {
      return {};
    }
  };
  const done = (status, value) => (json(response, status, value), true);
  let match;

  if (rest === "events" && request.method === "GET") {
    response.writeHead(200, { ...tools.headers.api, "content-type": "text/event-stream", "x-accel-buffering": "no" });
    response.write("event: ready\ndata: {}\n\n");
    const stream = { project: projectId, response };
    streams.add(stream);
    request.on("close", () => streams.delete(stream));
    return true;
  }
  if (rest === "tickets/sync" && post) return done(200, ticketPage(projectId, data()));
  if ((match = /^tickets\/([^/]+)$/.exec(rest)) && request.method === "GET") {
    const item = ticket(projectId, match[1]);
    return item ? done(200, detail(item)) : done(404, { detail: "Диалог не найден." });
  }
  if ((match = /^tickets\/([^/]+)\/sync$/.exec(rest)) && post) {
    return ticket(projectId, match[1]) ? done(200, messagePage(match[1], data())) : done(404, { detail: "Диалог не найден." });
  }
  if ((match = /^tickets\/([^/]+)\/read\/([^/]+)$/.exec(rest)) && post) {
    const read = state.messages.get(match[1])?.find((item) => item.id === match[2]);
    if (!read) return done(404, { detail: "Сообщение не найдено." });
    if (!state.reads.get(match[1]) || state.reads.get(match[1]) < read.time) state.reads.set(match[1], read.time);
    return done(200, { ok: true });
  }
  if ((match = /^tickets\/([^/]+)\/send$/.exec(rest)) && post) {
    const item = ticket(projectId, match[1]);
    const key = request.headers["x-idempotency-key"] ?? "";
    if (!UUID.test(key)) return done(422, { detail: "Нужен ключ отправки." });
    if (!item) return done(404, { detail: "Диалог не найден." });
    if (state.sent.has(key)) return done(200, { id: state.sent.get(key) });
    const { fields, files } = multipart(body, request.headers["content-type"]);
    const text = (fields.text ?? "").trim();
    const file = files[0];
    if (!text && !file) return done(422, { detail: "Введите сообщение или прикрепите файл." });
    let mediaId = null;
    if (file) {
      mediaId = randomUUID();
      state.media.set(mediaId, { mime: file.type, body: file.type.startsWith("image/") ? PNG : file.content });
    }
    const sent = message({
      direction: "operator_to_user", channel: item.channel === "web" ? "web" : "telegram", author: OPERATOR, text,
      media_id: mediaId, mime: file?.type ?? null, attachment: Boolean(file), time: new Date().toISOString(),
    });
    state.messages.get(item.id).push(sent);
    state.sent.set(key, sent.id);
    changed(projectId);
    return done(200, { id: sent.id });
  }
  if ((match = /^tickets\/([^/]+)\/(close|reopen)$/.exec(rest)) && post) {
    const item = ticket(projectId, match[1]);
    if (!item) return done(404, { detail: "Диалог не найден." });
    const closing = match[2] === "close";
    const changedStatus = closing ? item.status !== "closed" : item.status === "closed";
    item.status = closing ? "closed" : "open";
    if (closing && changedStatus) {
      state.messages.get(item.id).push(message({
        channel: "system", system: true, direction: "operator_to_user", author: "Система",
        text: "✅ Обращение закрыто", time: new Date().toISOString(),
      }));
    }
    changed(projectId);
    return done(200, { changed: changedStatus });
  }
  if ((match = /^tickets\/([^/]+)\/folder$/.exec(rest)) && post) {
    const item = ticket(projectId, match[1]);
    const { folder_id: folderId, revision } = data();
    if (!item) return done(404, { detail: "Диалог не найден." });
    if (item.folder_revision !== revision) return done(409, { detail: "Другой оператор уже изменил папку диалога. Выберите её заново." });
    if (folderId && !state.folders.get(projectId).some((folder) => folder.id === folderId)) {
      return done(404, { detail: "Папка уже удалена или недоступна." });
    }
    if (item.folder_id !== folderId) {
      item.folder_id = folderId;
      item.folder_revision++;
    }
    changed(projectId);
    return done(200, { folder_id: item.folder_id, folder_revision: item.folder_revision });
  }
  const folders = state.folders.get(projectId);
  if (rest === "folders" && request.method === "GET") return done(200, folders);
  if (rest === "folders" && post) {
    const name = String(data().name ?? "").trim();
    if (!name) return done(422, { detail: "Укажите название папки." });
    if (folders.some((folder) => folder.name.toLowerCase() === name.toLowerCase())) {
      return done(409, { detail: "Папка с таким названием уже существует." });
    }
    const created = { id: randomUUID(), name, revision: 0 };
    folders.push(created);
    folders.sort((a, b) => a.name.localeCompare(b.name));
    changed(projectId);
    return done(200, created);
  }
  if ((match = /^folders\/([^/]+)\/(rename|delete)$/.exec(rest)) && post) {
    const folder = folders.find((item) => item.id === match[1]);
    const { name, revision } = data();
    if (!folder) return done(404, { detail: "Папка уже удалена или недоступна." });
    if (folder.revision !== revision) return done(409, { detail: "Папку уже изменил другой оператор." });
    if (match[2] === "rename") {
      folder.name = String(name).trim();
      folder.revision++;
    } else {
      folders.splice(folders.indexOf(folder), 1);
      for (const item of state.tickets) {
        if (item.folder_id === folder.id) {
          item.folder_id = null;
          item.folder_revision++;
        }
      }
    }
    changed(projectId);
    return done(200, { ok: true });
  }
  if (rest === "reply-groups" && request.method === "GET") {
    const query = (url.searchParams.get("q") ?? "").toLowerCase().replace(/^\//, "");
    const offset = Number(url.searchParams.get("offset") ?? 0);
    return done(200, state.replyGroups.get(projectId).filter(group => group.name.includes(query)).slice(offset, offset + 50));
  }
  if (rest === "reply-groups" && post) {
    const group = { id: randomUUID(), name: data().name.toLowerCase().replace(/^\//, ""), revision: 0 };
    state.replyGroups.get(projectId).push(group);
    return done(200, group);
  }
  if (rest === "replies" && post) {
    const reply = { id: randomUUID(), text: data().text, group_id: data().group_id, revision: 0 };
    state.replies.get(projectId).push(reply);
    return done(200, reply);
  }
  if ((match = /^replies\/([^/]+)\/(edit|delete)$/.exec(rest)) && post) {
    const rows = state.replies.get(projectId);
    const reply = rows.find(row => row.id === match[1]);
    if (!reply) return done(404, { detail: "Ответ не найден." });
    if (reply.revision !== data().revision) return done(409, { detail: "Ответ изменён." });
    if (match[2] === "delete") rows.splice(rows.indexOf(reply), 1);
    else Object.assign(reply, { text: data().text, group_id: data().group_id, revision: reply.revision + 1 });
    return done(200, reply);
  }
  if (rest === "replies" && request.method === "GET") {
    const query = (url.searchParams.get("q") ?? "").toLowerCase();
    const group = url.searchParams.get("group_id");
    const offset = Number(url.searchParams.get("offset") ?? 0);
    return done(200, state.replies.get(projectId).filter((reply) => (!group || reply.group_id === group) && reply.text.toLowerCase().includes(query)).slice(offset, offset + 50));
  }
  if ((match = /^retry\/([^/]+)\/([^/]+)$/.exec(rest)) && post) return done(200, { ok: true });
  if ((match = /^media\/([^/]+)(\/thumbnail)?$/.exec(rest)) && request.method === "GET") {
    const media = state.media.get(decodeURIComponent(match[1]));
    if (!media) return done(410, { detail: "Вложение больше не хранится." });
    if (match[2]) return send(response, 200, { ...tools.headers.api, "content-type": "image/png" }, PNG), true;
    const sticker = media.mime === "application/x-tgsticker";
    return send(response, 200, {
      ...tools.headers.api,
      "content-type": sticker ? "application/json" : media.mime,
      ...(sticker ? { "content-encoding": "gzip" } : {}),
    }, media.body), true;
  }
  return false;
}

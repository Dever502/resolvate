// In-memory stand-in for the project console API (src/resolvate/console.py, console_service.py,
// console_folders.py): the same paths, request bodies and response shapes, including revision deltas,
// history cursors, folder revisions and the server-sent event stream. Accounts, projects and their
// administration live in admin.mjs.
import { createHash, randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";
import * as admin from "./admin.mjs";
import { multipart } from "./multipart.mjs";

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

/**
 * Fresh data for a test. `many` adds enough dialogues for a second page; `catalog: "large"` adds
 * enough reply groups and answers in "общее" for a second page of each.
 */
export function reset(options = {}) {
  const now = Date.now();
  const at = (minutes) => new Date(now - minutes * 60_000).toISOString();
  const { accounts, projects, session } = admin.installation(options);
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
  // Every project has a quick replies catalog; only p1 starts with answers.
  const replyGroups = [{ id: "g1", name: "общее", revision: 0 }, { id: "g2", name: "оплата", revision: 0 }];
  const replies = [
    { id: "1", text: "Здравствуйте! Чем могу помочь?", group_id: "g1", revision: 0 },
    { id: "2", text: "Спасибо за обращение, хорошего дня.", group_id: "g1", revision: 0 },
    { id: "3", text: "Проверьте, пожалуйста, настройки тарифа.", group_id: "g2", revision: 0 },
  ];
  if (options.catalog === "large") {
    for (let index = 1; index <= 55; index++) {
      replyGroups.push({ id: `g${index + 2}`, name: `группа_${String(index).padStart(2, "0")}`, revision: 0 });
      replies.push({ id: String(index + 3), text: `Ответ номер ${index}`, group_id: "g1", revision: 0 });
    }
  }
  const catalog = (rows) => new Map(projects.map((item) => [item.id, item.id === "p1" ? rows : []]));
  state = {
    accounts, session, projects, tickets, messages, media,
    folders: new Map([["p1", [{ id: "f1", name: "VIP", revision: 0 }]], ["p2", []]]),
    replyGroups: catalog(replyGroups),
    replies: catalog(replies),
    // Answer ids come from one sequence for the whole installation, like the quick_responses table.
    lastReplyId: replies.length,
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

/**
 * Control: the next send of a file with this name is saved, then its connection drops in the middle of
 * the answer, as by a proxy or a lost network: the browser never learns the message was taken.
 */
export function loseAnswer({ file }) {
  state.loseAnswer = file;
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

/** The signed-in account as /console/me answers it, or null when the session ended. */
export function account() {
  const found = admin.current(state);
  return found ? admin.accountView(found) : null;
}

export function signIn(login, password) {
  return admin.signIn(state, login, password);
}

// A project created in the projects window starts with empty runtime data.
function onboard(project) {
  state.folders.set(project, []);
  state.replyGroups.set(project, []);
  state.replies.set(project, []);
}

// Quick replies catalog: src/resolvate/quick_reply_catalog.py behind its console.py routes, with the
// same checks in the same order. INVALID is FastAPI's answer when the route's types or lengths fail.
const INVALID = "Проверьте введённые данные.";
const BAD_QUERY = "Некорректный текст поиска.";
const GROUP_NAME = "Группа: 1–48 букв, цифр или знаков подчёркивания, без пробелов.";
const GROUP_EXISTS = "Такая группа уже существует.";
const NO_GROUP = "Группа не найдена.";
const NO_REPLY = "Ответ не найден.";
const REPLY_TEXT = "Ответ: непустой текст до 3900 символов (эмодзи могут занимать два).";
const STALE = "Запись изменена другим оператором. Обновите каталог.";
// Python's str.isspace(): Unicode White_Space and the separators U+001C-U+001F; str.strip() removes them.
const SPACE = String.raw`[\p{White_Space}\x1c-\x1f]+`;
const EDGES = new RegExp(`^${SPACE}|${SPACE}$`, "gu");
// Pydantic str fields: required, non-empty, max_length in code points.
const isText = (value, max) => typeof value === "string" && value !== "" && [...value].length <= max;
const isRevision = (value) => Number.isInteger(value) && value >= 0 && value <= 2 ** 31 - 1;
// _valid_text(): no NUL and no lone surrogate.
const validText = (value) => !/\0|[\ud800-\udfff]/u.test(value);
// save(): not blank, at most 3900 UTF-16 units.
const isReplyText = (text) => text.replace(EDGES, "") !== "" && text.length <= 3900 && validText(text);
// ReplyBody: group_id (a UUID for the real route) and text.
const isReplyBody = ({ group_id: groupId, text }) => typeof groupId === "string" && groupId !== "" && isText(text, 3900);
// ORDER BY name, id in the production PostgreSQL (Alpine, musl): plain UTF-8 byte order.
const byNameAndId = (a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)) || Buffer.compare(Buffer.from(a.id), Buffer.from(b.id));

/**
 * group_name(): NFKC, strip, one leading "/", lowercase; null when the result is not a valid name.
 * toLowerCase() stands in for casefold(); they differ only for sharp s, Greek final sigma and Cherokee.
 */
function groupName(value) {
  const name = value.normalize("NFKC").replace(EDGES, "").replace(/^\//, "").toLowerCase();
  return [...name].length <= 48 && /^[\p{L}\p{N}_]+$/u.test(name) && /[\p{L}\p{N}]/u.test(name) ? name : null;
}

/** The `offset` query parameter (0 when absent), or null when the route rejects it. */
function pageOffset(url) {
  const value = url.searchParams.get("offset") ?? "0";
  return /^\d+$/.test(value) && Number(value) <= 100_000 ? Number(value) : null;
}

/**
 * Answers a console API request, or returns false for paths it does not know.
 * `tools` brings the server's helpers: json, send, readBody, hasSession, headers.
 */
export async function handle(request, response, path, url, tools) {
  const { json, send, readBody } = tools;
  if (await admin.handle(state, request, response, path, url, { ...tools, onboard, logoBody: PNG })) return true;
  if (!path.startsWith("/console/projects")) return false;
  if (!tools.hasSession(request)) return json(response, 401, { detail: "Войдите в панель." }), true;
  const scoped = /^\/console\/projects\/([^/]+)\/(.+)$/.exec(path);
  if (!scoped) return false;
  const [, projectId, rest] = scoped;
  const project = state.projects.find((item) => item.id === projectId);
  // The project router answers for a missing or switched-off project; the runtime checks membership.
  if (!project || !project.active) return json(response, 404, { detail: "Проект недоступен." }), true;
  if (!admin.member(project, admin.current(state))) return json(response, 403, { detail: "Нет доступа к проекту." }), true;
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
    const { fields, files } = multipart(body, request.headers["content-type"]);
    const text = (fields.text ?? "").trim();
    const file = files[0];
    if (!text && !file) return done(422, { detail: "Введите сообщение или прикрепите файл." });
    // console.py send(): the length in code points, 800 with a file; an empty file is refused by the media check.
    if ([...text].length > (file ? 800 : 3900)) return done(422, { detail: "Максимум 3900 символов, с вложением — 800." });
    if (file && !file.content.length) return done(422, { detail: "⚠️ Файл пустой. Отправьте другой файл." });
    // console_service.send(): a key used again with the same dialogue, text and file answers with the
    // message it saved; with anything else it is refused.
    const fingerprint = JSON.stringify([item.id, text, file ? Buffer.from(file.content).toString("base64") : null]);
    const previous = state.sent.get(key);
    if (previous) {
      if (previous.fingerprint !== fingerprint) return done(409, { detail: "Ключ отправки уже использован." });
      return done(200, { id: previous.id });
    }
    let mediaId = null;
    if (file) {
      mediaId = randomUUID();
      state.media.set(mediaId, { mime: file.type, body: file.type.startsWith("image/") ? PNG : file.content });
    }
    const sent = message({
      direction: "operator_to_user", channel: item.channel === "web" ? "web" : "telegram", author: OPERATOR, text,
      media_id: mediaId, mime: file?.type ?? null, attachment: Boolean(file), time: new Date().toISOString(), command: key,
    });
    state.messages.get(item.id).push(sent);
    state.sent.set(key, { id: sent.id, fingerprint });
    changed(projectId);
    if (file && state.loseAnswer === file.filename) {
      state.loseAnswer = null;
      // The answer starts, then the connection drops: a browser sends such a request again on its own
      // only when no answer had begun.
      response.writeHead(200, { ...tools.headers.api, "content-type": "application/json", "content-length": "64" });
      response.write('{"id":', () => request.socket.destroy());
      return true;
    }
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
  const groups = state.replyGroups.get(projectId);
  const replies = state.replies.get(projectId);
  if (rest === "reply-groups" && request.method === "GET") {
    const query = url.searchParams.get("q") ?? "";
    const offset = pageOffset(url);
    if ([...query].length > 100 || offset === null) return done(422, { detail: INVALID });
    if (!validText(query)) return done(422, { detail: BAD_QUERY });
    const needle = query.normalize("NFKC").toLowerCase().replace(/^\//, "");
    return done(200, groups.filter((group) => group.name.includes(needle)).sort(byNameAndId).slice(offset, offset + PAGE));
  }
  if (rest === "reply-groups" && post) {
    const { name } = data();
    if (!isText(name, 80)) return done(422, { detail: INVALID });
    const normalized = groupName(name);
    if (!normalized) return done(422, { detail: GROUP_NAME });
    if (groups.some((group) => group.name === normalized)) return done(409, { detail: GROUP_EXISTS });
    const created = { id: randomUUID(), name: normalized, revision: 0 };
    groups.push(created);
    changed(projectId);
    return done(200, created);
  }
  if ((match = /^reply-groups\/([^/]+)\/(rename|delete)$/.exec(rest)) && post) {
    const renaming = match[2] === "rename";
    const { name, revision } = data();
    if (!isRevision(revision) || (renaming && !isText(name, 80))) return done(422, { detail: INVALID });
    const normalized = renaming ? groupName(name) : null;
    if (renaming && !normalized) return done(422, { detail: GROUP_NAME });
    const group = groups.find((item) => item.id === match[1]);
    if (!group) return done(404, { detail: NO_GROUP });
    if (group.revision !== revision) return done(409, { detail: STALE });
    const members = replies.filter((reply) => reply.group_id === group.id);
    if (renaming) {
      if (groups.some((item) => item !== group && item.name === normalized)) return done(409, { detail: GROUP_EXISTS });
      // Even an unchanged name counts as a change; every answer's publication heading follows it.
      group.name = normalized;
      group.revision++;
      for (const reply of members) reply.revision++;
    } else {
      if (members.length) return done(409, { detail: "Сначала перенесите или удалите ответы из группы." });
      groups.splice(groups.indexOf(group), 1);
    }
    changed(projectId);
    return done(200, { ok: true });
  }
  if (rest === "replies" && request.method === "GET") {
    const query = url.searchParams.get("q") ?? "";
    const groupId = url.searchParams.get("group_id");
    const offset = pageOffset(url);
    // Without group_id the search spans all groups; an empty group_id is a malformed UUID.
    if ([...query].length > 100 || groupId === "" || offset === null) return done(422, { detail: INVALID });
    if (!validText(query)) return done(422, { detail: BAD_QUERY });
    if (groupId !== null && !groups.some((group) => group.id === groupId)) return done(404, { detail: NO_GROUP });
    const needle = query.toLowerCase();
    return done(200, replies
      .filter((reply) => (groupId === null || reply.group_id === groupId) && reply.text.toLowerCase().includes(needle))
      .sort((a, b) => Number(a.id) - Number(b.id))
      .slice(offset, offset + PAGE));
  }
  if (rest === "replies" && post) {
    const input = data();
    if (!isReplyBody(input)) return done(422, { detail: INVALID });
    if (!isReplyText(input.text)) return done(422, { detail: REPLY_TEXT });
    if (!groups.some((group) => group.id === input.group_id)) return done(404, { detail: NO_GROUP });
    const created = { id: String(++state.lastReplyId), text: input.text, group_id: input.group_id, revision: 0 };
    replies.push(created);
    changed(projectId);
    return done(200, created);
  }
  if ((match = /^replies\/([^/]+)\/(edit|delete)$/.exec(rest)) && post) {
    const editing = match[2] === "edit";
    const input = data();
    // reply_id: int in the path, then the route's own range check.
    const id = /^[+-]?\d+$/.test(match[1]) ? Number(match[1]) : null;
    if (id === null || !isRevision(input.revision) || (editing && !isReplyBody(input))) return done(422, { detail: INVALID });
    if (!(id > 0 && id <= 2 ** 31 - 1)) return done(422, { detail: "Неверный ID ответа." });
    if (editing && !isReplyText(input.text)) return done(422, { detail: REPLY_TEXT });
    if (editing && !groups.some((group) => group.id === input.group_id)) return done(404, { detail: NO_GROUP });
    // Deleted answers are gone from the list: the backend's state "deleted" answers 404 too.
    const reply = replies.find((row) => row.id === String(id));
    if (!reply) return done(404, { detail: NO_REPLY });
    if (reply.revision !== input.revision) return done(409, { detail: STALE });
    if (editing) Object.assign(reply, { text: input.text, group_id: input.group_id, revision: reply.revision + 1 });
    else replies.splice(replies.indexOf(reply), 1);
    changed(projectId);
    return done(200, editing ? reply : { ok: true });
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

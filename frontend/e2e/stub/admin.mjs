// In-memory stand-in for the installation routes of the console (src/resolvate/console.py,
// console_auth.py, project_routes.py, projects.py, project_branding.py): accounts, passwords, projects,
// members, settings and logos, with the same permission checks, rules and answers as the backend.
import { createHash, randomUUID } from "node:crypto";
import { multipart } from "./multipart.mjs";

export const PASSWORD = "correct horse battery";
const MAX_ID = 2 ** 52 - 1;
const MAX_LOGO = 2 * 1024 * 1024;
const LOGIN = /^[a-z0-9][a-z0-9_.-]{2,63}$/;
const BOT_TOKEN = /^[1-9][0-9]{0,18}:[A-Za-z0-9_-]{20,200}$/;
const SECRET_FIELDS = ["support_bot_token", "api_admin_token", "web_api_token", "remnawave_api_token", "notification_webhook_secret"];
const PROJECT_FIELDS = new Set([
  ...SECRET_FIELDS, "support_group_id", "api_enabled", "web_api_enabled", "web_identity_mode", "remnawave_enabled",
  "remnawave_base_url", "remnawave_revoke_link_telegram_notification", "notification_webhook_enabled",
  "notification_webhook_url", "user_messages_per_minute", "user_messages_per_hour", "topic_rotation_enabled",
  "topic_rotation_message_limit", "topic_rotation_topic_limit", "topic_rotation_topic_reserve",
  "topic_rotation_delay_seconds", "archive_retention_days", "archive_media_compress_after_days",
  "archive_media_retention_days",
]);
// Settings defaults (src/resolvate/config.py).
const DEFAULTS = {
  support_bot_token: "", api_admin_token: null, web_api_token: null, remnawave_api_token: null,
  notification_webhook_secret: null, support_group_id: 0, api_enabled: false, web_api_enabled: false,
  web_identity_mode: "external_id", remnawave_enabled: false, remnawave_base_url: null,
  remnawave_revoke_link_telegram_notification: true, notification_webhook_enabled: false,
  notification_webhook_url: null, user_messages_per_minute: 30, user_messages_per_hour: 200,
  topic_rotation_enabled: true, topic_rotation_message_limit: null, topic_rotation_topic_limit: null,
  topic_rotation_topic_reserve: null, topic_rotation_delay_seconds: 300, archive_retention_days: 60,
  archive_media_compress_after_days: 14, archive_media_retention_days: 30,
};
const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

function person(id, login, name, extra = {}) {
  return { id, login, name, role: "operator", active: true, telegram_id: null, password: PASSWORD, ...extra };
}

// A configured project: its own bot and support group, as after a first save of its connections.
function project(number, name, adminId, members, extra = {}) {
  const bot = 100 + number;
  const group = -1001000000000 - number;
  return {
    id: `p${number}`, name, admin_id: adminId, members: new Set(members), active: true, logo: null, revision: 0,
    settings: { ...DEFAULTS, support_bot_token: `${bot}:${KEY}`, support_group_id: group }, bot_id: bot, group_id: group, ...extra,
  };
}

/**
 * Accounts, projects and the signed-in account for a scenario. `account` names who is signed in
 * (operator, admin, irina, pavel); `noProjects` starts an empty installation; `handover` gives every
 * project to irina; `inactive` switches the listed projects off; `staff` adds that many operators.
 */
export function installation(options = {}) {
  const accounts = [
    person("a0", "admin", "Администратор Установки", { role: "admin", telegram_id: 1001 }),
    person("a1", "operator", "Оператор Тест"),
    person("a2", "irina", "Ирина Соколова", { telegram_id: 2002 }),
    person("a3", "pavel", "Павел Орлов"),
    person("a4", "old.staff", "Бывший сотрудник", { active: false }),
  ];
  for (let index = 1; index <= (options.staff ?? 0); index++) {
    accounts.push(person(`s${index}`, `staff-${String(index).padStart(2, "0")}`, `Сотрудник ${index}`));
  }
  let projects = [
    project(1, "Поддержка", "a0", ["a1", "a2"], { logo: "logo-v1" }),
    project(2, "Второй проект", "a0", ["a1"]),
    // Never configured: switching it on is refused until the bot and the group are saved.
    project(3, "Отключённый", "a0", ["a1"], { active: false, settings: {}, bot_id: null, group_id: null }),
    project(4, "Без доступа", "a2", []),
  ];
  if (options.noProjects) projects = [];
  // Every project administered by someone else, without the installation administrator as member.
  if (options.handover) {
    for (const item of projects) {
      item.admin_id = "a2";
      item.members.delete("a0");
      item.members.delete("a2");
    }
  }
  for (const item of projects) if ((options.inactive ?? []).includes(item.id)) item.active = false;
  const signedIn = accounts.find((item) => item.login === (options.account ?? "operator"));
  return { accounts, projects, session: signedIn?.id ?? null };
}

export function accountView(account) {
  const { id, login, name, role, active, telegram_id } = account;
  return { id, login, name, role, active, telegram_id };
}

/** The signed-in, still active account, or null: a revoked or ended session. */
export function current(state) {
  return state.accounts.find((item) => item.id === state.session && item.active) ?? null;
}

export function signIn(state, login, password) {
  const found = state.accounts.find((item) => item.login === String(login ?? "").trim().toLowerCase());
  if (!found || !found.active || found.password !== password) return null;
  state.session = found.id;
  return accountView(found);
}

export function projectView(item, account) {
  const member = item.members.has(account.id);
  const admin = item.admin_id === account.id;
  return {
    id: item.id, name: item.name, active: item.active, admin_id: item.admin_id,
    role: admin ? "admin" : member ? "operator" : null, logo: member || admin ? item.logo : null,
  };
}

/** Project runtime routes need membership; installation routes check their own rights. */
export function member(item, account) {
  return item.admin_id === account.id || item.members.has(account.id);
}

const text = (value, min, max) => typeof value === "string" && [...value].length >= min && [...value].length <= max;
const integer = (value) => Number.isSafeInteger(value) && typeof value === "number";
const secretOk = (value, ascii) => typeof value === "string" && [...value].length >= 32 && value === value.trim()
  && (!ascii || /^[!-~]+$/.test(value));

function urlOk(value) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.hash
      && (url.protocol === "https:" || ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
  } catch {
    return false;
  }
}

// What Settings itself refuses (config.py): types, ranges and the rules of enabled integrations.
function settingsValid(values) {
  const flags = ["api_enabled", "web_api_enabled", "remnawave_enabled", "remnawave_revoke_link_telegram_notification",
    "notification_webhook_enabled", "topic_rotation_enabled"];
  if (flags.some((key) => typeof values[key] !== "boolean")) return false;
  if (!integer(values.support_group_id) || !["external_id", "email"].includes(values.web_identity_mode)) return false;
  const counts = { user_messages_per_minute: 1, user_messages_per_hour: 1, topic_rotation_delay_seconds: 1,
    archive_retention_days: 1, archive_media_compress_after_days: 1, archive_media_retention_days: 1 };
  if (Object.entries(counts).some(([key, min]) => !integer(values[key]) || values[key] < min)) return false;
  const limits = { topic_rotation_message_limit: 1, topic_rotation_topic_limit: 3, topic_rotation_topic_reserve: 1 };
  if (Object.entries(limits).some(([key, min]) => values[key] !== null && (!integer(values[key]) || values[key] < min))) return false;
  if ((values.topic_rotation_topic_limit ?? 250) - 2 * (values.topic_rotation_topic_reserve ?? 25) < 1) return false;
  if (!(values.archive_media_compress_after_days < values.archive_media_retention_days
    && values.archive_media_retention_days <= values.archive_retention_days)) return false;
  if (values.user_messages_per_hour < values.user_messages_per_minute) return false;
  for (const key of ["remnawave_base_url", "notification_webhook_url"]) if (values[key] !== null && !urlOk(values[key])) return false;
  if (values.api_enabled && !secretOk(values.api_admin_token, true)) return false;
  if (values.web_api_enabled && (!secretOk(values.web_api_token, true) || values.web_api_token === values.api_admin_token)) return false;
  if (values.remnawave_enabled && (!values.remnawave_base_url || !secretOk(values.remnawave_api_token, true))) return false;
  if (values.notification_webhook_enabled && (!values.notification_webhook_url || !secretOk(values.notification_webhook_secret, false))) return false;
  return true;
}

/** POST settings (projects.py configure): [status, detail] of a refusal, or null when saved. */
function configure(state, item, values) {
  if (Object.keys(values).some((key) => !PROJECT_FIELDS.has(key))) {
    return [422, "Неизвестные настройки проекта."];
  }
  const merged = { ...DEFAULTS, ...item.settings, ...values };
  if (!settingsValid(merged)) return [422, "Проверьте настройки и ключи интеграций."];
  for (const key of ["remnawave_base_url", "notification_webhook_url"]) {
    if (merged[key] && (new URL(merged[key]).protocol !== "https:" || new URL(merged[key]).hostname === "localhost")) {
      return [422, "Интеграциям нужен публичный HTTPS-адрес."];
    }
  }
  if (!(merged.support_group_id >= -MAX_ID && merged.support_group_id <= 0)) return [422, "Укажите отрицательный ID группы Telegram."];
  const token = merged.support_bot_token ?? "";
  if (token && !BOT_TOKEN.test(token)) return [422, "Неверный формат токена Telegram-бота."];
  const bot = token ? Number(token.split(":")[0]) : null;
  const group = merged.support_group_id || null;
  if ((item.bot_id !== null && bot !== item.bot_id) || (item.group_id !== null && group !== item.group_id)) {
    return [409, "Бот и группа закреплены за проектом. Для другого канала создайте проект."];
  }
  if (state.projects.some((other) => other !== item && ((bot !== null && other.bot_id === bot) || (group !== null && other.group_id === group)))) {
    return [409, "Этот бот, группа или API-ключ уже используется другим проектом."];
  }
  item.settings = merged;
  item.bot_id = bot;
  item.group_id = group;
  item.revision++;
  return null;
}

function stored(item) {
  return Object.fromEntries(Object.entries(item.settings).map(([key, value]) => [key, SECRET_FIELDS.includes(key) ? Boolean(value) : value]));
}

const PNG = [0x89, 0x50, 0x4e, 0x47];
function imageBytes(content) {
  return content.subarray(0, 4).equals(Buffer.from(PNG)) || (content[0] === 0xff && content[1] === 0xd8)
    || (content.subarray(0, 4).toString("latin1") === "RIFF" && content.subarray(8, 12).toString("latin1") === "WEBP");
}

/**
 * Answers an installation route, or returns false. `onboard(project)` prepares the project runtime
 * data of a new project; `logoBody` is the image served as any project's logo.
 */
export async function handle(state, request, response, path, url, tools) {
  const { json, send, readBody } = tools;
  const routes = /^\/console\/(projects(?:\/[^/]+\/(?:members(?:\/remove)?|member-candidates|admin|active|settings|logo(?:\/remove)?))?|accounts(?:\/[^/]+(?:\/(?:enable|disable|password|identity\/telegram))?)?|password|installation\/admin)$/;
  if (!routes.test(path)) return false;
  const done = (status, value, headers) => (json(response, status, value, headers), true);
  if (!tools.hasSession(request)) return done(401, { detail: "Войдите в панель." });
  const actor = current(state);
  const post = request.method === "POST";
  const body = post ? await readBody(request) : Buffer.alloc(0);
  const data = () => {
    try {
      return JSON.parse(body.toString("utf8") || "{}");
    } catch {
      return {};
    }
  };
  const owner = actor.role === "admin";
  const invalid = () => done(422, { detail: "Проверьте введённые данные." });
  const byLogin = (login) => state.accounts.find((item) => item.login === String(login ?? "").trim().toLowerCase());
  let match;

  if (path === "/console/projects" && request.method === "GET") {
    const visible = state.projects.filter((item) => owner || member(item, actor));
    return done(200, visible.map((item) => projectView(item, actor)));
  }
  if (path === "/console/projects" && post) {
    const { name, admin_login: adminLogin } = data();
    if (!text(name, 1, 100) || !text(adminLogin, 3, 64)) return invalid();
    if (!owner) return done(403, { detail: "Требуются права администратора установки." });
    const admin = byLogin(adminLogin);
    if (!admin?.active) return done(404, { detail: "Активная учётная запись с таким логином не найдена." });
    if (!name.trim()) return done(422, { detail: "Укажите название проекта." });
    const created = { id: randomUUID(), name: name.trim(), admin_id: admin.id, members: new Set(), active: false, logo: null,
      revision: 0, settings: {}, bot_id: null, group_id: null };
    state.projects.push(created);
    tools.onboard(created.id);
    return done(200, { id: created.id });
  }
  if ((match = /^\/console\/projects\/([^/]+)\/(.+)$/.exec(path))) {
    const [, id, rest] = match;
    const item = state.projects.find((entry) => entry.id === id);
    const manager = item && (owner || item.admin_id === actor.id);
    if (rest === "logo" && request.method === "GET") {
      if (!item || !member(item, actor)) return done(item ? 403 : 404, { detail: item ? "Нет доступа к проекту." : "Проект недоступен." });
      if (!item.logo) return done(404, { detail: "Логотип не задан." });
      return send(response, 200, { ...tools.headers.api, "content-type": "image/png" }, tools.logoBody), true;
    }
    if (rest === "members" && request.method === "GET") {
      if (!manager) return done(403, { detail: "Недостаточно прав." });
      const rows = state.accounts.filter((entry) => entry.id === item.admin_id || item.members.has(entry.id))
        .sort((a, b) => a.login.localeCompare(b.login))
        .map((entry) => ({ ...accountView(entry), role: entry.id === item.admin_id ? "admin" : "operator" }));
      return done(200, rows);
    }
    if (rest === "member-candidates" && request.method === "GET") {
      const query = (url.searchParams.get("q") ?? "").trim().toLowerCase();
      if (query.length > 100) return invalid();
      if (!manager) return done(403, { detail: "Недостаточно прав." });
      const rows = state.accounts
        .filter((entry) => entry.active && entry.id !== item.admin_id && !item.members.has(entry.id))
        .filter((entry) => !query || entry.login.includes(query) || entry.name.toLowerCase().includes(query))
        .sort((a, b) => a.login.localeCompare(b.login)).slice(0, 50)
        .map((entry) => ({ id: entry.id, login: entry.login, name: entry.name }));
      return done(200, rows);
    }
    if ((rest === "members" || rest === "members/remove") && post) {
      const { login } = data();
      if (!text(login, 3, 64)) return invalid();
      if (!manager) return done(403, { detail: "Недостаточно прав." });
      const remove = rest === "members/remove";
      const target = byLogin(login);
      if (!target || (!remove && !target.active)) return done(404, { detail: "Учётная запись недоступна." });
      if (item.admin_id === target.id) return done(409, { detail: "Сначала передайте управление проектом." });
      if (remove) item.members.delete(target.id);
      else item.members.add(target.id);
      return done(200, { ok: true });
    }
    if (rest === "admin" && post) {
      const { login } = data();
      if (!text(login, 3, 64)) return invalid();
      if (!owner) return done(403, { detail: "Требуются права администратора установки." });
      const target = byLogin(login);
      if (!target?.active) return done(404, { detail: "Активная учётная запись с таким логином не найдена." });
      if (!item) return done(404, { detail: "Проект не найден." });
      item.members.delete(item.admin_id);
      item.members.delete(target.id);
      item.admin_id = target.id;
      return done(200, { ok: true });
    }
    if (rest === "active" && post) {
      const { active } = data();
      if (typeof active !== "boolean") return invalid();
      if (!item) return done(404, { detail: "Проект не найден." });
      if (!owner) return done(403, { detail: "Недостаточно прав." });
      if (active && (item.bot_id === null || item.group_id === null)) {
        return done(409, { detail: "Администратор проекта должен сначала настроить бота и группу." });
      }
      item.active = active;
      item.revision++;
      return done(200, { ok: true });
    }
    // Connections and the logo belong to the project administrator alone.
    if (!item) return done(404, { detail: "Проект не найден." });
    if (item.admin_id !== actor.id) return done(403, { detail: "Недостаточно прав." });
    if (rest === "settings" && request.method === "GET") return done(200, stored(item));
    if (rest === "settings" && post) {
      const { settings } = data();
      if (!settings || typeof settings !== "object" || Array.isArray(settings) || Object.keys(settings).length > 40) return invalid();
      const refused = configure(state, item, settings);
      return refused ? done(refused[0], { detail: refused[1] }) : done(200, { ok: true });
    }
    if (rest === "logo" && post) {
      if (Number(request.headers["content-length"] ?? 0) > MAX_LOGO + 65536) return done(413, { detail: "Неверный размер запроса." });
      const { fields, files } = multipart(body, request.headers["content-type"]);
      if (files.length !== 1 || files[0].name !== "file" || Object.keys(fields).length) return done(422, { detail: "Прикрепите один логотип." });
      const [file] = files;
      if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) return done(422, { detail: "Логотип: PNG, JPEG или WebP до 2 МБ." });
      if (!file.size || file.size > MAX_LOGO) return done(422, { detail: "Логотип пустой или больше 2 МБ." });
      if (!imageBytes(file.content)) return done(422, { detail: "Изображение не прошло проверку. Используйте PNG, JPEG или WebP." });
      item.logo = createHash("sha256").update(file.content).digest("hex");
      return done(200, { logo: item.logo });
    }
    if (rest === "logo/remove" && post) {
      item.logo = null;
      return done(200, { ok: true });
    }
    return false;
  }

  if (path === "/console/password" && post) {
    const { current_password: currentPassword, new_password: next } = data();
    if (!text(currentPassword, 1, 128) || !text(next, 12, 128)) return invalid();
    if (currentPassword !== actor.password) return done(403, { detail: "Неверный текущий пароль вашего аккаунта." });
    actor.password = next;
    state.session = null;
    return done(200, { ok: true }, { "set-cookie": "resolvate_session=; Path=/console; Max-Age=0; HttpOnly; SameSite=Strict" });
  }
  if (path === "/console/installation/admin" && post) {
    const { login } = data();
    if (!text(login, 3, 64)) return invalid();
    if (!owner) return done(403, { detail: "Требуются права администратора установки." });
    const target = byLogin(login);
    if (!target?.active) return done(404, { detail: "Активная учётная запись с таким логином не найдена." });
    actor.role = "operator";
    target.role = "admin";
    state.session = null;
    return done(200, { ok: true });
  }
  // The Telegram ID route checks the role in the service; the other account routes require the
  // installation administrator before anything else (console.py Admin).
  const identity = /^\/console\/accounts\/([^/]+)\/identity\/telegram$/.exec(path);
  if (identity && post) {
    const { telegram_id: telegramId = null } = data();
    if (telegramId !== null && (!integer(telegramId) || telegramId < 1 || telegramId > MAX_ID)) return invalid();
    if (!owner) return done(403, { detail: "Требуются права администратора установки." });
    const target = state.accounts.find((item) => item.id === identity[1]);
    if (!target) return done(404, { detail: "Аккаунт не найден." });
    if (telegramId !== null && state.accounts.some((item) => item !== target && item.telegram_id === telegramId)) {
      return done(409, { detail: "Этот Telegram ID уже используется." });
    }
    target.telegram_id = telegramId;
    return done(200, { ok: true });
  }
  if (!owner) return done(403, { detail: "Требуются права администратора." });
  if (path === "/console/accounts" && request.method === "GET") {
    return done(200, [...state.accounts].sort((a, b) => a.login.localeCompare(b.login)).map(accountView));
  }
  if (path === "/console/accounts" && post) {
    const { login, name, password, role = "operator", telegram_id: telegramId = null } = data();
    if (!text(login, 1, 64) || !text(name, 1, 100) || !text(password, 12, 128) || !["admin", "operator"].includes(role)
      || (telegramId !== null && (!integer(telegramId) || telegramId < 1 || telegramId > MAX_ID))) return invalid();
    const normalized = login.trim().toLowerCase();
    if (!LOGIN.test(normalized)) return done(422, { detail: "Логин: 3–64 символа, латиница, цифры, точка, _ или -." });
    if (!name.trim()) return done(422, { detail: "Проверьте имя и роль." });
    if (role === "admin") return done(409, { detail: "Администратор установки один. Используйте передачу полномочий." });
    if (state.accounts.some((item) => item.login === normalized || (telegramId !== null && item.telegram_id === telegramId))) {
      return done(409, { detail: "Логин или Telegram ID уже используется." });
    }
    const created = person(randomUUID(), normalized, name.trim(), { telegram_id: telegramId, password });
    state.accounts.push(created);
    return done(200, accountView(created));
  }
  if ((match = /^\/console\/accounts\/([^/]+)\/password$/.exec(path)) && post) {
    const { current_password: currentPassword, new_password: next } = data();
    if (!text(currentPassword, 1, 128) || !text(next, 12, 128)) return invalid();
    if (currentPassword !== actor.password) return done(403, { detail: "Неверный текущий пароль вашего аккаунта." });
    const target = state.accounts.find((item) => item.id === match[1]);
    if (!target) return done(404, { detail: "Учётная запись не найдена." });
    target.password = next;
    if (target === actor) state.session = null;
    return done(200, { ok: true });
  }
  if ((match = /^\/console\/accounts\/([^/]+)\/(enable|disable)$/.exec(path)) && post) {
    const target = state.accounts.find((item) => item.id === match[1]);
    if (!target) return done(404, { detail: "Учётная запись не найдена." });
    const enable = match[2] === "enable";
    if (!enable && target.active && target.role === "admin"
      && state.accounts.filter((item) => item.active && item.role === "admin").length <= 1) {
      return done(409, { detail: "Нельзя отключить последнего администратора." });
    }
    if (!enable && state.projects.some((item) => item.admin_id === target.id)) {
      return done(409, { detail: "Сначала передайте управление проектами этого аккаунта." });
    }
    target.active = enable;
    return done(200, { ok: true });
  }
  return false;
}

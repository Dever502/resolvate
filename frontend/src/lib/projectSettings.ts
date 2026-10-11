// The connections form of a project: the fields of PROJECT_FIELDS (src/resolvate/projects.py) with
// the defaults and rules of Settings (src/resolvate/config.py). The server checks everything again;
// the checks here only name the field and the reason before a request is sent.
import type { ProjectSettings } from "../api/types";

export type SettingKind = "secret" | "group" | "url" | "toggle" | "count" | "limit" | "identity";

export interface SettingField {
  key: string;
  label: string;
  kind: SettingKind;
  hint?: string;
  /** The smallest allowed number. */
  min?: number;
}

export interface SettingSection {
  title: string;
  /** Limits and retention rather than connections: shown under "Дополнительно". */
  advanced?: boolean;
  fields: SettingField[];
}

export const IDENTITY_MODES = [
  { value: "external_id", label: "ID на вашем сайте" },
  { value: "email", label: "Email" },
];

const KEY_RULE = "Не короче 32 символов: латиница, цифры и знаки без пробелов.";

export const SETTING_SECTIONS: SettingSection[] = [
  {
    title: "Telegram",
    fields: [
      { key: "support_bot_token", label: "Токен бота", kind: "secret", hint: "Выдаёт @BotFather, например 123456789:AA…" },
      { key: "support_group_id", label: "ID группы поддержки", kind: "group", hint: "Отрицательный ID супергруппы, например -1001234567890." },
    ],
  },
  {
    title: "API для вашего сайта",
    fields: [
      { key: "web_api_enabled", label: "Принимать обращения через Web API", kind: "toggle" },
      { key: "web_api_token", label: "Ключ Web API", kind: "secret", hint: `${KEY_RULE} Хранится на сервере сайта, не в браузере клиента.` },
      { key: "web_identity_mode", label: "Идентификация клиентов", kind: "identity", hint: "После первого обращения через Web API режим не меняется." },
    ],
  },
  {
    title: "Operator API",
    fields: [
      { key: "api_enabled", label: "Разрешить Operator API", kind: "toggle" },
      { key: "api_admin_token", label: "Ключ Operator API", kind: "secret", hint: `${KEY_RULE} Отличается от ключа Web API.` },
    ],
  },
  {
    title: "Remnawave",
    fields: [
      { key: "remnawave_enabled", label: "Включить интеграцию", kind: "toggle" },
      { key: "remnawave_base_url", label: "Адрес панели", kind: "url", hint: "Публичный HTTPS-адрес панели без /api." },
      { key: "remnawave_api_token", label: "Ключ API", kind: "secret", hint: KEY_RULE },
      { key: "remnawave_revoke_link_telegram_notification", label: "Отправлять клиенту новую ссылку в Telegram после /revokelink", kind: "toggle" },
    ],
  },
  {
    title: "Webhook уведомлений",
    fields: [
      { key: "notification_webhook_enabled", label: "Отправлять события", kind: "toggle" },
      { key: "notification_webhook_url", label: "Адрес получателя", kind: "url", hint: "Публичный HTTPS-адрес." },
      { key: "notification_webhook_secret", label: "Секрет подписи HMAC-SHA256", kind: "secret", hint: "Не короче 32 символов." },
    ],
  },
  {
    title: "Сообщения клиентов",
    advanced: true,
    fields: [
      { key: "user_messages_per_minute", label: "Не больше сообщений в минуту", kind: "count", min: 1 },
      { key: "user_messages_per_hour", label: "Не больше сообщений в час", kind: "count", min: 1 },
    ],
  },
  {
    title: "Темы группы поддержки",
    advanced: true,
    fields: [
      { key: "topic_rotation_enabled", label: "Ротация тем закрытых обращений", kind: "toggle" },
      { key: "topic_rotation_message_limit", label: "Сообщений в теме до замены", kind: "limit", min: 1, hint: "Пусто — 2500." },
      { key: "topic_rotation_topic_limit", label: "Предел тем в группе", kind: "limit", min: 3, hint: "Пусто — 250." },
      { key: "topic_rotation_topic_reserve", label: "Запас тем до предела", kind: "limit", min: 1, hint: "Очистка закрытых тем начинается за столько тем до предела. Пусто — 25." },
      { key: "topic_rotation_delay_seconds", label: "Пауза после закрытия, секунд", kind: "count", min: 1, hint: "Раньше тема закрытого обращения не трогается." },
    ],
  },
  {
    title: "Хранение архива",
    advanced: true,
    fields: [
      { key: "archive_retention_days", label: "Хранить переписку, дней", kind: "count", min: 1, hint: "После уменьшения срока более старая переписка удаляется при следующей очистке." },
      { key: "archive_media_retention_days", label: "Хранить файлы, дней", kind: "count", min: 1, hint: "Не больше срока хранения переписки." },
      { key: "archive_media_compress_after_days", label: "Сжимать фото и видео через, дней", kind: "count", min: 1, hint: "Меньше срока хранения файлов." },
    ],
  },
];

export const SETTING_FIELDS = SETTING_SECTIONS.flatMap((section) => section.fields);

/** What Settings uses for a field that was never saved (src/resolvate/config.py). */
const DEFAULTS: ProjectSettings = {
  support_group_id: 0,
  web_api_enabled: false,
  web_identity_mode: "external_id",
  api_enabled: false,
  remnawave_enabled: false,
  remnawave_base_url: null,
  remnawave_revoke_link_telegram_notification: true,
  notification_webhook_enabled: false,
  notification_webhook_url: null,
  user_messages_per_minute: 30,
  user_messages_per_hour: 200,
  topic_rotation_enabled: true,
  topic_rotation_message_limit: null,
  topic_rotation_topic_limit: null,
  topic_rotation_topic_reserve: null,
  topic_rotation_delay_seconds: 300,
  archive_retention_days: 60,
  archive_media_retention_days: 30,
  archive_media_compress_after_days: 14,
};
// An empty topic limit or reserve means these (config.py, without AI).
const AUTO_TOPIC_LIMIT = 250;
const AUTO_TOPIC_RESERVE = 25;
const MAX_ID = 2 ** 52 - 1;
const BOT_TOKEN = /^[1-9][0-9]{0,18}:[A-Za-z0-9_-]{20,200}$/;
const GROUP_ID = /^(?:-[0-9]+|0)$/;
const INTEGER = /^[0-9]+$/;
const PRINTABLE = /^[!-~]+$/;
const ASCII_KEYS = new Set(["web_api_token", "api_admin_token", "remnawave_api_token"]);
const MIN_SECRET = 32;

/** Values as the inputs hold them: text, or a flag for a switch. Secrets start empty. */
export type SettingsForm = Record<string, string | boolean>;

export function formFrom(saved: ProjectSettings): SettingsForm {
  const form: SettingsForm = {};
  for (const field of SETTING_FIELDS) {
    const value = saved[field.key] ?? DEFAULTS[field.key] ?? null;
    if (field.kind === "secret") form[field.key] = "";
    else if (field.kind === "toggle") form[field.key] = Boolean(value);
    // 0 is "no group yet": the field stays empty and shows its placeholder.
    else if (field.kind === "group") form[field.key] = value ? String(value) : "";
    else form[field.key] = value === null ? "" : String(value);
  }
  return form;
}

/** The body of POST settings: an empty secret keeps the stored one, as on the server. */
export function payloadFrom(form: SettingsForm): ProjectSettings {
  const payload: ProjectSettings = {};
  for (const field of SETTING_FIELDS) {
    const value = form[field.key];
    const text = String(value ?? "").trim();
    if (field.kind === "toggle") payload[field.key] = Boolean(value);
    else if (field.kind === "secret") {
      if (value) payload[field.key] = String(value);
    } else if (field.kind === "group") payload[field.key] = text ? Number(text) : 0;
    else if (field.kind === "count") payload[field.key] = Number(text);
    else if (field.kind === "limit") payload[field.key] = text ? Number(text) : null;
    else if (field.kind === "url") payload[field.key] = text || null;
    else payload[field.key] = text;
  }
  return payload;
}

function urlProblem(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "Укажите полный адрес, например https://example.com.";
  }
  if (url.protocol !== "https:") return "Нужен адрес HTTPS.";
  if (url.username || url.password) return "Адрес не должен содержать логин и пароль.";
  if (url.hash) return "Адрес не должен содержать #фрагмент.";
  if (url.hostname === "localhost" || url.hostname.endsWith(".localhost")) return "Нужен публичный адрес.";
  return "";
}

/** Problems by field key; empty when the form can be sent. `saved` tells which secrets are stored. */
export function validate(form: SettingsForm, saved: ProjectSettings): Record<string, string> {
  const errors: Record<string, string> = {};
  const text = (key: string) => String(form[key] ?? "").trim();
  const keyKnown = (key: string) => Boolean(form[key]) || saved[key] === true;
  for (const field of SETTING_FIELDS) {
    const raw = String(form[field.key] ?? "");
    const value = raw.trim();
    if (field.kind === "secret" && raw) {
      if (field.key === "support_bot_token") {
        if (!BOT_TOKEN.test(raw) || Number(raw.split(":")[0]) > MAX_ID) {
          errors[field.key] = "Неверный формат токена: номер бота, двоеточие и ключ от 20 символов.";
        }
      } else if ([...raw].length < MIN_SECRET || raw !== value) {
        errors[field.key] = "Не короче 32 символов, без пробелов по краям.";
      } else if (ASCII_KEYS.has(field.key) && !PRINTABLE.test(raw)) {
        errors[field.key] = "Только латиница, цифры и знаки, без пробелов.";
      }
    } else if (field.kind === "group" && value) {
      if (!GROUP_ID.test(value) || Math.abs(Number(value)) > MAX_ID) {
        errors[field.key] = "Нужен отрицательный ID супергруппы, например -1001234567890.";
      }
    } else if (field.kind === "url" && value) {
      const problem = urlProblem(value);
      if (problem) errors[field.key] = problem;
    } else if (field.kind === "count" || (field.kind === "limit" && value)) {
      const min = field.min ?? 1;
      if (!INTEGER.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < min) {
        errors[field.key] = `Целое число не меньше ${min}.`;
      }
    }
  }
  // A switched-on integration needs its address and key (config.py).
  const need = (key: string, known: boolean, message: string) => {
    if (!known && !errors[key]) errors[key] = message;
  };
  if (form.web_api_enabled) need("web_api_token", keyKnown("web_api_token"), "Нужен ключ, чтобы принимать обращения через Web API.");
  if (form.api_enabled) need("api_admin_token", keyKnown("api_admin_token"), "Нужен ключ, чтобы включить Operator API.");
  if (form.remnawave_enabled) {
    need("remnawave_base_url", Boolean(text("remnawave_base_url")), "Нужен адрес, чтобы включить интеграцию.");
    need("remnawave_api_token", keyKnown("remnawave_api_token"), "Нужен ключ, чтобы включить интеграцию.");
  }
  if (form.notification_webhook_enabled) {
    need("notification_webhook_url", Boolean(text("notification_webhook_url")), "Нужен адрес, чтобы отправлять события.");
    need("notification_webhook_secret", keyKnown("notification_webhook_secret"), "Нужен секрет, чтобы отправлять события.");
  }
  if (form.web_api_token && form.web_api_token === form.api_admin_token && !errors.api_admin_token) {
    errors.api_admin_token = "Ключи Web API и Operator API должны различаться.";
  }
  const number = (key: string, fallback = 0) => (text(key) ? Number(text(key)) : fallback);
  const valid = (...keys: string[]) => keys.every((key) => !errors[key]);
  if (valid("user_messages_per_minute", "user_messages_per_hour")
    && number("user_messages_per_hour") < number("user_messages_per_minute")) {
    errors.user_messages_per_hour = "Не меньше, чем в минуту.";
  }
  if (valid("topic_rotation_topic_limit", "topic_rotation_topic_reserve")
    && number("topic_rotation_topic_limit", AUTO_TOPIC_LIMIT) - 2 * number("topic_rotation_topic_reserve", AUTO_TOPIC_RESERVE) < 1) {
    errors.topic_rotation_topic_reserve = "Предел тем должен быть больше двух запасов.";
  }
  if (valid("archive_media_compress_after_days", "archive_media_retention_days")
    && number("archive_media_compress_after_days") >= number("archive_media_retention_days")) {
    errors.archive_media_compress_after_days = "Сжатие должно начинаться раньше, чем удаляются файлы.";
  }
  if (valid("archive_media_retention_days", "archive_retention_days")
    && number("archive_media_retention_days") > number("archive_retention_days")) {
    errors.archive_media_retention_days = "Файлы не могут храниться дольше переписки.";
  }
  return errors;
}

import { describe, expect, it } from "vitest";
import { SETTING_FIELDS, formFrom, payloadFrom, validate } from "./projectSettings";

const TOKEN = "123456789:AAAAAAAAAAAAAAAAAAAAAAAA";
const KEY = "k".repeat(32);

describe("project settings form", () => {
  it("covers exactly the project fields of the server (projects.py PROJECT_FIELDS)", () => {
    expect(SETTING_FIELDS.map((field) => field.key).sort()).toEqual([
      "api_admin_token", "api_enabled", "archive_media_compress_after_days", "archive_media_retention_days",
      "archive_retention_days", "notification_webhook_enabled", "notification_webhook_secret", "notification_webhook_url",
      "remnawave_api_token", "remnawave_base_url", "remnawave_enabled", "remnawave_revoke_link_telegram_notification",
      "support_bot_token", "support_group_id", "topic_rotation_delay_seconds", "topic_rotation_enabled",
      "topic_rotation_message_limit", "topic_rotation_topic_limit", "topic_rotation_topic_reserve", "user_messages_per_hour",
      "user_messages_per_minute", "web_api_enabled", "web_api_token", "web_identity_mode",
    ]);
  });

  it("fills a never saved project with the server defaults and never shows a stored secret", () => {
    const empty = formFrom({});
    expect(empty).toMatchObject({
      support_bot_token: "", support_group_id: "", web_identity_mode: "external_id", api_enabled: false,
      remnawave_revoke_link_telegram_notification: true, user_messages_per_minute: "30", user_messages_per_hour: "200",
      topic_rotation_enabled: true, topic_rotation_topic_limit: "", topic_rotation_delay_seconds: "300",
      archive_retention_days: "60", archive_media_retention_days: "30", archive_media_compress_after_days: "14",
    });
    const saved = formFrom({ support_bot_token: true, support_group_id: -1001234567890, web_api_enabled: true, topic_rotation_topic_limit: 120 });
    expect(saved).toMatchObject({ support_bot_token: "", support_group_id: "-1001234567890", web_api_enabled: true, topic_rotation_topic_limit: "120" });
  });

  it("sends numbers as numbers, empty optional values as null, and a secret only when it was typed", () => {
    const form = formFrom({ support_bot_token: true });
    form.support_group_id = " -1001234567890 ";
    form.topic_rotation_topic_limit = "";
    form.notification_webhook_url = "  ";
    form.api_admin_token = KEY;
    const payload = payloadFrom(form);
    expect(payload).not.toHaveProperty("support_bot_token");
    expect(payload).toMatchObject({
      support_group_id: -1001234567890, topic_rotation_topic_limit: null, notification_webhook_url: null,
      api_admin_token: KEY, user_messages_per_minute: 30, api_enabled: false, web_identity_mode: "external_id",
    });
    expect(payloadFrom(formFrom({})).support_group_id).toBe(0);
  });

  it("names the field and the reason for formats the server would refuse", () => {
    const form = formFrom({});
    Object.assign(form, {
      web_api_enabled: true, api_enabled: true,
      support_bot_token: "12345:short", support_group_id: "1001", remnawave_base_url: "http://panel.example.com",
      notification_webhook_url: "https://user:pass@hooks.example.com", web_api_token: "кириллица".repeat(4),
      api_admin_token: " padded-key-of-thirty-two-chars-plus ", topic_rotation_topic_limit: "2", user_messages_per_minute: "0",
    });
    const errors = validate(form, {});
    expect(errors).toEqual({
      support_bot_token: "Неверный формат токена: номер бота, двоеточие и ключ от 20 символов.",
      support_group_id: "Нужен отрицательный ID супергруппы, например -1001234567890.",
      remnawave_base_url: "Нужен адрес HTTPS.",
      notification_webhook_url: "Адрес не должен содержать логин и пароль.",
      web_api_token: "Только латиница, цифры и знаки, без пробелов.",
      api_admin_token: "Не короче 32 символов, без пробелов по краям.",
      topic_rotation_topic_limit: "Целое число не меньше 3.",
      user_messages_per_minute: "Целое число не меньше 1.",
    });
    expect(validate({ ...formFrom({}), support_bot_token: TOKEN, support_group_id: "-1001234567890" }, {})).toEqual({});
  });

  it("checks a key only for a switched-on integration, as the server does, including placeholders", () => {
    const keys = { web_api_token: "short", api_admin_token: "secret".repeat(6), notification_webhook_secret: " x " };
    expect(validate({ ...formFrom({}), ...keys }, {})).toEqual({});
    expect(validate({ ...formFrom({}), ...keys, api_enabled: true }, {}))
      .toEqual({ api_admin_token: "Похоже на заглушку: задайте настоящий ключ." });
    expect(validate({ ...formFrom({}), api_enabled: true, api_admin_token: "your-token-your-token-your-token__" }, {}))
      .toEqual({ api_admin_token: "Похоже на заглушку: задайте настоящий ключ." });
    expect(validate({ ...formFrom({}), api_enabled: true, api_admin_token: "a-real-operator-api-key-0123456789" }, {})).toEqual({});
  });

  it("refuses server names the backend would refuse, and only the bare localhost", () => {
    const url = (value: string) => validate({ ...formFrom({}), notification_webhook_url: value }, {}).notification_webhook_url;
    expect(url("https://hooks_bad.example.com")).toBe("Неверное имя сервера в адресе.");
    expect(url("https://localhost/hook")).toBe("Нужен публичный адрес.");
    expect(url("https://hooks.example.com./path")).toBeUndefined();
    expect(url("https://[2001:db8::1]/hook")).toBeUndefined();
    expect(url("https://пример.рф/hook")).toBeUndefined();
  });

  it("asks for the key and address of a switched-on integration unless the server already stores the key", () => {
    const form = { ...formFrom({}), web_api_enabled: true, api_enabled: true, remnawave_enabled: true, notification_webhook_enabled: true };
    expect(validate(form, {})).toEqual({
      web_api_token: "Нужен ключ, чтобы принимать обращения через Web API.",
      api_admin_token: "Нужен ключ, чтобы включить Operator API.",
      remnawave_base_url: "Нужен адрес, чтобы включить интеграцию.",
      remnawave_api_token: "Нужен ключ, чтобы включить интеграцию.",
      notification_webhook_url: "Нужен адрес, чтобы отправлять события.",
      notification_webhook_secret: "Нужен секрет, чтобы отправлять события.",
    });
    const stored = { web_api_token: true, api_admin_token: true, remnawave_api_token: true, notification_webhook_secret: true };
    expect(validate({ ...form, remnawave_base_url: "https://panel.example.com", notification_webhook_url: "https://hooks.example.com" }, stored)).toEqual({});
    expect(validate({ ...formFrom({}), web_api_enabled: true, web_api_token: KEY, api_admin_token: KEY }, {}))
      .toEqual({ api_admin_token: "Ключи Web API и Operator API должны различаться." });
  });

  it("keeps the rules between fields: limits, topic reserve and archive retention", () => {
    const base = formFrom({});
    expect(validate({ ...base, user_messages_per_minute: "50", user_messages_per_hour: "40" }, {}))
      .toEqual({ user_messages_per_hour: "Не меньше, чем в минуту." });
    expect(validate({ ...base, topic_rotation_topic_limit: "50" }, {}))
      .toEqual({ topic_rotation_topic_reserve: "Предел тем должен быть больше двух запасов." });
    expect(validate({ ...base, topic_rotation_topic_limit: "51" }, {})).toEqual({});
    expect(validate({ ...base, archive_media_compress_after_days: "30" }, {}))
      .toEqual({ archive_media_compress_after_days: "Сжатие должно начинаться раньше, чем удаляются файлы." });
    expect(validate({ ...base, archive_media_retention_days: "61" }, {}))
      .toEqual({ archive_media_retention_days: "Файлы не могут храниться дольше переписки." });
  });
});

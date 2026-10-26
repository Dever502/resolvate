import { describe, expect, it } from "vitest";
import type { TicketDetail } from "../api/types";
import { customerFields } from "./customerFields";

const base: TicketDetail = {
  id: "t1", display_name: "Анна", username: null, channel: "telegram", status: "open", email: null,
  identity_provider: "telegram", identity_value: "100001", remnawave_user_uuid: null,
  created_at: "2026-10-01T10:00:00Z", folder_id: null, folder_revision: 0,
};
const labels = (detail: TicketDetail | null) => customerFields(detail, {}).map(([label]) => label);
const value = (detail: TicketDetail, label: string) => customerFields(detail, {}).find(([name]) => name === label)?.[1];

describe("customerFields", () => {
  it("names a Telegram user's ID", () => {
    expect(value(base, "Telegram ID")).toBe("100001");
    expect(labels(base)).not.toContain("Идентификатор");
  });

  it("names a site's own customer ID, never as a Telegram ID", () => {
    const detail = { ...base, channel: "web" as const, identity_provider: "web_external_id" as const, identity_value: "crm-42" };
    expect(value(detail, "Внешний ID")).toBe("crm-42");
    expect(labels(detail)).not.toContain("Telegram ID");
  });

  it("an email identity is the Email row once, also when the detail has no email of its own", () => {
    const both = { ...base, channel: "web" as const, email: "Boris@Example.com", identity_provider: "web_email" as const, identity_value: "boris@example.com" };
    expect(customerFields(both, {}).filter(([label]) => label === "Email")).toEqual([["Email", "Boris@Example.com"]]);
    expect(labels(both)).not.toContain("Идентификатор");
    const only = { ...both, email: null };
    expect(value(only, "Email")).toBe("boris@example.com");
  });

  it("an unknown provider keeps a neutral name; no identity, no row", () => {
    const unknown = { ...base, identity_provider: "sso" as unknown as TicketDetail["identity_provider"], identity_value: "u-7" };
    expect(value(unknown, "Идентификатор")).toBe("u-7");
    expect(labels(unknown)).not.toContain("Telegram ID");
    expect(labels({ ...base, identity_value: null })).toEqual(["Имя", "Канал", "Первое обращение"]);
    expect(labels({ ...base, identity_value: "" })).not.toContain("Telegram ID");
  });

  it("keeps the Remnawave ID and the order of the rows", () => {
    const detail = { ...base, username: "anna", remnawave_user_uuid: "8c2f6a7e-1111-4222-8333-944445555666" };
    expect(labels(detail)).toEqual(["Имя", "Канал", "Username", "Telegram ID", "Remnawave ID", "Первое обращение"]);
    expect(value(detail, "Remnawave ID")).toBe("8c2f6a7e-1111-4222-8333-944445555666");
  });

  it("before the detail only what the dialogue opened with, nothing standing in for the rest", () => {
    expect(customerFields(null, { display_name: "Анна", channel: "telegram" })).toEqual([["Имя", "Анна"], ["Канал", "Telegram"]]);
  });
});

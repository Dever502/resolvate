import type { TicketDetail, TicketHeading } from "../api/types";
import { channelName } from "./format";

export type CustomerField = [label: string, value: string];

/**
 * The identity the dialogue's customer came with, named by its provider (UserIdentity.provider, as the server
 * returns it with the ticket): a Telegram user's ID, a site's own customer ID, or an email, which the card shows as
 * the Email. An unknown provider keeps a neutral name: its value is never passed off as a Telegram ID.
 */
function identity(detail: TicketDetail, email: string | null): CustomerField | null {
  const value = detail.identity_value;
  if (!value) return null;
  switch (detail.identity_provider) {
    case "telegram":
      return ["Telegram ID", value];
    case "web_external_id":
      return ["Внешний ID", value];
    case "web_email":
      // The Email row says it already (or says this one when the detail has no email of its own).
      return email && email.toLowerCase() !== value.toLowerCase() ? ["Идентификатор", value] : null;
    default:
      return ["Идентификатор", value];
  }
}

/**
 * What the customer card lists, in order: nothing empty, nothing twice. Before the detail comes only what the
 * dialogue opened with (its list row) is shown; nothing stands in for what is not loaded yet.
 */
export function customerFields(detail: TicketDetail | null, heading: TicketHeading): CustomerField[] {
  const known = detail ?? heading;
  const email = detail?.email || (detail?.identity_provider === "web_email" ? detail.identity_value : null) || null;
  const all: (readonly [string, string | null | undefined] | null)[] = [
    ["Имя", known.display_name],
    ["Канал", known.channel ? channelName(known.channel) : null],
    ["Username", known.username],
    ["Email", email],
    detail ? identity(detail, detail.email) : null,
    ["Remnawave ID", detail?.remnawave_user_uuid],
    ["Первое обращение", detail?.created_at ? new Date(detail.created_at).toLocaleString("ru") : null],
  ];
  return all.filter((field): field is CustomerField => Boolean(field?.[1]));
}

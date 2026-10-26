import { ApiError } from "../api/client";

/**
 * The lifecycle of one console command (composer/CommandPicker.vue), apart from its view.
 *
 * A changing command gets an idempotency key after the operator confirms it; the key is written to this tab's
 * sessionStorage (the receipt) before the request leaves. The server reserves the key before it runs the action
 * (console_commands.py), so the answer decides what the receipt becomes:
 * - completed (200, status "completed"): the action ran once; the receipt goes, the next command is free;
 * - rejected (an error the server returns before reserving the key: session, rights, ticket, arguments, rate):
 *   nothing ran; the receipt goes and the reason is shown;
 * - unknown (status "unknown", 409, a server error, a lost connection, the deadline): the action may have run;
 *   the receipt stays, its retry sends the same request under the same key, and no other changing command runs
 *   in that dialogue until the operator retries it or explicitly gives it up.
 */

export type Command = { name: string; description: string; arguments: string; mutation: boolean };
export type Outcome = "completed" | "rejected" | "unknown";

/** What this tab keeps of a changing command whose outcome is not settled: never a note's text. */
export interface Receipt {
  fingerprint: string;
  key: string;
  /** Absent in receipts written before this version. */
  command?: string;
  /** The arguments, except a note's text (null): enough to repeat the request after a reload. */
  arguments?: string | null;
}

/** HTTP statuses the console command endpoint returns before it reserves the key: nothing ran. */
const REJECTED = new Set([400, 401, 403, 404, 413, 422, 429]);
/** Arguments that are the operator's own text: never stored in the open. */
const PRIVATE_ARGUMENTS = new Set(["note"]);

export const receiptKey = (scope: string): string => `resolvate.command:${scope}`;

/** The stored receipt of this account, project and dialogue, or null. A record that is not one throws. */
export function readReceipt(storage: Storage, scope: string): Receipt | null {
  const saved = storage.getItem(receiptKey(scope));
  if (!saved) return null;
  const parsed = JSON.parse(saved) as Partial<Receipt> | null;
  if (!parsed || typeof parsed.key !== "string" || typeof parsed.fingerprint !== "string") throw new Error("receipt");
  return parsed as Receipt;
}

export function writeReceipt(storage: Storage, scope: string, receipt: Receipt): void {
  storage.setItem(receiptKey(scope), JSON.stringify(receipt));
}

/** A late response may settle only its own attempt, never a newer receipt in the same dialogue. */
export function removeReceipt(storage: Storage, scope: string, expectedKey?: string): void {
  if (expectedKey !== undefined && readReceipt(storage, scope)?.key !== expectedKey) return;
  storage.removeItem(receiptKey(scope));
}

/** A new receipt for a confirmed changing command. */
export function newReceipt(command: string, argument: string, fingerprint: string): Receipt {
  return { fingerprint, key: crypto.randomUUID(), command, arguments: PRIVATE_ARGUMENTS.has(command) ? null : argument };
}

/** The command text a receipt can repeat without the dialogue's draft, or null (a note, an old receipt). */
export function receiptText(receipt: Receipt): string | null {
  if (!receipt.command || receipt.arguments == null) return null;
  return receipt.arguments ? `/${receipt.command} ${receipt.arguments}` : `/${receipt.command}`;
}

/** SHA-256 of the normalized command text: a receipt is matched by it, the text itself is not kept. */
export async function fingerprint(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The format problem of a command's arguments, as the server checks them, or null. */
export function formatProblem(command: Command, argument: string): string | null {
  const valid = command.name === "gift" ? /^[0-9]{1,4}$/.test(argument) && Number(argument) >= 1
    : command.name === "note" ? Boolean(argument)
      : command.name === "resolvepanel" ? /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\s+(applied|not_applied)$/i.test(argument)
        : !argument;
  return valid ? null : `Формат: /${command.name} ${command.arguments}`.trim();
}

/** What an answer says about the action: an answer of the endpoint, or the error the request failed with. */
export function outcome(answer: { status?: unknown } | null, failure?: unknown): Outcome {
  if (failure === undefined) return answer?.status === "completed" ? "completed" : "unknown";
  return failure instanceof ApiError && REJECTED.has(failure.status) ? "rejected" : "unknown";
}

/** The operator's own words for a short answer: a single line fits a notice; anything longer is read in full. */
export const fitsNotice = (message: string): boolean => message.length <= 120 && !message.includes("\n");

export interface Confirmation {
  title: string;
  description: string;
  confirmLabel: string;
  danger: boolean;
  /** A bulk action: the project's name is typed to confirm it. */
  typeToConfirm?: string;
}

function days(value: number): string {
  const tens = value % 100;
  const ones = value % 10;
  if (tens >= 11 && tens <= 14) return `${value} дней`;
  if (ones === 1) return `${value} день`;
  if (ones >= 2 && ones <= 4) return `${value} дня`;
  return `${value} дней`;
}

/**
 * The confirmation a changing command needs before it runs, or null: reading, a note, closing without a notice and
 * unblocking run on Enter. Texts say what the server does (console_commands.py and the services it calls).
 */
export function confirmation(command: string, argument: string, customer: string, project: string): Confirmation | null {
  const who = customer ? `«${customer}»` : "этого диалога";
  switch (command) {
    case "stop":
      return {
        title: "Закрыть обращение с уведомлением?",
        description: `Обращение клиента ${who} будет закрыто, клиент получит уведомление о закрытии с просьбой оценить поддержку. Отозвать уведомление нельзя.`,
        confirmLabel: "Закрыть и уведомить",
        danger: false,
      };
    case "block":
      return {
        title: "Заблокировать клиента?",
        description: `Клиент ${who} будет заблокирован: его новые сообщения перестанут попадать к операторам, ответы ему не будут отправляться. Обращение не закроется, клиент не получит уведомления. Снять блокировку можно командой /unblock.`,
        confirmLabel: "Заблокировать",
        danger: true,
      };
    case "gift": {
      const amount = days(Number(argument));
      return {
        title: "Продлить подписку?",
        description: `Подписка клиента ${who} в Remnawave будет продлена на ${amount}, клиент получит уведомление. Отменить продление в консоли нельзя.`,
        confirmLabel: `Продлить на ${amount}`,
        danger: false,
      };
    }
    case "resetkey":
      return {
        title: "Перевыпустить ключи подписки?",
        description: `Ключи подписки клиента ${who} в Remnawave будут перевыпущены, прежние перестанут работать. Клиент не получит уведомления. Отменить это нельзя.`,
        confirmLabel: "Перевыпустить ключи",
        danger: true,
      };
    case "revokelink":
      return {
        title: "Перевыпустить ссылку подписки?",
        description: `Прежняя ссылка подписки клиента ${who} станет недействительной, будет создана новая. Новую ссылку клиент получит, если это включено в настройках проекта. Отменить это нельзя.`,
        confirmLabel: "Перевыпустить ссылку",
        danger: true,
      };
    case "resetdevices":
      return {
        title: "Сбросить устройства?",
        description: `Все устройства, привязанные к подписке клиента ${who} в Remnawave, будут удалены. Клиент не получит уведомления. Отменить это нельзя.`,
        confirmLabel: "Сбросить устройства",
        danger: true,
      };
    case "resolvepanel": {
      const [action = "", verdict = ""] = argument.split(/\s+/);
      const applied = verdict.toLowerCase() === "applied";
      return {
        title: "Зафиксировать результат операции?",
        description: `Операция Remnawave ${action} будет вручную отмечена как ${applied ? "выполненная" : "невыполненная"}. Remnawave при этом не вызывается: записывается только ваше решение, оно снимет блокировку новых команд для клиента. Неверная отметка может привести к повтору действия.`,
        confirmLabel: applied ? "Отметить выполненной" : "Отметить невыполненной",
        danger: true,
      };
    }
    case "closeall":
      return {
        title: "Закрыть все обращения проекта?",
        description: `Все открытые обращения проекта «${project}» будут закрыты без уведомления клиентов — не только этот диалог. Чтобы подтвердить, введите название проекта.`,
        confirmLabel: "Закрыть все обращения",
        danger: true,
        typeToConfirm: project,
      };
    default:
      return null;
  }
}

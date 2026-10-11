// Rules of console accounts (src/resolvate/console_auth.py, console.py, project_routes.py). The server
// checks them again; these only name the problem before a request is sent. Lengths count code points,
// as Python's len() does.

const LOGIN = /^[a-z0-9][a-z0-9_.-]{2,63}$/;
const MAX_TELEGRAM_ID = 2 ** 52 - 1;

const length = (value: string) => [...value].length;

export function loginProblem(login: string): string {
  return LOGIN.test(login.trim().toLowerCase()) ? "" : "Логин: 3–64 символа, латиница, цифры, точка, _ или -.";
}

export function nameProblem(name: string): string {
  return length(name.trim()) >= 1 && length(name.trim()) <= 100 ? "" : "Укажите имя до 100 символов.";
}

export function passwordProblem(password: string): string {
  return length(password) >= 12 && length(password) <= 128 ? "" : "Пароль: от 12 до 128 символов.";
}

/** An empty value is allowed (no Telegram ID); anything else must be a Telegram user ID. */
export function telegramIdProblem(value: string): string {
  const text = value.trim();
  if (!text) return "";
  return /^[0-9]+$/.test(text) && Number(text) >= 1 && Number(text) <= MAX_TELEGRAM_ID
    ? "" : "Telegram ID — положительное целое число.";
}

export function telegramId(value: string): number | null {
  return value.trim() ? Number(value.trim()) : null;
}

/** The person as other screens show them: "Имя · логин". */
export function personLabel(person: { name: string; login: string }): string {
  return `${person.name} · ${person.login}`;
}

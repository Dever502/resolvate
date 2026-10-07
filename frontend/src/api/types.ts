// Response shapes of the console API (src/resolvate/console_auth.py, projects.py, console_service.py).

export interface Account {
  id: string;
  login: string;
  name: string;
  role: "admin" | "operator";
  active: boolean;
  telegram_id: number | null;
}

/** POST /console/login and GET /console/me. */
export interface SessionPayload {
  account: Account;
  csrf: string;
}

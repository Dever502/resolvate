// Response shapes of the console API (src/resolvate/console_auth.py, projects.py, console.py,
// console_service.py, console_folders.py).

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

/** GET /console/projects: every project the account can see, including ones it cannot open. */
export interface Project {
  id: string;
  name: string;
  active: boolean;
  admin_id: string;
  /** The account's role in the project; null when it only sees the project as installation admin. */
  role: "admin" | "operator" | null;
  /** Logo version (SHA-256) when there is a logo and the account may see it. */
  logo: string | null;
}

export type TicketChannel = "telegram" | "web";
export type TicketStatus = "provisioning" | "open" | "closed";

/** Row of POST tickets/sync. `revision` changes whenever any other field does. */
export interface TicketItem {
  id: string;
  name: string;
  channel: TicketChannel;
  status: TicketStatus;
  time: string;
  preview: string;
  unread: number;
  folder_id: string | null;
  folder_revision: number;
  revision: string;
}

/** POST tickets/sync: the ids of the requested page, and only rows the client does not know yet. */
export interface TicketPage {
  order: string[];
  items: TicketItem[];
}

/** GET tickets/{id}. */
export interface TicketDetail {
  id: string;
  display_name: string | null;
  username: string | null;
  channel: TicketChannel;
  status: TicketStatus;
  email: string | null;
  identity_value: string | null;
  remnawave_user_uuid: string | null;
  created_at: string;
  folder_id: string | null;
  folder_revision: number;
}

/** What the dialogue header can show before the detail request answers (from the list or the cache). */
export type TicketHeading = Partial<Pick<TicketDetail, "display_name" | "username" | "channel" | "status">>;

export interface Folder {
  id: string;
  name: string;
  revision: number;
}

/** POST tickets/{id}/folder. */
export interface FolderAssignment {
  folder_id: string | null;
  folder_revision: number;
}

export interface Rating {
  score: number;
  display_name?: string | null;
  username?: string | null;
  telegram_user_id?: number | string | null;
  email?: string | null;
  identity_value?: string | null;
}

export type Direction = "user_to_operator" | "operator_to_user";

/** Item of POST tickets/{id}/sync. */
export interface Message {
  id: string;
  direction: Direction;
  channel: string;
  text: string;
  system: boolean;
  rating: Rating | null;
  time: string;
  author: string;
  media_id: string | null;
  mime: string | null;
  sticker: boolean;
  sticker_emoji: string | null;
  attachment: boolean;
  /** Deliveries that failed and can be retried with POST retry/{command}/{id}. */
  failed: string[];
  /** A delivery whose outcome Telegram did not confirm: retrying could send twice. */
  uncertain: boolean;
  command: string | null;
  revision: string;
}

export interface MessagePage {
  order: string[];
  items: Message[];
  removed: string[];
  /** The client's window is too old: drop it and start from this page. */
  reset: boolean;
  /** Cursor for the next older page. */
  before: string | null;
  has_older: boolean;
}

export interface QuickReply {
  id: string;
  text: string;
}

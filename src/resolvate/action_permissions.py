"""Transport-independent action policy. No operator levels are assigned yet.

Call only after authentication and project admission. Never infer membership from
installation administration, Telegram group rights, or a customer Web API token.
"""

from dataclasses import dataclass
from enum import StrEnum


class Action(StrEnum):
    READ = "ticket.read"
    SEND = "ticket.send"
    EDIT = "ticket.edit"
    CLOSE = "ticket.close"
    REOPEN = "ticket.reopen"
    READ_MARK = "ticket.read_mark"
    RETRY = "delivery.retry"
    NOTE_READ = "note.read"
    NOTE_ADD = "note.add"
    BLOCK = "customer.block"
    UNBLOCK = "customer.unblock"
    CLOSE_ALL = "ticket.close_all"
    SYNC_TOPICS = "topic.sync"
    RETRY_TOPIC = "topic.retry"
    BIND_TOPIC = "topic.bind"
    SUBSCRIPTION = "subscription.read"
    GIFT = "subscription.extend"
    RESET_KEY = "subscription.reset_key"
    REVOKE_LINK = "subscription.revoke_link"
    RESET_DEVICES = "subscription.reset_devices"
    RESOLVE_PANEL = "subscription.resolve"
    FOLDER_READ = "folder.read"
    FOLDER_WRITE = "folder.write"
    REPLY_READ = "reply.read"
    REPLY_WRITE = "reply.write"
    MEDIA_READ = "media.read"
    STATISTICS = "statistics.read"


@dataclass(frozen=True)
class ActionActor:
    project_id: str | None
    actor_id: str
    admitted: bool
    administrator: bool = False


def allows_action(actor: ActionActor, action: Action | None, *, project_id: str | None) -> bool:
    """Preserve today's rights; future levels belong here, not in adapters."""
    if not isinstance(action, Action) or not actor.admitted or actor.project_id != project_id:
        return False
    return action != Action.RESOLVE_PANEL or actor.administrator


TELEGRAM_ACTIONS = {
    "/info": Action.READ,
    "/subinfo": Action.SUBSCRIPTION,
    "/notes": Action.NOTE_READ,
    "/note": Action.NOTE_ADD,
    "/stop": Action.CLOSE,
    "/hidestop": Action.CLOSE,
    "/gift": Action.GIFT,
    "/resetkey": Action.RESET_KEY,
    "/revokelink": Action.REVOKE_LINK,
    "/resetdevices": Action.RESET_DEVICES,
    "/resolvepanel": Action.RESOLVE_PANEL,
    "/block": Action.BLOCK,
    "/unblock": Action.UNBLOCK,
    "/closeall": Action.CLOSE_ALL,
    "/synctopics": Action.SYNC_TOPICS,
}

# Endpoint names, not user-controlled URL substrings. New endpoints require an
# explicit mapping. Authentication, CSRF, RLS and write-time checks stay in place.
CONSOLE_ACTIONS = {
    "events": Action.READ,
    "ticket_list": Action.READ,
    "ticket_detail": Action.READ,
    "messages": Action.READ,
    "read": Action.READ_MARK,
    "send": Action.SEND,
    "retry": Action.RETRY,
    "folder_list": Action.FOLDER_READ,
    "create_folder": Action.FOLDER_WRITE,
    "rename_folder": Action.FOLDER_WRITE,
    "delete_folder": Action.FOLDER_WRITE,
    "move_ticket": Action.FOLDER_WRITE,
    "replies": Action.REPLY_READ,
    "reply_groups": Action.REPLY_READ,
    "create_reply_group": Action.REPLY_WRITE,
    "rename_reply_group": Action.REPLY_WRITE,
    "delete_reply_group": Action.REPLY_WRITE,
    "create_reply": Action.REPLY_WRITE,
    "edit_reply": Action.REPLY_WRITE,
    "delete_reply": Action.REPLY_WRITE,
    "thumbnail": Action.MEDIA_READ,
    "media_file": Action.MEDIA_READ,
}

OPERATOR_API_ACTIONS = {
    "list_tickets": Action.READ,
    "get_ticket": Action.READ,
    "get_messages": Action.READ,
    "send_message": Action.SEND,
    "close_ticket": Action.CLOSE,
    "reopen_ticket": Action.REOPEN,
}

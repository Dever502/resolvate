from pathlib import Path

from sqlalchemy import ColumnElement, and_, not_, or_

from resolvate.models import TranscriptMedia

CLOUD_DOWNLOAD_LIMIT_BYTES = 20 * 1024 * 1024
SKIPPED_CLOUD_LIMIT = "skipped_cloud_limit"
SKIPPED_POLICY = "skipped_policy"
ALLOWED_FILE_SUFFIXES = {".pdf", ".jpg", ".jpeg", ".png", ".webp", ".mp4", ".mov", ".ogg", ".opus"}


def forbidden_attachment(kind: str, filename: str | None) -> bool:
    return kind not in {"photo", "video", "document", "voice"} or (
        kind == "document"
        and (not filename or Path(filename).suffix.lower() not in ALLOWED_FILE_SUFFIXES)
    )


def may_skip_media(*, size: int | None) -> bool:
    return size is not None and size > CLOUD_DOWNLOAD_LIMIT_BYTES


def unavailable_media() -> ColumnElement[bool]:
    stored = and_(
        TranscriptMedia.state == "stored",
        TranscriptMedia.storage_path.is_not(None),
        TranscriptMedia.sha256.is_not(None),
        TranscriptMedia.size_bytes > 0,
    )
    skipped = and_(
        TranscriptMedia.state == SKIPPED_CLOUD_LIMIT,
        TranscriptMedia.declared_size.is_not(None),
        TranscriptMedia.declared_size > CLOUD_DOWNLOAD_LIMIT_BYTES,
    )
    policy_skip = and_(
        TranscriptMedia.state == SKIPPED_POLICY,
        or_(
            TranscriptMedia.kind.not_in(("photo", "video", "document", "voice")),
            and_(
                TranscriptMedia.kind == "document",
                or_(
                    TranscriptMedia.filename.is_(None),
                    ~TranscriptMedia.filename.regexp_match(
                        r"\.(pdf|jpe?g|png|webp|mp4|mov|ogg|opus)$", flags="i"
                    ),
                ),
            ),
        ),
    )
    return not_(or_(stored, skipped, policy_skip))

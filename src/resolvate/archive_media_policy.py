from sqlalchemy import ColumnElement, and_, not_, or_

from resolvate.models import TranscriptMedia

CLOUD_DOWNLOAD_LIMIT_BYTES = 20 * 1024 * 1024
SKIPPED_CLOUD_LIMIT = "skipped_cloud_limit"


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
    return not_(or_(stored, skipped))

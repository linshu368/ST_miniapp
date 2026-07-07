"""
Auto-generate tracking links for new channels.

Supabase table setup SQL:

    CREATE TABLE botlinks (
        id BIGSERIAL PRIMARY KEY,
        source_name TEXT,
        bot_link TEXT,
        source_id TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        CONSTRAINT botlinks_short_code_key UNIQUE (source_id)
    );

    CREATE UNIQUE INDEX idx_botlinks_short_code
        ON botlinks (source_id) WHERE source_id IS NOT NULL;
"""

import os
import time
import random
import string
import logging

from dotenv import load_dotenv
from supabase import create_client, Client

load_dotenv()

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
logger = logging.getLogger(__name__)

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_KEY = os.environ["SUPABASE_KEY"]
BOT_USERNAME = os.environ["BOT_USERNAME"].lstrip("@")
MINIAPP_SHORT_NAME = os.environ.get("MINIAPP_SHORT_NAME", "app").strip("/") or "app"
SCAN_INTERVAL = int(os.environ.get("SCAN_INTERVAL", "60"))
TABLE_NAME = os.environ.get("TABLE_NAME", "botlinks")

supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)


def is_blank(value: str | None) -> bool:
    return value is None or not str(value).strip()


def generate_short_code(length: int = 8) -> str:
    return "".join(random.choices(string.ascii_letters + string.digits, k=length))


def get_existing_source_ids() -> set[str]:
    result = (
        supabase.table(TABLE_NAME)
        .select("source_id")
        .not_.is_("source_id", "null")
        .execute()
    )
    return {row["source_id"] for row in result.data}


def generate_unique_source_id(existing_ids: set[str], length: int = 8) -> str:
    while True:
        sid = generate_short_code(length)
        if sid not in existing_ids:
            return sid


def build_miniapp_link(source_id: str) -> str:
    return f"https://t.me/{BOT_USERNAME}/{MINIAPP_SHORT_NAME}?startapp={source_id}"


def scan_and_generate() -> int:
    """Find rows with source filled but bot_link blank, generate and backfill."""
    result = (
        supabase.table(TABLE_NAME)
        .select("*")
        .not_.is_("source_name", "null")
        .or_("bot_link.is.null,bot_link.eq.")
        .execute()
    )

    pending = [
        row for row in result.data
        if not is_blank(row.get("source_name")) and is_blank(row.get("bot_link"))
    ]
    if not pending:
        logger.info("No new channels to process")
        return 0

    existing_ids = get_existing_source_ids()
    count = 0

    for row in pending:
        sid = generate_unique_source_id(existing_ids)
        existing_ids.add(sid)
        link = build_miniapp_link(sid)

        supabase.table(TABLE_NAME).update({
            "bot_link": link,
            "source_id": sid,
        }).eq("id", row["id"]).execute()

        count += 1
        logger.info(f"Generated link for [{row['source_name']}]: {link}")

    logger.info(f"Processed {count} new channel(s) this round")
    return count


def main():
    logger.info(
        "Auto-generate service started | "
        f"miniapp: https://t.me/{BOT_USERNAME}/{MINIAPP_SHORT_NAME} | "
        f"interval: {SCAN_INTERVAL}s"
    )
    while True:
        try:
            scan_and_generate()
        except Exception as e:
            logger.error(f"Error during scan: {e}", exc_info=True)
        time.sleep(SCAN_INTERVAL)


if __name__ == "__main__":
    main()

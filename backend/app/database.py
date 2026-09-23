from __future__ import annotations

import os
import sqlite3
import threading
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path

DB_ENV = "PLANT_CARE_DB"
DEFAULT_DB = "./data/plant_care.sqlite3"
APP_ID = "plant-care"
SCHEMA_VERSION = 2
_write_lock = threading.RLock()


def database_path() -> Path:
    return Path(os.environ.get(DB_ENV, DEFAULT_DB)).expanduser()


def connect(path: Path | None = None) -> sqlite3.Connection:
    db_path = path or database_path()
    db_path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(db_path, timeout=15, check_same_thread=False)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys=ON")
    connection.execute("PRAGMA journal_mode=WAL")
    connection.execute("PRAGMA busy_timeout=15000")
    return connection


def _columns(db: sqlite3.Connection, table: str) -> set[str]:
    return {row["name"] for row in db.execute(f"PRAGMA table_info({table})")}


def _migrate_v2(db: sqlite3.Connection) -> None:
    """Move the Monday/Friday data model to per-pot scheduling without losing history."""
    if "sort_position" not in _columns(db, "plants"):
        db.execute("ALTER TABLE plants ADD COLUMN sort_position INTEGER NOT NULL DEFAULT 0")
    if "next_check_date" not in _columns(db, "plant_checks"):
        db.execute("ALTER TABLE plant_checks ADD COLUMN next_check_date TEXT")

    # Give old plants a durable order matching the former list order.
    plants = db.execute(
        "SELECT id FROM plants ORDER BY lower(COALESCE(location,'')), lower(COALESCE(nickname,species)), id"
    ).fetchall()
    for position, plant in enumerate(plants):
        db.execute("UPDATE plants SET sort_position=? WHERE id=?", (position, plant["id"]))

    timestamp = datetime.now().astimezone().isoformat(timespec="seconds")
    migration_day = datetime.now().astimezone().date().isoformat()
    db.execute(
        "UPDATE inspection_rounds SET status='incomplete', closed_at=? WHERE status='open'",
        (timestamp,),
    )

    # Preserve historical rows and create a new current, explicit day interval.
    current = db.execute(
        "SELECT * FROM watering_recommendations WHERE effective_to IS NULL"
    ).fetchall()
    for recommendation in current:
        kind, value = recommendation["cadence_kind"], recommendation["cadence_value"]
        interval = (
            1
            if kind == "daily"
            else (7 + value - 1) // value
            if kind == "weekly"
            else 30
            if kind == "monthly"
            else value
        )
        if kind == "days":
            continue
        db.execute(
            "UPDATE watering_recommendations SET effective_to=? WHERE id=?",
            (migration_day, recommendation["id"]),
        )
        db.execute(
            """INSERT INTO watering_recommendations
               (plant_id,cadence_kind,cadence_value,effective_from,source,created_at)
               VALUES (?, 'days', ?, ?, ?, ?)""",
            (
                recommendation["plant_id"],
                interval,
                migration_day,
                recommendation["source"],
                timestamp,
            ),
        )


def initialize(path: Path | None = None) -> None:
    with connect(path) as db:
        db.executescript(
            """
            CREATE TABLE IF NOT EXISTS app_metadata (
                key TEXT PRIMARY KEY, value TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS plants (
                id INTEGER PRIMARY KEY,
                species TEXT NOT NULL CHECK(trim(species) <> ''),
                nickname TEXT,
                location TEXT,
                care_note TEXT NOT NULL DEFAULT '',
                archived_at TEXT,
                sort_position INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS watering_recommendations (
                id INTEGER PRIMARY KEY,
                plant_id INTEGER NOT NULL REFERENCES plants(id) ON DELETE CASCADE,
                cadence_kind TEXT NOT NULL CHECK(cadence_kind IN ('daily','weekly','monthly','days')),
                cadence_value INTEGER NOT NULL CHECK(cadence_value >= 1),
                effective_from TEXT NOT NULL,
                effective_to TEXT,
                source TEXT NOT NULL DEFAULT 'manual' CHECK(source IN ('manual','learned')),
                created_at TEXT NOT NULL
            );
            CREATE UNIQUE INDEX IF NOT EXISTS one_current_recommendation
              ON watering_recommendations(plant_id) WHERE effective_to IS NULL;
            CREATE TABLE IF NOT EXISTS inspection_rounds (
                id INTEGER PRIMARY KEY,
                scheduled_date TEXT NOT NULL UNIQUE,
                status TEXT NOT NULL CHECK(status IN ('open','complete','incomplete')),
                created_at TEXT NOT NULL,
                closed_at TEXT
            );
            CREATE TABLE IF NOT EXISTS round_members (
                round_id INTEGER NOT NULL REFERENCES inspection_rounds(id) ON DELETE CASCADE,
                plant_id INTEGER NOT NULL REFERENCES plants(id) ON DELETE CASCADE,
                excluded_at TEXT,
                PRIMARY KEY(round_id, plant_id)
            );
            CREATE TABLE IF NOT EXISTS watering_events (
                id INTEGER PRIMARY KEY,
                plant_id INTEGER NOT NULL REFERENCES plants(id) ON DELETE CASCADE,
                care_date TEXT NOT NULL,
                note TEXT NOT NULL DEFAULT '',
                source_check_id INTEGER UNIQUE,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS watering_events_by_plant_date
              ON watering_events(plant_id, care_date DESC, id DESC);
            CREATE TABLE IF NOT EXISTS plant_checks (
                id INTEGER PRIMARY KEY,
                plant_id INTEGER NOT NULL REFERENCES plants(id) ON DELETE CASCADE,
                round_id INTEGER REFERENCES inspection_rounds(id) ON DELETE SET NULL,
                care_date TEXT NOT NULL,
                outcome TEXT NOT NULL CHECK(outcome IN ('watered','not_watered')),
                watering_event_id INTEGER REFERENCES watering_events(id) ON DELETE SET NULL,
                next_check_date TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                UNIQUE(round_id, plant_id)
            );
            CREATE INDEX IF NOT EXISTS plant_checks_by_plant_date
              ON plant_checks(plant_id, care_date DESC, id DESC);
            CREATE TABLE IF NOT EXISTS journal_entries (
                id INTEGER PRIMARY KEY,
                plant_id INTEGER NOT NULL REFERENCES plants(id) ON DELETE CASCADE,
                care_date TEXT NOT NULL,
                body TEXT NOT NULL CHECK(trim(body) <> ''),
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS photos (
                id INTEGER PRIMARY KEY,
                plant_id INTEGER NOT NULL REFERENCES plants(id) ON DELETE CASCADE,
                journal_entry_id INTEGER REFERENCES journal_entries(id) ON DELETE SET NULL,
                caption TEXT NOT NULL DEFAULT '',
                image BLOB NOT NULL,
                thumbnail BLOB NOT NULL,
                mime_type TEXT NOT NULL DEFAULT 'image/jpeg',
                width INTEGER NOT NULL,
                height INTEGER NOT NULL,
                is_cover INTEGER NOT NULL DEFAULT 0 CHECK(is_cover IN (0,1)),
                created_at TEXT NOT NULL
            );
            CREATE UNIQUE INDEX IF NOT EXISTS one_cover_per_plant
              ON photos(plant_id) WHERE is_cover = 1;
            CREATE TABLE IF NOT EXISTS fertilizer_products (
                id INTEGER PRIMARY KEY,
                name TEXT NOT NULL CHECK(trim(name) <> ''),
                description TEXT NOT NULL DEFAULT '',
                archived_at TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS fertilizer_events (
                id INTEGER PRIMARY KEY,
                plant_id INTEGER NOT NULL REFERENCES plants(id) ON DELETE CASCADE,
                product_id INTEGER NOT NULL REFERENCES fertilizer_products(id),
                care_date TEXT NOT NULL,
                amount TEXT NOT NULL DEFAULT '',
                dilution TEXT NOT NULL DEFAULT '',
                method TEXT NOT NULL DEFAULT '',
                note TEXT NOT NULL DEFAULT '',
                watering_event_id INTEGER REFERENCES watering_events(id) ON DELETE SET NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            """
        )
        version_row = db.execute(
            "SELECT value FROM app_metadata WHERE key='schema_version'"
        ).fetchone()
        version = int(version_row["value"]) if version_row else 0
        if version < 2:
            _migrate_v2(db)
        db.execute(
            "INSERT OR REPLACE INTO app_metadata(key, value) VALUES (?, ?)",
            ("app_id", APP_ID),
        )
        db.execute(
            "INSERT OR REPLACE INTO app_metadata(key, value) VALUES (?, ?)",
            ("schema_version", str(SCHEMA_VERSION)),
        )
        db.commit()


@contextmanager
def transaction():
    with _write_lock:
        db = connect()
        try:
            db.execute("BEGIN IMMEDIATE")
            yield db
            db.commit()
        except Exception:
            db.rollback()
            raise
        finally:
            db.close()


@contextmanager
def exclusive_database_access():
    """Serialize backup/restore operations without holding an SQLite transaction open."""
    with _write_lock:
        yield

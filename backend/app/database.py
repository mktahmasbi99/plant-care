from __future__ import annotations

import os
import sqlite3
import tempfile
import threading
from contextlib import contextmanager
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

DB_ENV = "PLANT_CARE_DB"
DEFAULT_DB = "./data/plant_care.sqlite3"
APP_ID = "plant-care"
SCHEMA_VERSION = 4
BACKUP_APP_ID = APP_ID
BACKUP_FORMAT_VERSION = 1
BACKUP_PREFIXES = {
    "daily": "a-daily",
    "weekly": "a-weekly",
    "on-demand": "o",
    "pre-import": "pre-import",
    "pre-restore": "pre-restore",
    "pre-delete": "pre-delete",
}
SAFETY_BACKUP_TYPES = {"pre-import", "pre-restore", "pre-delete"}
_write_lock = threading.RLock()


class BackupError(ValueError):
    """A user-actionable backup, restore, or import error."""


def timezone() -> ZoneInfo:
    return ZoneInfo(os.environ.get("TZ", "Europe/Warsaw"))


def database_path() -> Path:
    return Path(os.environ.get(DB_ENV, DEFAULT_DB)).expanduser()


def connect(path: Path | None = None) -> sqlite3.Connection:
    db_path = path or database_path()
    db_path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(db_path, timeout=15, check_same_thread=False)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys=ON")
    connection.execute(
        "PRAGMA journal_mode=WAL"
        if path is None or path == database_path()
        else "PRAGMA journal_mode=DELETE"
    )
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


def _migrate_v3(db: sqlite3.Connection) -> None:
    """Keep pending manually chosen rechecks as one-time snoozes."""
    if "snoozed_until" not in _columns(db, "plants"):
        db.execute("ALTER TABLE plants ADD COLUMN snoozed_until TEXT")
    for plant in db.execute("SELECT id FROM plants"):
        recheck = db.execute(
            """SELECT care_date,next_check_date,created_at FROM plant_checks
               WHERE plant_id=? AND outcome='not_watered' AND next_check_date IS NOT NULL
               ORDER BY care_date DESC,created_at DESC,id DESC LIMIT 1""",
            (plant["id"],),
        ).fetchone()
        watering = db.execute(
            """SELECT care_date,created_at FROM watering_events WHERE plant_id=?
               ORDER BY care_date DESC,created_at DESC,id DESC LIMIT 1""",
            (plant["id"],),
        ).fetchone()
        if recheck and (
            not watering
            or (recheck["care_date"], recheck["created_at"])
            > (watering["care_date"], watering["created_at"])
        ):
            db.execute(
                "UPDATE plants SET snoozed_until=? WHERE id=?",
                (recheck["next_check_date"], plant["id"]),
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
                snoozed_until TEXT,
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
            CREATE TABLE IF NOT EXISTS backup_settings (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                daily_enabled INTEGER NOT NULL DEFAULT 1,
                daily_time TEXT NOT NULL DEFAULT '01:00',
                daily_retention INTEGER NOT NULL DEFAULT 7,
                weekly_enabled INTEGER NOT NULL DEFAULT 1,
                weekly_day INTEGER NOT NULL DEFAULT 6,
                weekly_time TEXT NOT NULL DEFAULT '01:00',
                weekly_retention INTEGER NOT NULL DEFAULT 8,
                safety_retention INTEGER NOT NULL DEFAULT 8,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS backup_runs (
                backup_type TEXT PRIMARY KEY,
                last_scheduled_date TEXT NOT NULL
            );
            """
        )
        version_row = db.execute(
            "SELECT value FROM app_metadata WHERE key='schema_version'"
        ).fetchone()
        version = int(version_row["value"]) if version_row else 0
        if version < 2:
            _migrate_v2(db)
        if version < 3:
            _migrate_v3(db)
        db.execute("INSERT OR IGNORE INTO backup_settings(id) VALUES (1)")
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


def backup_directory() -> Path:
    return database_path().parent / "backups"


def _backup_filename(category: str) -> Path:
    stamp = datetime.now(timezone()).strftime("%Y%m%d-%H%M%S")
    candidate = backup_directory() / f"{BACKUP_PREFIXES[category]}-plant-care-{stamp}.sqlite3"
    counter = 2
    while candidate.exists():
        candidate = (
            backup_directory() / f"{BACKUP_PREFIXES[category]}-plant-care-{stamp}-{counter}.sqlite3"
        )
        counter += 1
    return candidate


def _category_for_path(path: Path) -> str | None:
    if path.suffix != ".sqlite3":
        return None
    return next(
        (
            category
            for category, prefix in BACKUP_PREFIXES.items()
            if path.name.startswith(f"{prefix}-")
        ),
        None,
    )


def _validate_sqlite(path: Path) -> None:
    try:
        with sqlite3.connect(path) as db:
            if db.execute("PRAGMA quick_check").fetchone()[0] != "ok":
                raise BackupError("The selected database is corrupted.")
            if db.execute("PRAGMA foreign_key_check").fetchone():
                raise BackupError("The selected database has invalid relationships.")
    except sqlite3.DatabaseError as error:
        raise BackupError("The selected file is not a valid SQLite database.") from error


def _write_backup_marker(path: Path, category: str) -> None:
    with sqlite3.connect(path) as db:
        db.execute("PRAGMA journal_mode=DELETE")
        db.execute("""CREATE TABLE IF NOT EXISTS plant_care_backup_metadata (
            id INTEGER PRIMARY KEY CHECK (id = 1), app_id TEXT NOT NULL,
            format_version INTEGER NOT NULL, created_at TEXT NOT NULL, category TEXT NOT NULL
        )""")
        db.execute("DELETE FROM plant_care_backup_metadata")
        db.execute(
            "INSERT INTO plant_care_backup_metadata VALUES (1, ?, ?, ?, ?)",
            (BACKUP_APP_ID, BACKUP_FORMAT_VERSION, datetime.now(timezone()).isoformat(), category),
        )
        db.commit()
    _validate_sqlite(path)


def backup_settings() -> dict:
    with connect() as db:
        row = db.execute("SELECT * FROM backup_settings WHERE id=1").fetchone()
    return {
        "dailyEnabled": bool(row["daily_enabled"]),
        "dailyTime": row["daily_time"],
        "dailyRetention": row["daily_retention"],
        "weeklyEnabled": bool(row["weekly_enabled"]),
        "weeklyDay": row["weekly_day"],
        "weeklyTime": row["weekly_time"],
        "weeklyRetention": row["weekly_retention"],
        "safetyRetention": row["safety_retention"],
    }


def _prune_backups(category: str, keep: int) -> None:
    if not backup_directory().exists():
        return
    paths = sorted(
        (
            path
            for path in backup_directory().iterdir()
            if path.is_file() and _category_for_path(path) == category
        ),
        key=lambda path: path.stat().st_mtime,
        reverse=True,
    )
    for path in paths[keep:]:
        path.unlink(missing_ok=True)


def _prune_safety_backups(keep: int) -> None:
    if not backup_directory().exists():
        return
    paths = sorted(
        (
            path
            for path in backup_directory().iterdir()
            if path.is_file() and _category_for_path(path) in SAFETY_BACKUP_TYPES
        ),
        key=lambda path: path.stat().st_mtime,
        reverse=True,
    )
    for path in paths[keep:]:
        path.unlink(missing_ok=True)


def update_backup_settings(values: dict) -> dict:
    for key in ("dailyTime", "weeklyTime"):
        try:
            hour, minute = (int(part) for part in values[key].split(":"))
        except (AttributeError, ValueError) as error:
            raise BackupError("Backup times must use HH:MM format.") from error
        if not 0 <= hour <= 23 or not 0 <= minute <= 59:
            raise BackupError("Choose a valid backup time.")
    if not 0 <= values["weeklyDay"] <= 6:
        raise BackupError("Choose a valid weekly backup day.")
    for key in ("dailyRetention", "weeklyRetention", "safetyRetention"):
        if not 1 <= values[key] <= 365:
            raise BackupError("Backup retention must be between 1 and 365.")
    with transaction() as db:
        db.execute(
            """UPDATE backup_settings SET daily_enabled=?, daily_time=?, daily_retention=?,
            weekly_enabled=?, weekly_day=?, weekly_time=?, weekly_retention=?, safety_retention=?,
            updated_at=CURRENT_TIMESTAMP WHERE id=1""",
            (
                int(values["dailyEnabled"]),
                values["dailyTime"],
                values["dailyRetention"],
                int(values["weeklyEnabled"]),
                values["weeklyDay"],
                values["weeklyTime"],
                values["weeklyRetention"],
                values["safetyRetention"],
            ),
        )
    _prune_backups("daily", values["dailyRetention"])
    _prune_backups("weekly", values["weeklyRetention"])
    _prune_safety_backups(values["safetyRetention"])
    return backup_settings()


def create_backup(category: str = "on-demand") -> Path:
    if category not in BACKUP_PREFIXES:
        raise BackupError("Unknown backup category.")
    with exclusive_database_access():
        backup_directory().mkdir(parents=True, exist_ok=True)
        destination = _backup_filename(category)
        try:
            with connect() as source, sqlite3.connect(destination) as target:
                source.backup(target)
            _write_backup_marker(destination, category)
        except Exception:
            destination.unlink(missing_ok=True)
            raise
        settings = backup_settings()
        if category == "daily":
            _prune_backups(category, settings["dailyRetention"])
        elif category == "weekly":
            _prune_backups(category, settings["weeklyRetention"])
        elif category in SAFETY_BACKUP_TYPES:
            _prune_safety_backups(settings["safetyRetention"])
        return destination


def list_backups() -> list[dict]:
    if not backup_directory().exists():
        return []
    result = []
    for path in backup_directory().iterdir():
        category = _category_for_path(path)
        if not path.is_file() or category is None:
            continue
        stat = path.stat()
        result.append(
            {
                "filename": path.name,
                "category": category,
                "createdAt": datetime.fromtimestamp(stat.st_mtime, timezone()).isoformat(),
                "size": stat.st_size,
                "safety": category in SAFETY_BACKUP_TYPES,
            }
        )
    return sorted(result, key=lambda item: (item["createdAt"], item["filename"]), reverse=True)


def backup_path(filename: str) -> Path:
    if Path(filename).name != filename:
        raise BackupError("Invalid backup filename.")
    candidate = (backup_directory() / filename).resolve()
    if (
        candidate.parent != backup_directory().resolve()
        or not candidate.is_file()
        or _category_for_path(candidate) is None
    ):
        raise BackupError("Backup not found.")
    return candidate


def delete_backup(filename: str, confirmation: str) -> None:
    if confirmation != "DELETE":
        raise BackupError("Type DELETE to remove this backup.")
    backup_path(filename).unlink()


def validate_compatible_database(path: Path) -> None:
    _validate_sqlite(path)
    try:
        with sqlite3.connect(path) as db:
            metadata = dict(db.execute("SELECT key,value FROM app_metadata"))
    except sqlite3.DatabaseError as error:
        raise BackupError("This is not a compatible Plant Care database.") from error
    if (
        metadata.get("app_id") != APP_ID
        or int(metadata.get("schema_version", "0")) > SCHEMA_VERSION
    ):
        raise BackupError("This database is not compatible with this Plant Care version.")


def validate_backup(path: Path) -> None:
    validate_compatible_database(path)
    try:
        with sqlite3.connect(path) as db:
            row = db.execute(
                "SELECT app_id,format_version FROM plant_care_backup_metadata WHERE id=1"
            ).fetchone()
    except sqlite3.DatabaseError as error:
        raise BackupError("This is not a Plant Care backup.") from error
    if row is None or row[0] != BACKUP_APP_ID or row[1] != BACKUP_FORMAT_VERSION:
        raise BackupError("This is not a supported Plant Care backup.")


def _clear_sidecars() -> None:
    for suffix in ("-wal", "-shm"):
        Path(f"{database_path()}{suffix}").unlink(missing_ok=True)


def _replace_staged(staged: Path, confirmation: str, *, backup_only: bool) -> str:
    if confirmation != ("RESTORE" if backup_only else "IMPORT"):
        raise BackupError(
            f"Type {'RESTORE' if backup_only else 'IMPORT'} to replace the current database."
        )
    (validate_backup if backup_only else validate_compatible_database)(staged)
    initialize(staged)
    (validate_backup if backup_only else validate_compatible_database)(staged)
    current_settings = backup_settings()
    safety = create_backup("pre-restore" if backup_only else "pre-import")
    os.replace(staged, database_path())
    _clear_sidecars()
    if backup_only:
        update_backup_settings(current_settings)
    return safety.name


def restore_server_backup(filename: str, confirmation: str) -> str:
    source = backup_path(filename)
    with (
        exclusive_database_access(),
        tempfile.TemporaryDirectory(dir=database_path().parent) as directory,
    ):
        staged = Path(directory) / "staged.sqlite3"
        with sqlite3.connect(source) as original, sqlite3.connect(staged) as copy:
            original.backup(copy)
        return _replace_staged(staged, confirmation, backup_only=True)


def restore_uploaded_backup(upload: bytes, confirmation: str) -> str:
    if not upload:
        raise BackupError("Choose a backup file.")
    if len(upload) > 100 * 1024 * 1024:
        raise BackupError("Backup files cannot exceed 100 MB.")
    with (
        exclusive_database_access(),
        tempfile.TemporaryDirectory(dir=database_path().parent) as directory,
    ):
        staged = Path(directory) / "staged.sqlite3"
        staged.write_bytes(upload)
        return _replace_staged(staged, confirmation, backup_only=True)


def import_database(upload: bytes, confirmation: str) -> str:
    if not upload:
        raise BackupError("Choose a database file.")
    if len(upload) > 100 * 1024 * 1024:
        raise BackupError("Database files cannot exceed 100 MB.")
    with (
        exclusive_database_access(),
        tempfile.TemporaryDirectory(dir=database_path().parent) as directory,
    ):
        staged = Path(directory) / "staged.sqlite3"
        staged.write_bytes(upload)
        return _replace_staged(staged, confirmation, backup_only=False)


def run_scheduled_backups(current: datetime | None = None) -> None:
    current = current or datetime.now(timezone())
    settings = backup_settings()
    schedules = (
        ("daily", settings["dailyEnabled"], settings["dailyTime"], None),
        ("weekly", settings["weeklyEnabled"], settings["weeklyTime"], settings["weeklyDay"]),
    )
    for category, enabled, time_text, weekday in schedules:
        if not enabled:
            continue
        hour, minute = (int(part) for part in time_text.split(":"))
        due = current.date()
        if weekday is not None:
            due -= timedelta(days=(due.weekday() - weekday) % 7)
        scheduled = datetime.combine(due, datetime.min.time(), timezone()).replace(
            hour=hour, minute=minute
        )
        if scheduled > current:
            due -= timedelta(days=7 if weekday is not None else 1)
        with transaction() as db:
            row = db.execute(
                "SELECT last_scheduled_date FROM backup_runs WHERE backup_type=?", (category,)
            ).fetchone()
            if row is None:
                db.execute("INSERT INTO backup_runs VALUES (?,?)", (category, due.isoformat()))
                continue
            if row["last_scheduled_date"] >= due.isoformat():
                continue
            db.execute(
                "UPDATE backup_runs SET last_scheduled_date=? WHERE backup_type=?",
                (due.isoformat(), category),
            )
        create_backup(category)

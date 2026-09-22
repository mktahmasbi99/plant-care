from __future__ import annotations

import calendar
import io
import os
import sqlite3
import uuid
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Literal
from zoneinfo import ZoneInfo

from fastapi import FastAPI, File, Form, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from PIL import Image, ImageOps
from pydantic import BaseModel, Field, field_validator

from .database import (
    APP_ID,
    SCHEMA_VERSION,
    connect,
    database_path,
    exclusive_database_access,
    initialize,
    transaction,
)

try:
    import pillow_heif

    pillow_heif.register_heif_opener()
except ImportError:  # Pillow still supports the common browser upload formats.
    pass

TZ = ZoneInfo(os.environ.get("TZ", "Europe/Warsaw"))
MAX_UPLOAD_BYTES = 50 * 1024 * 1024
MAX_STORED_BYTES = 5 * 1024 * 1024
MAX_EDGE = 2560
THUMB_EDGE = 480

app = FastAPI(title="Plant Care", version="0.1.0")


def now() -> str:
    return datetime.now(TZ).astimezone().isoformat(timespec="seconds")


def today() -> date:
    return datetime.now(TZ).date()


def date_string(value: date) -> str:
    return value.isoformat()


def parse_date(value: str) -> date:
    try:
        return date.fromisoformat(value)
    except ValueError as error:
        raise HTTPException(422, "Use an ISO calendar date (YYYY-MM-DD).") from error


def require_row(row: sqlite3.Row | None, detail: str = "Not found.") -> sqlite3.Row:
    if row is None:
        raise HTTPException(404, detail)
    return row


def display_name(row: sqlite3.Row) -> str:
    return (row["nickname"] or "").strip() or row["species"]


def local_today() -> str:
    return date_string(today())


class CadenceInput(BaseModel):
    kind: Literal["daily", "weekly", "monthly", "days"]
    value: int = Field(ge=1, le=31)

    @field_validator("value")
    @classmethod
    def monthly_is_once(cls, value: int, info):
        if info.data.get("kind") == "monthly" and value != 1:
            raise ValueError("Monthly recommendations currently support once per month.")
        return value


class PlantInput(BaseModel):
    species: str = Field(min_length=1, max_length=160)
    nickname: str = Field(default="", max_length=160)
    location: str = Field(default="", max_length=160)
    care_note: str = Field(default="", max_length=10000)
    recommendation: CadenceInput
    initial_last_watered: str | None = None


class PlantUpdate(BaseModel):
    species: str = Field(min_length=1, max_length=160)
    nickname: str = Field(default="", max_length=160)
    location: str = Field(default="", max_length=160)
    care_note: str = Field(default="", max_length=10000)


class CheckInput(BaseModel):
    outcome: Literal["watered", "not_watered"]
    care_date: str | None = None
    note: str = Field(default="", max_length=5000)


class WateringInput(BaseModel):
    care_date: str | None = None
    note: str = Field(default="", max_length=5000)


class JournalInput(BaseModel):
    care_date: str
    body: str = Field(min_length=1, max_length=10000)


class ProductInput(BaseModel):
    name: str = Field(min_length=1, max_length=160)
    description: str = Field(default="", max_length=5000)


class FertilizerInput(BaseModel):
    product_id: int
    care_date: str
    amount: str = Field(default="", max_length=160)
    dilution: str = Field(default="", max_length=160)
    method: str = Field(default="", max_length=160)
    note: str = Field(default="", max_length=5000)
    watering_event_id: int | None = None


class RestoreConfirmation(BaseModel):
    confirmation: str


def recommendation_for(db: sqlite3.Connection, plant_id: int) -> sqlite3.Row:
    return require_row(
        db.execute(
            "SELECT * FROM watering_recommendations WHERE plant_id=? AND effective_to IS NULL",
            (plant_id,),
        ).fetchone(),
        "Plant has no current watering recommendation.",
    )


def cadence_label(recommendation: sqlite3.Row) -> str:
    kind, value = recommendation["cadence_kind"], recommendation["cadence_value"]
    if kind == "daily":
        return "Every day"
    if kind == "weekly":
        return "Once per week" if value == 1 else f"{value} times per week"
    if kind == "monthly":
        return "Once per month"
    return f"Every {value} day" + ("" if value == 1 else "s")


def target_date(last_watered: date, recommendation: sqlite3.Row) -> date:
    kind, value = recommendation["cadence_kind"], recommendation["cadence_value"]
    if kind == "daily":
        return last_watered + timedelta(days=1)
    if kind == "weekly":
        return last_watered + timedelta(days=(7 + value - 1) // value)
    if kind == "days":
        return last_watered + timedelta(days=value)
    year = last_watered.year + (last_watered.month // 12)
    month = (last_watered.month % 12) + 1
    return date(year, month, min(last_watered.day, calendar.monthrange(year, month)[1]))


def care_status(last_watered: str | None, recommendation: sqlite3.Row, current: date) -> dict:
    if not last_watered:
        return {"status": "never_watered", "target_date": None, "days_since": None}
    previous = parse_date(last_watered)
    target = target_date(previous, recommendation)
    if current > target:
        status = "overdue"
    elif current == target:
        status = "due"
    elif recommendation["cadence_kind"] != "daily" and current == target - timedelta(days=1):
        status = "due_soon"
    else:
        status = "on_track"
    return {
        "status": status,
        "target_date": target.isoformat(),
        "days_since": (current - previous).days,
    }


def last_watering(db: sqlite3.Connection, plant_id: int) -> sqlite3.Row | None:
    return db.execute(
        "SELECT * FROM watering_events WHERE plant_id=? ORDER BY care_date DESC, id DESC LIMIT 1",
        (plant_id,),
    ).fetchone()


def last_check(db: sqlite3.Connection, plant_id: int) -> sqlite3.Row | None:
    return db.execute(
        "SELECT * FROM plant_checks WHERE plant_id=? ORDER BY care_date DESC, id DESC LIMIT 1",
        (plant_id,),
    ).fetchone()


def plant_payload(db: sqlite3.Connection, plant: sqlite3.Row, current: date | None = None) -> dict:
    current = current or today()
    recommendation = recommendation_for(db, plant["id"])
    watering = last_watering(db, plant["id"])
    check = last_check(db, plant["id"])
    cover = db.execute(
        "SELECT id FROM photos WHERE plant_id=? AND is_cover=1", (plant["id"],)
    ).fetchone()
    return {
        "id": plant["id"],
        "species": plant["species"],
        "nickname": plant["nickname"] or "",
        "display_name": display_name(plant),
        "location": plant["location"] or "",
        "care_note": plant["care_note"],
        "archived_at": plant["archived_at"],
        "created_at": plant["created_at"],
        "recommendation": {
            "id": recommendation["id"],
            "kind": recommendation["cadence_kind"],
            "value": recommendation["cadence_value"],
            "label": cadence_label(recommendation),
            "effective_from": recommendation["effective_from"],
        },
        "last_watered": watering["care_date"] if watering else None,
        "last_check": (
            {"date": check["care_date"], "outcome": check["outcome"], "id": check["id"]}
            if check
            else None
        ),
        "status": care_status(watering["care_date"] if watering else None, recommendation, current),
        "cover_photo_id": cover["id"] if cover else None,
    }


def scheduled_day(day: date) -> bool:
    return day.weekday() in (0, 4)


def most_recent_scheduled_day(day: date) -> date:
    while not scheduled_day(day):
        day -= timedelta(days=1)
    return day


def close_old_rounds(db: sqlite3.Connection, scheduled: date) -> None:
    timestamp = now()
    db.execute(
        """UPDATE inspection_rounds SET status='incomplete', closed_at=?
           WHERE status='open' AND scheduled_date < ?""",
        (timestamp, scheduled.isoformat()),
    )


def current_round(db: sqlite3.Connection, current: date) -> sqlite3.Row:
    scheduled = most_recent_scheduled_day(current)
    close_old_rounds(db, scheduled)
    row = db.execute(
        "SELECT * FROM inspection_rounds WHERE scheduled_date=?", (scheduled.isoformat(),)
    ).fetchone()
    if row is None:
        timestamp = now()
        cursor = db.execute(
            "INSERT INTO inspection_rounds(scheduled_date,status,created_at) VALUES (?, 'open', ?)",
            (scheduled.isoformat(), timestamp),
        )
        round_id = cursor.lastrowid
        plants = db.execute("SELECT id FROM plants WHERE archived_at IS NULL").fetchall()
        db.executemany(
            "INSERT INTO round_members(round_id,plant_id) VALUES (?,?)",
            [(round_id, plant["id"]) for plant in plants],
        )
        row = require_row(
            db.execute("SELECT * FROM inspection_rounds WHERE id=?", (round_id,)).fetchone()
        )
    return row


def refresh_round_status(db: sqlite3.Connection, round_id: int) -> None:
    remaining = db.execute(
        """SELECT count(*) FROM round_members m
           LEFT JOIN plant_checks c ON c.round_id=m.round_id AND c.plant_id=m.plant_id
           WHERE m.round_id=? AND m.excluded_at IS NULL AND c.id IS NULL""",
        (round_id,),
    ).fetchone()[0]
    if remaining == 0:
        db.execute(
            "UPDATE inspection_rounds SET status='complete',closed_at=? WHERE id=? AND status='open'",
            (now(), round_id),
        )


def dashboard_payload(db: sqlite3.Connection, current: date) -> dict:
    round_row = current_round(db, current)
    plants = db.execute(
        "SELECT * FROM plants WHERE archived_at IS NULL ORDER BY lower(COALESCE(location,'')), lower(COALESCE(nickname,species))"
    ).fetchall()
    cards = [plant_payload(db, plant, current) for plant in plants]
    checks = {
        row["plant_id"]: row
        for row in db.execute(
            "SELECT * FROM plant_checks WHERE round_id=?", (round_row["id"],)
        ).fetchall()
    }
    members = {
        row["plant_id"]: row
        for row in db.execute(
            "SELECT * FROM round_members WHERE round_id=?", (round_row["id"],)
        ).fetchall()
    }
    round_cards = []
    daily, attention = [], []
    for card in cards:
        member = members.get(card["id"])
        card["round_check"] = (
            {"id": checks[card["id"]]["id"], "outcome": checks[card["id"]]["outcome"]}
            if card["id"] in checks
            else None
        )
        card["in_round"] = member is not None and member["excluded_at"] is None
        if card["recommendation"]["kind"] == "daily":
            daily.append(card)
        if card["status"]["status"] in ("never_watered", "due", "overdue"):
            attention.append(card)
        if card["last_check"] and card["last_check"]["date"] == current.isoformat():
            card["checked_today_not_watered"] = card["last_check"]["outcome"] == "not_watered"
        else:
            card["checked_today_not_watered"] = False
        round_cards.append(card)
    included = [card for card in round_cards if card["in_round"]]
    completed = sum(1 for card in included if card["round_check"])
    return {
        "server_date": current.isoformat(),
        "round": {
            "id": round_row["id"],
            "scheduled_date": round_row["scheduled_date"],
            "status": round_row["status"],
            "completed": completed,
            "total": len(included),
            "plants": included,
        },
        "daily": daily,
        "attention": attention,
        "plants": cards,
    }


def event_payload(db: sqlite3.Connection, row: sqlite3.Row, event_type: str) -> dict:
    result = dict(row)
    result["type"] = event_type
    if event_type == "fertilizer":
        product = db.execute(
            "SELECT name FROM fertilizer_products WHERE id=?", (row["product_id"],)
        ).fetchone()
        result["product_name"] = product["name"] if product else "Deleted product"
    return result


@app.on_event("startup")
def startup() -> None:
    initialize()


@app.get("/api/health")
def health():
    return {"ok": True, "app_id": APP_ID, "schema_version": SCHEMA_VERSION}


@app.get("/api/config")
def config():
    return {"today": local_today(), "timezone": str(TZ), "app_name": "Plant Care"}


@app.get("/api/dashboard")
def dashboard(day: str | None = Query(default=None)):
    current = parse_date(day) if day else today()
    with transaction() as db:
        return dashboard_payload(db, current)


@app.get("/api/plants")
def list_plants(include_archived: bool = False):
    with connect() as db:
        where = "" if include_archived else "WHERE archived_at IS NULL"
        rows = db.execute(
            f"SELECT * FROM plants {where} ORDER BY lower(COALESCE(location,'')), lower(COALESCE(nickname,species))"
        ).fetchall()
        return [plant_payload(db, row) for row in rows]


@app.post("/api/plants", status_code=201)
def create_plant(payload: PlantInput):
    initial = parse_date(payload.initial_last_watered) if payload.initial_last_watered else None
    timestamp = now()
    with transaction() as db:
        cursor = db.execute(
            """INSERT INTO plants(species,nickname,location,care_note,created_at,updated_at)
               VALUES (?,?,?,?,?,?)""",
            (
                payload.species.strip(),
                payload.nickname.strip(),
                payload.location.strip(),
                payload.care_note,
                timestamp,
                timestamp,
            ),
        )
        plant_id = cursor.lastrowid
        db.execute(
            """INSERT INTO watering_recommendations
               (plant_id,cadence_kind,cadence_value,effective_from,source,created_at)
               VALUES (?,?,?,?, 'manual',?)""",
            (
                plant_id,
                payload.recommendation.kind,
                payload.recommendation.value,
                local_today(),
                timestamp,
            ),
        )
        if initial:
            db.execute(
                """INSERT INTO watering_events(plant_id,care_date,note,created_at,updated_at)
                   VALUES (?,?,?, ?,?)""",
                (plant_id, initial.isoformat(), "Initial watering history", timestamp, timestamp),
            )
        plant = require_row(db.execute("SELECT * FROM plants WHERE id=?", (plant_id,)).fetchone())
        return plant_payload(db, plant)


@app.get("/api/plants/{plant_id}")
def get_plant(plant_id: int):
    with connect() as db:
        plant = require_row(
            db.execute("SELECT * FROM plants WHERE id=?", (plant_id,)).fetchone(),
            "Plant not found.",
        )
        response = plant_payload(db, plant)
        response["recommendation_history"] = [
            dict(row)
            for row in db.execute(
                "SELECT * FROM watering_recommendations WHERE plant_id=? ORDER BY effective_from DESC, id DESC",
                (plant_id,),
            )
        ]
        response["timeline"] = timeline(db, plant_id)
        return response


@app.put("/api/plants/{plant_id}")
def update_plant(plant_id: int, payload: PlantUpdate):
    with transaction() as db:
        require_row(
            db.execute("SELECT id FROM plants WHERE id=?", (plant_id,)).fetchone(),
            "Plant not found.",
        )
        db.execute(
            """UPDATE plants SET species=?,nickname=?,location=?,care_note=?,updated_at=? WHERE id=?""",
            (
                payload.species.strip(),
                payload.nickname.strip(),
                payload.location.strip(),
                payload.care_note,
                now(),
                plant_id,
            ),
        )
        plant = require_row(db.execute("SELECT * FROM plants WHERE id=?", (plant_id,)).fetchone())
        return plant_payload(db, plant)


@app.put("/api/plants/{plant_id}/recommendation")
def change_recommendation(plant_id: int, payload: CadenceInput):
    with transaction() as db:
        require_row(
            db.execute("SELECT id FROM plants WHERE id=?", (plant_id,)).fetchone(),
            "Plant not found.",
        )
        current = recommendation_for(db, plant_id)
        timestamp = now()
        db.execute(
            "UPDATE watering_recommendations SET effective_to=? WHERE id=?",
            (local_today(), current["id"]),
        )
        db.execute(
            """INSERT INTO watering_recommendations
               (plant_id,cadence_kind,cadence_value,effective_from,source,created_at)
               VALUES (?,?,?,?, 'manual',?)""",
            (plant_id, payload.kind, payload.value, local_today(), timestamp),
        )
        plant = require_row(db.execute("SELECT * FROM plants WHERE id=?", (plant_id,)).fetchone())
        return plant_payload(db, plant)


@app.post("/api/plants/{plant_id}/archive")
def archive_plant(plant_id: int):
    with transaction() as db:
        require_row(
            db.execute("SELECT * FROM plants WHERE id=?", (plant_id,)).fetchone(),
            "Plant not found.",
        )
        timestamp = now()
        db.execute(
            "UPDATE plants SET archived_at=?,updated_at=? WHERE id=?",
            (timestamp, timestamp, plant_id),
        )
        db.execute(
            """UPDATE round_members SET excluded_at=? WHERE plant_id=? AND round_id IN
               (SELECT id FROM inspection_rounds WHERE status='open')""",
            (timestamp, plant_id),
        )
        for row in db.execute("SELECT id FROM inspection_rounds WHERE status='open'").fetchall():
            refresh_round_status(db, row["id"])
        return {
            "archived": True,
            "plant": plant_payload(
                db,
                require_row(db.execute("SELECT * FROM plants WHERE id=?", (plant_id,)).fetchone()),
            ),
        }


@app.post("/api/plants/{plant_id}/restore")
def restore_plant(plant_id: int):
    with transaction() as db:
        require_row(
            db.execute("SELECT id FROM plants WHERE id=?", (plant_id,)).fetchone(),
            "Plant not found.",
        )
        db.execute("UPDATE plants SET archived_at=NULL,updated_at=? WHERE id=?", (now(), plant_id))
        return {"restored": True}


@app.delete("/api/plants/{plant_id}")
def delete_plant(plant_id: int, confirmation: str = Query(default="")):
    if confirmation != "DELETE":
        raise HTTPException(
            422, "Pass confirmation=DELETE to permanently remove an archived plant."
        )
    with transaction() as db:
        plant = require_row(
            db.execute("SELECT * FROM plants WHERE id=?", (plant_id,)).fetchone(),
            "Plant not found.",
        )
        if not plant["archived_at"]:
            raise HTTPException(409, "Archive a plant before permanently deleting it.")
        db.execute("DELETE FROM plants WHERE id=?", (plant_id,))
        return Response(status_code=204)


@app.post("/api/rounds/{round_id}/plants/{plant_id}/check")
def record_round_check(round_id: int, plant_id: int, payload: CheckInput):
    care_day = parse_date(payload.care_date) if payload.care_date else today()
    timestamp = now()
    with transaction() as db:
        round_row = require_row(
            db.execute("SELECT * FROM inspection_rounds WHERE id=?", (round_id,)).fetchone(),
            "Round not found.",
        )
        if round_row["status"] != "open":
            raise HTTPException(409, "This inspection round is closed.")
        require_row(
            db.execute(
                "SELECT * FROM round_members WHERE round_id=? AND plant_id=? AND excluded_at IS NULL",
                (round_id, plant_id),
            ).fetchone(),
            "Plant is not in this round.",
        )
        if db.execute(
            "SELECT 1 FROM plant_checks WHERE round_id=? AND plant_id=?", (round_id, plant_id)
        ).fetchone():
            raise HTTPException(409, "This plant has already been checked in this round.")
        cursor = db.execute(
            """INSERT INTO plant_checks(plant_id,round_id,care_date,outcome,created_at,updated_at)
               VALUES (?,?,?,?,?,?)""",
            (plant_id, round_id, care_day.isoformat(), payload.outcome, timestamp, timestamp),
        )
        check_id = cursor.lastrowid
        if payload.outcome == "watered":
            watering = db.execute(
                """INSERT INTO watering_events(plant_id,care_date,note,source_check_id,created_at,updated_at)
                   VALUES (?,?,?,?,?,?)""",
                (plant_id, care_day.isoformat(), payload.note, check_id, timestamp, timestamp),
            )
            db.execute(
                "UPDATE plant_checks SET watering_event_id=? WHERE id=?",
                (watering.lastrowid, check_id),
            )
        refresh_round_status(db, round_id)
        return {
            "check": dict(
                require_row(
                    db.execute("SELECT * FROM plant_checks WHERE id=?", (check_id,)).fetchone()
                )
            ),
            "dashboard": dashboard_payload(db, today()),
        }


@app.post("/api/plants/{plant_id}/checks")
def record_ad_hoc_check(plant_id: int, payload: CheckInput):
    care_day = parse_date(payload.care_date) if payload.care_date else today()
    timestamp = now()
    with transaction() as db:
        require_row(
            db.execute("SELECT id FROM plants WHERE id=?", (plant_id,)).fetchone(),
            "Plant not found.",
        )
        cursor = db.execute(
            "INSERT INTO plant_checks(plant_id,care_date,outcome,created_at,updated_at) VALUES (?,?,?,?,?)",
            (plant_id, care_day.isoformat(), payload.outcome, timestamp, timestamp),
        )
        check_id = cursor.lastrowid
        if payload.outcome == "watered":
            watering = db.execute(
                """INSERT INTO watering_events(plant_id,care_date,note,source_check_id,created_at,updated_at)
                   VALUES (?,?,?,?,?,?)""",
                (plant_id, care_day.isoformat(), payload.note, check_id, timestamp, timestamp),
            )
            db.execute(
                "UPDATE plant_checks SET watering_event_id=? WHERE id=?",
                (watering.lastrowid, check_id),
            )
        return dict(
            require_row(db.execute("SELECT * FROM plant_checks WHERE id=?", (check_id,)).fetchone())
        )


@app.put("/api/checks/{check_id}")
def update_check(check_id: int, payload: CheckInput):
    care_day = parse_date(payload.care_date) if payload.care_date else today()
    with transaction() as db:
        check = require_row(
            db.execute("SELECT * FROM plant_checks WHERE id=?", (check_id,)).fetchone(),
            "Check not found.",
        )
        if (
            check["outcome"] == "watered"
            and payload.outcome == "not_watered"
            and check["watering_event_id"]
        ):
            db.execute("DELETE FROM watering_events WHERE id=?", (check["watering_event_id"],))
            watering_id = None
        elif payload.outcome == "watered" and not check["watering_event_id"]:
            cursor = db.execute(
                """INSERT INTO watering_events(plant_id,care_date,note,source_check_id,created_at,updated_at)
                   VALUES (?,?,?,?,?,?)""",
                (check["plant_id"], care_day.isoformat(), payload.note, check_id, now(), now()),
            )
            watering_id = cursor.lastrowid
        else:
            watering_id = check["watering_event_id"]
            if watering_id:
                db.execute(
                    "UPDATE watering_events SET care_date=?,note=?,updated_at=? WHERE id=?",
                    (care_day.isoformat(), payload.note, now(), watering_id),
                )
        db.execute(
            "UPDATE plant_checks SET outcome=?,care_date=?,watering_event_id=?,updated_at=? WHERE id=?",
            (payload.outcome, care_day.isoformat(), watering_id, now(), check_id),
        )
        return dict(
            require_row(db.execute("SELECT * FROM plant_checks WHERE id=?", (check_id,)).fetchone())
        )


@app.delete("/api/checks/{check_id}")
def delete_check(check_id: int):
    with transaction() as db:
        check = require_row(
            db.execute("SELECT * FROM plant_checks WHERE id=?", (check_id,)).fetchone(),
            "Check not found.",
        )
        round_id = check["round_id"]
        if check["watering_event_id"]:
            db.execute("DELETE FROM watering_events WHERE id=?", (check["watering_event_id"],))
        db.execute("DELETE FROM plant_checks WHERE id=?", (check_id,))
        if round_id:
            db.execute(
                "UPDATE inspection_rounds SET status='open',closed_at=NULL WHERE id=?", (round_id,)
            )
        return Response(status_code=204)


@app.post("/api/plants/{plant_id}/waterings", status_code=201)
def create_watering(plant_id: int, payload: WateringInput):
    care_day = parse_date(payload.care_date) if payload.care_date else today()
    with transaction() as db:
        require_row(
            db.execute("SELECT id FROM plants WHERE id=?", (plant_id,)).fetchone(),
            "Plant not found.",
        )
        cursor = db.execute(
            "INSERT INTO watering_events(plant_id,care_date,note,created_at,updated_at) VALUES (?,?,?,?,?)",
            (plant_id, care_day.isoformat(), payload.note, now(), now()),
        )
        return dict(
            require_row(
                db.execute(
                    "SELECT * FROM watering_events WHERE id=?", (cursor.lastrowid,)
                ).fetchone()
            )
        )


@app.put("/api/waterings/{watering_id}")
def update_watering(watering_id: int, payload: WateringInput):
    care_day = parse_date(payload.care_date) if payload.care_date else today()
    with transaction() as db:
        water = require_row(
            db.execute("SELECT * FROM watering_events WHERE id=?", (watering_id,)).fetchone(),
            "Watering not found.",
        )
        db.execute(
            "UPDATE watering_events SET care_date=?,note=?,updated_at=? WHERE id=?",
            (care_day.isoformat(), payload.note, now(), watering_id),
        )
        if water["source_check_id"]:
            db.execute(
                "UPDATE plant_checks SET care_date=?,updated_at=? WHERE id=?",
                (care_day.isoformat(), now(), water["source_check_id"]),
            )
        return dict(
            require_row(
                db.execute("SELECT * FROM watering_events WHERE id=?", (watering_id,)).fetchone()
            )
        )


@app.delete("/api/waterings/{watering_id}")
def delete_watering(watering_id: int):
    with transaction() as db:
        water = require_row(
            db.execute("SELECT * FROM watering_events WHERE id=?", (watering_id,)).fetchone(),
            "Watering not found.",
        )
        if water["source_check_id"]:
            raise HTTPException(409, "Edit or delete the linked check instead.")
        db.execute("DELETE FROM watering_events WHERE id=?", (watering_id,))
        return Response(status_code=204)


@app.get("/api/plants/{plant_id}/journal")
def list_journal(plant_id: int):
    with connect() as db:
        require_row(
            db.execute("SELECT id FROM plants WHERE id=?", (plant_id,)).fetchone(),
            "Plant not found.",
        )
        return [
            dict(row)
            for row in db.execute(
                "SELECT * FROM journal_entries WHERE plant_id=? ORDER BY care_date DESC,id DESC",
                (plant_id,),
            )
        ]


@app.post("/api/plants/{plant_id}/journal", status_code=201)
def create_journal(plant_id: int, payload: JournalInput):
    care_day = parse_date(payload.care_date)
    with transaction() as db:
        require_row(
            db.execute("SELECT id FROM plants WHERE id=?", (plant_id,)).fetchone(),
            "Plant not found.",
        )
        cursor = db.execute(
            "INSERT INTO journal_entries(plant_id,care_date,body,created_at,updated_at) VALUES (?,?,?,?,?)",
            (plant_id, care_day.isoformat(), payload.body.strip(), now(), now()),
        )
        return dict(
            require_row(
                db.execute(
                    "SELECT * FROM journal_entries WHERE id=?", (cursor.lastrowid,)
                ).fetchone()
            )
        )


@app.put("/api/journal/{entry_id}")
def update_journal(entry_id: int, payload: JournalInput):
    care_day = parse_date(payload.care_date)
    with transaction() as db:
        require_row(
            db.execute("SELECT id FROM journal_entries WHERE id=?", (entry_id,)).fetchone(),
            "Journal entry not found.",
        )
        db.execute(
            "UPDATE journal_entries SET care_date=?,body=?,updated_at=? WHERE id=?",
            (care_day.isoformat(), payload.body.strip(), now(), entry_id),
        )
        return dict(
            require_row(
                db.execute("SELECT * FROM journal_entries WHERE id=?", (entry_id,)).fetchone()
            )
        )


@app.delete("/api/journal/{entry_id}")
def delete_journal(entry_id: int):
    with transaction() as db:
        require_row(
            db.execute("SELECT id FROM journal_entries WHERE id=?", (entry_id,)).fetchone(),
            "Journal entry not found.",
        )
        db.execute("DELETE FROM journal_entries WHERE id=?", (entry_id,))
        return Response(status_code=204)


def process_image(raw: bytes) -> tuple[bytes, bytes, int, int]:
    if len(raw) > MAX_UPLOAD_BYTES:
        raise HTTPException(413, "Photo is larger than 50 MiB.")
    try:
        image = Image.open(io.BytesIO(raw))
        image = ImageOps.exif_transpose(image).convert("RGB")
    except Exception as error:
        raise HTTPException(422, "The upload is not a supported image.") from error
    image.thumbnail((MAX_EDGE, MAX_EDGE), Image.Resampling.LANCZOS)
    output = io.BytesIO()
    image.save(output, format="JPEG", quality=82, optimize=True)
    full = output.getvalue()
    if len(full) > MAX_STORED_BYTES:
        raise HTTPException(413, "Processed photo exceeds 5 MiB.")
    thumbnail = image.copy()
    thumbnail.thumbnail((THUMB_EDGE, THUMB_EDGE), Image.Resampling.LANCZOS)
    thumb_output = io.BytesIO()
    thumbnail.save(thumb_output, format="JPEG", quality=82, optimize=True)
    return full, thumb_output.getvalue(), image.width, image.height


@app.post("/api/plants/{plant_id}/photos", status_code=201)
async def upload_photo(
    plant_id: int,
    file: UploadFile = File(...),
    caption: str = Form(default=""),
    journal_entry_id: int | None = Form(default=None),
):
    raw = await file.read(MAX_UPLOAD_BYTES + 1)
    full, thumbnail, width, height = process_image(raw)
    with transaction() as db:
        require_row(
            db.execute("SELECT id FROM plants WHERE id=?", (plant_id,)).fetchone(),
            "Plant not found.",
        )
        if journal_entry_id:
            entry = require_row(
                db.execute(
                    "SELECT * FROM journal_entries WHERE id=?", (journal_entry_id,)
                ).fetchone(),
                "Journal entry not found.",
            )
            if entry["plant_id"] != plant_id:
                raise HTTPException(422, "Journal entry belongs to a different plant.")
        cursor = db.execute(
            """INSERT INTO photos(plant_id,journal_entry_id,caption,image,thumbnail,width,height,created_at)
               VALUES (?,?,?,?,?,?,?,?)""",
            (plant_id, journal_entry_id, caption[:500], full, thumbnail, width, height, now()),
        )
        return {"id": cursor.lastrowid, "width": width, "height": height}


@app.get("/api/photos/{photo_id}")
def get_photo(photo_id: int, thumbnail: bool = False):
    with connect() as db:
        row = require_row(
            db.execute("SELECT * FROM photos WHERE id=?", (photo_id,)).fetchone(),
            "Photo not found.",
        )
        return Response(
            content=row["thumbnail"] if thumbnail else row["image"],
            media_type=row["mime_type"],
            headers={"Cache-Control": "private, max-age=86400"},
        )


@app.post("/api/photos/{photo_id}/cover")
def choose_cover(photo_id: int):
    with transaction() as db:
        photo = require_row(
            db.execute("SELECT * FROM photos WHERE id=?", (photo_id,)).fetchone(),
            "Photo not found.",
        )
        db.execute("UPDATE photos SET is_cover=0 WHERE plant_id=?", (photo["plant_id"],))
        db.execute("UPDATE photos SET is_cover=1 WHERE id=?", (photo_id,))
        return {"cover_photo_id": photo_id}


@app.delete("/api/photos/{photo_id}")
def delete_photo(photo_id: int):
    with transaction() as db:
        require_row(
            db.execute("SELECT id FROM photos WHERE id=?", (photo_id,)).fetchone(),
            "Photo not found.",
        )
        db.execute("DELETE FROM photos WHERE id=?", (photo_id,))
        return Response(status_code=204)


@app.get("/api/fertilizers")
def list_fertilizers(include_archived: bool = False):
    with connect() as db:
        where = "" if include_archived else "WHERE archived_at IS NULL"
        return [
            dict(row)
            for row in db.execute(f"SELECT * FROM fertilizer_products {where} ORDER BY lower(name)")
        ]


@app.post("/api/fertilizers", status_code=201)
def create_fertilizer(payload: ProductInput):
    with transaction() as db:
        cursor = db.execute(
            "INSERT INTO fertilizer_products(name,description,created_at,updated_at) VALUES (?,?,?,?)",
            (payload.name.strip(), payload.description, now(), now()),
        )
        return dict(
            require_row(
                db.execute(
                    "SELECT * FROM fertilizer_products WHERE id=?", (cursor.lastrowid,)
                ).fetchone()
            )
        )


@app.put("/api/fertilizers/{product_id}")
def update_fertilizer(product_id: int, payload: ProductInput):
    with transaction() as db:
        require_row(
            db.execute("SELECT id FROM fertilizer_products WHERE id=?", (product_id,)).fetchone(),
            "Fertilizer product not found.",
        )
        db.execute(
            "UPDATE fertilizer_products SET name=?,description=?,updated_at=? WHERE id=?",
            (payload.name.strip(), payload.description, now(), product_id),
        )
        return dict(
            require_row(
                db.execute("SELECT * FROM fertilizer_products WHERE id=?", (product_id,)).fetchone()
            )
        )


@app.post("/api/fertilizers/{product_id}/archive")
def archive_fertilizer(product_id: int):
    with transaction() as db:
        require_row(
            db.execute("SELECT id FROM fertilizer_products WHERE id=?", (product_id,)).fetchone(),
            "Fertilizer product not found.",
        )
        db.execute(
            "UPDATE fertilizer_products SET archived_at=?,updated_at=? WHERE id=?",
            (now(), now(), product_id),
        )
        return {"archived": True}


@app.post("/api/plants/{plant_id}/fertilizer-events", status_code=201)
def create_fertilizer_event(plant_id: int, payload: FertilizerInput):
    care_day = parse_date(payload.care_date)
    with transaction() as db:
        require_row(
            db.execute("SELECT id FROM plants WHERE id=?", (plant_id,)).fetchone(),
            "Plant not found.",
        )
        require_row(
            db.execute(
                "SELECT id FROM fertilizer_products WHERE id=?", (payload.product_id,)
            ).fetchone(),
            "Fertilizer product not found.",
        )
        if payload.watering_event_id:
            water = require_row(
                db.execute(
                    "SELECT * FROM watering_events WHERE id=?", (payload.watering_event_id,)
                ).fetchone(),
                "Watering not found.",
            )
            if water["plant_id"] != plant_id:
                raise HTTPException(422, "Watering belongs to a different plant.")
        cursor = db.execute(
            """INSERT INTO fertilizer_events(plant_id,product_id,care_date,amount,dilution,method,note,watering_event_id,created_at,updated_at)
               VALUES (?,?,?,?,?,?,?,?,?,?)""",
            (
                plant_id,
                payload.product_id,
                care_day.isoformat(),
                payload.amount,
                payload.dilution,
                payload.method,
                payload.note,
                payload.watering_event_id,
                now(),
                now(),
            ),
        )
        return dict(
            require_row(
                db.execute(
                    "SELECT * FROM fertilizer_events WHERE id=?", (cursor.lastrowid,)
                ).fetchone()
            )
        )


@app.put("/api/fertilizer-events/{event_id}")
def update_fertilizer_event(event_id: int, payload: FertilizerInput):
    care_day = parse_date(payload.care_date)
    with transaction() as db:
        require_row(
            db.execute("SELECT * FROM fertilizer_events WHERE id=?", (event_id,)).fetchone(),
            "Fertilizer event not found.",
        )
        require_row(
            db.execute(
                "SELECT id FROM fertilizer_products WHERE id=?", (payload.product_id,)
            ).fetchone(),
            "Fertilizer product not found.",
        )
        db.execute(
            """UPDATE fertilizer_events SET product_id=?,care_date=?,amount=?,dilution=?,method=?,note=?,watering_event_id=?,updated_at=? WHERE id=?""",
            (
                payload.product_id,
                care_day.isoformat(),
                payload.amount,
                payload.dilution,
                payload.method,
                payload.note,
                payload.watering_event_id,
                now(),
                event_id,
            ),
        )
        return dict(
            require_row(
                db.execute("SELECT * FROM fertilizer_events WHERE id=?", (event_id,)).fetchone()
            )
        )


@app.delete("/api/fertilizer-events/{event_id}")
def delete_fertilizer_event(event_id: int):
    with transaction() as db:
        require_row(
            db.execute("SELECT id FROM fertilizer_events WHERE id=?", (event_id,)).fetchone(),
            "Fertilizer event not found.",
        )
        db.execute("DELETE FROM fertilizer_events WHERE id=?", (event_id,))
        return Response(status_code=204)


def timeline(db: sqlite3.Connection, plant_id: int) -> list[dict]:
    events = []
    events.extend(
        event_payload(db, row, "check")
        for row in db.execute("SELECT * FROM plant_checks WHERE plant_id=?", (plant_id,))
    )
    events.extend(
        event_payload(db, row, "watering")
        for row in db.execute("SELECT * FROM watering_events WHERE plant_id=?", (plant_id,))
    )
    events.extend(
        event_payload(db, row, "journal")
        for row in db.execute("SELECT * FROM journal_entries WHERE plant_id=?", (plant_id,))
    )
    events.extend(
        event_payload(db, row, "fertilizer")
        for row in db.execute("SELECT * FROM fertilizer_events WHERE plant_id=?", (plant_id,))
    )
    events.extend(
        event_payload(db, row, "photo")
        for row in db.execute(
            "SELECT id,plant_id,journal_entry_id,caption,created_at,is_cover FROM photos WHERE plant_id=?",
            (plant_id,),
        )
    )
    return sorted(
        events,
        key=lambda item: (item.get("care_date", item["created_at"][:10]), item["id"]),
        reverse=True,
    )


@app.get("/api/backups/download")
def download_backup():
    source_path = database_path()
    temp_path = (
        source_path.parent
        / f"plant-care-backup-{datetime.now(TZ).strftime('%Y%m%d-%H%M%S')}.sqlite3"
    )
    with exclusive_database_access():
        source = connect(source_path)
        target = sqlite3.connect(temp_path)
        try:
            source.backup(target)
        finally:
            target.close()
            source.close()
    data = temp_path.read_bytes()
    temp_path.unlink(missing_ok=True)
    return Response(
        content=data,
        media_type="application/x-sqlite3",
        headers={"Content-Disposition": f'attachment; filename="{temp_path.name}"'},
    )


def validate_backup(path: Path) -> None:
    with sqlite3.connect(path) as db:
        db.row_factory = sqlite3.Row
        integrity = db.execute("PRAGMA integrity_check").fetchone()[0]
        if integrity != "ok":
            raise HTTPException(422, "Backup integrity check failed.")
        foreign_keys = db.execute("PRAGMA foreign_key_check").fetchall()
        if foreign_keys:
            raise HTTPException(422, "Backup foreign-key check failed.")
        try:
            metadata = {
                row["key"]: row["value"] for row in db.execute("SELECT key,value FROM app_metadata")
            }
        except sqlite3.DatabaseError as error:
            raise HTTPException(422, "This is not a Plant Care backup.") from error
        if (
            metadata.get("app_id") != APP_ID
            or int(metadata.get("schema_version", "0")) > SCHEMA_VERSION
        ):
            raise HTTPException(422, "Backup is not compatible with this Plant Care version.")


@app.post("/api/backups/restore-upload")
async def restore_backup(file: UploadFile = File(...), confirmation: str = Form(default="")):
    if confirmation != "RESTORE":
        raise HTTPException(422, "Type RESTORE to replace the current database.")
    raw = await file.read(100 * 1024 * 1024)
    if not raw:
        raise HTTPException(422, "Choose a backup file.")
    target = database_path()
    target.parent.mkdir(parents=True, exist_ok=True)
    upload_path = target.parent / f".restore-{uuid.uuid4()}.sqlite3"
    upload_path.write_bytes(raw)
    try:
        validate_backup(upload_path)
        with exclusive_database_access():
            snapshot = (
                target.parent
                / f"plant-care-pre-restore-{datetime.now(TZ).strftime('%Y%m%d-%H%M%S')}.sqlite3"
            )
            live = connect(target)
            backup = sqlite3.connect(snapshot)
            try:
                live.backup(backup)
            finally:
                backup.close()
                live.close()
            restored = sqlite3.connect(upload_path)
            destination = sqlite3.connect(target)
            try:
                restored.backup(destination)
            finally:
                destination.close()
                restored.close()
        validate_backup(target)
    finally:
        upload_path.unlink(missing_ok=True)
    return {"restored": True}


frontend_dist = Path(__file__).resolve().parents[2] / "frontend" / "dist"
if frontend_dist.exists():
    app.mount("/assets", StaticFiles(directory=frontend_dist / "assets"), name="assets")

    @app.get("/{path:path}", include_in_schema=False)
    def frontend(path: str):
        candidate = frontend_dist / path
        if path and candidate.is_file():
            return FileResponse(candidate)
        return FileResponse(frontend_dist / "index.html")

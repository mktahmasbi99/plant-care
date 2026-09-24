from __future__ import annotations

import io
import sqlite3
from datetime import date, datetime, timedelta

from fastapi.testclient import TestClient
from PIL import Image

import app.main as main_module
from app.database import backup_settings, initialize, run_scheduled_backups
from app.main import app


def client_for(tmp_path, monkeypatch):
    monkeypatch.setenv("PLANT_CARE_DB", str(tmp_path / "plant-care.sqlite3"))
    initialize()
    return TestClient(app)


def make_plant(client, **overrides):
    data = {
        "species": "Monstera deliciosa",
        "nickname": "Kitchen Monstera",
        "location": "Kitchen",
    }
    data.update(overrides)
    response = client.post("/api/plants", json=data)
    assert response.status_code == 201
    return response.json()


def test_dashboard_learns_a_tentative_gap_and_shows_two_amber_levels(tmp_path, monkeypatch):
    client = client_for(tmp_path, monkeypatch)
    plant = make_plant(client, initial_last_watered="2026-01-01")
    assert "recommendation" not in plant
    with sqlite3.connect(tmp_path / "plant-care.sqlite3") as db:
        assert db.execute("SELECT COUNT(*) FROM watering_recommendations").fetchone()[0] == 0
    assert (
        client.post(
            f"/api/plants/{plant['id']}/waterings", json={"care_date": "2026-01-15"}
        ).status_code
        == 201
    )
    before = client.get("/api/dashboard?day=2026-01-28").json()["plants"][0]
    assert before["watering_signal"] == {
        "level": "neutral",
        "days_since": 13,
        "estimated_interval_days": 14,
        "interval_count": 1,
        "snoozed_until": None,
    }
    assert (
        client.get("/api/dashboard?day=2026-01-29").json()["plants"][0]["watering_signal"]["level"]
        == "amber"
    )
    assert (
        client.get("/api/dashboard?day=2026-02-12").json()["plants"][0]["watering_signal"]["level"]
        == "strong_amber"
    )


def test_recent_gaps_have_double_the_weight_and_same_day_records_do_not_count(
    tmp_path, monkeypatch
):
    client = client_for(tmp_path, monkeypatch)
    plant = make_plant(client, initial_last_watered="2026-01-01")
    for day in ("2026-01-08", "2026-01-22", "2026-02-19", "2026-02-19"):
        assert (
            client.post(f"/api/plants/{plant['id']}/waterings", json={"care_date": day}).status_code
            == 201
        )
    signal = client.get("/api/dashboard?day=2026-02-20").json()["plants"][0]["watering_signal"]
    assert signal["interval_count"] == 3
    assert signal["estimated_interval_days"] == 21


def test_only_five_most_recent_gaps_are_used(tmp_path, monkeypatch):
    client = client_for(tmp_path, monkeypatch)
    plant = make_plant(client, initial_last_watered="2026-01-01")
    for day in ("2026-04-01", "2026-04-08", "2026-04-15", "2026-04-22", "2026-04-29", "2026-05-06"):
        client.post(f"/api/plants/{plant['id']}/waterings", json={"care_date": day})
    signal = client.get("/api/dashboard?day=2026-05-07").json()["plants"][0]["watering_signal"]
    assert signal["interval_count"] == 5
    assert signal["estimated_interval_days"] == 7


def test_snooze_returns_on_selected_day_and_watering_clears_it(tmp_path, monkeypatch):
    client = client_for(tmp_path, monkeypatch)
    monkeypatch.setattr(main_module, "today", lambda: date(2026, 1, 29))
    plant = make_plant(client, initial_last_watered="2026-01-01")
    client.post(f"/api/plants/{plant['id']}/waterings", json={"care_date": "2026-01-15"})
    assert (
        client.put(
            f"/api/plants/{plant['id']}/snooze", json={"until_date": "2026-01-29"}
        ).status_code
        == 422
    )
    assert (
        client.put(
            f"/api/plants/{plant['id']}/snooze", json={"until_date": "2026-02-12"}
        ).status_code
        == 200
    )
    assert all(
        event["type"] == "watering"
        for event in client.get(f"/api/plants/{plant['id']}").json()["timeline"]
    )
    assert (
        client.get("/api/dashboard?day=2026-02-11").json()["plants"][0]["watering_signal"]["level"]
        == "snoozed"
    )
    assert (
        client.get("/api/dashboard?day=2026-02-12").json()["plants"][0]["watering_signal"]["level"]
        == "strong_amber"
    )
    assert (
        client.post(
            f"/api/plants/{plant['id']}/checks",
            json={"outcome": "watered", "care_date": "2026-02-02"},
        ).status_code
        == 200
    )
    signal = client.get("/api/dashboard?day=2026-02-04").json()["plants"][0]["watering_signal"]
    assert signal["snoozed_until"] is None
    assert signal["level"] == "neutral"


def test_recheck_must_be_after_care_date(tmp_path, monkeypatch):
    client = client_for(tmp_path, monkeypatch)
    plant = make_plant(client)
    response = client.post(
        f"/api/plants/{plant['id']}/checks",
        json={"outcome": "not_watered", "care_date": "2026-09-22", "next_check_date": "2026-09-22"},
    )
    assert response.status_code == 422


def test_watering_history_date_can_change_or_be_deleted_with_its_linked_check(
    tmp_path, monkeypatch
):
    client = client_for(tmp_path, monkeypatch)
    plant = make_plant(client, initial_last_watered="2026-09-10")
    check = client.post(
        f"/api/plants/{plant['id']}/checks",
        json={"outcome": "watered", "care_date": "2026-09-20"},
    )
    assert check.status_code == 200
    detail = client.get(f"/api/plants/{plant['id']}").json()
    watering = next(event for event in detail["timeline"] if event["type"] == "watering")
    assert (
        client.put(f"/api/waterings/{watering['id']}", json={"care_date": "2026-09-22"}).status_code
        == 200
    )
    updated = client.get(f"/api/plants/{plant['id']}").json()
    assert updated["last_watered"] == "2026-09-22"
    assert updated["watering_signal"]["estimated_interval_days"] == 12
    assert client.delete(f"/api/waterings/{watering['id']}").status_code == 204
    after_delete = client.get(f"/api/plants/{plant['id']}").json()
    assert after_delete["watering_signal"]["estimated_interval_days"] is None
    assert not [event for event in after_delete["timeline"] if event["type"] == "check"]
    assert len([event for event in after_delete["timeline"] if event["type"] == "watering"]) == 1


def test_v2_upgrade_keeps_history_and_carries_pending_recheck_into_snooze(tmp_path, monkeypatch):
    client = client_for(tmp_path, monkeypatch)
    plant = make_plant(client, initial_last_watered="2026-09-10")
    check = client.post(
        f"/api/plants/{plant['id']}/checks",
        json={"outcome": "not_watered", "care_date": "2026-09-20", "next_check_date": "2026-09-30"},
    )
    assert check.status_code == 200
    path = tmp_path / "plant-care.sqlite3"
    with sqlite3.connect(path) as db:
        db.execute("ALTER TABLE plants DROP COLUMN snoozed_until")
        db.execute("UPDATE app_metadata SET value='2' WHERE key='schema_version'")
        db.execute(
            """INSERT INTO watering_recommendations
               (plant_id,cadence_kind,cadence_value,effective_from,source,created_at)
               VALUES (?,'days',14,'2026-09-01','manual','2026-09-01')""",
            (plant["id"],),
        )
    initialize(path)
    pending = client.get("/api/dashboard?day=2026-09-24").json()["plants"][0]
    assert pending["watering_signal"]["snoozed_until"] == "2026-09-30"
    assert pending["watering_signal"]["level"] == "snoozed"
    assert (
        client.get("/api/dashboard?day=2026-09-30").json()["plants"][0]["watering_signal"]["level"]
        == "amber"
    )
    detail = client.get(f"/api/plants/{plant['id']}").json()
    assert any(
        event["type"] == "check" and event["outcome"] == "not_watered"
        for event in detail["timeline"]
    )
    with sqlite3.connect(path) as db:
        assert db.execute("SELECT cadence_value FROM watering_recommendations").fetchone()[0] == 14


def test_order_is_persisted_and_requires_every_active_plant(tmp_path, monkeypatch):
    client = client_for(tmp_path, monkeypatch)
    first = make_plant(client, nickname="First")
    second = make_plant(client, nickname="Second")
    assert (
        client.put("/api/plants/order", json={"plant_ids": [second["id"], first["id"]]}).status_code
        == 200
    )
    assert [plant["id"] for plant in client.get("/api/dashboard").json()["plants"]] == [
        second["id"],
        first["id"],
    ]
    assert client.put("/api/plants/order", json={"plant_ids": [first["id"]]}).status_code == 409


def test_delete_is_irreversible_and_requires_typed_confirmation(tmp_path, monkeypatch):
    client = client_for(tmp_path, monkeypatch)
    plant = make_plant(client)
    assert client.delete(f"/api/plants/{plant['id']}").status_code == 422
    assert client.delete(f"/api/plants/{plant['id']}?confirmation=DELETE").status_code == 204
    assert client.get(f"/api/plants/{plant['id']}").status_code == 404
    safety = [
        item for item in client.get("/api/backups").json() if item["category"] == "pre-delete"
    ]
    assert len(safety) == 1


def test_v1_database_migrates_current_cadence_and_closes_open_rounds(tmp_path, monkeypatch):
    path = tmp_path / "plant-care.sqlite3"
    db = sqlite3.connect(path)
    db.executescript("""
      CREATE TABLE app_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO app_metadata VALUES ('app_id', 'plant-care'); INSERT INTO app_metadata VALUES ('schema_version', '1');
      CREATE TABLE plants (id INTEGER PRIMARY KEY, species TEXT NOT NULL, nickname TEXT, location TEXT, care_note TEXT NOT NULL DEFAULT '', archived_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      INSERT INTO plants VALUES (1, 'Fern', '', '', '', NULL, '2026-01-01', '2026-01-01');
      CREATE TABLE watering_recommendations (id INTEGER PRIMARY KEY, plant_id INTEGER NOT NULL, cadence_kind TEXT NOT NULL, cadence_value INTEGER NOT NULL, effective_from TEXT NOT NULL, effective_to TEXT, source TEXT NOT NULL DEFAULT 'manual', created_at TEXT NOT NULL);
      INSERT INTO watering_recommendations VALUES (1, 1, 'weekly', 2, '2026-01-01', NULL, 'manual', '2026-01-01');
      CREATE TABLE inspection_rounds (id INTEGER PRIMARY KEY, scheduled_date TEXT NOT NULL UNIQUE, status TEXT NOT NULL, created_at TEXT NOT NULL, closed_at TEXT);
      INSERT INTO inspection_rounds VALUES (1, '2026-01-02', 'open', '2026-01-02', NULL);
      CREATE TABLE plant_checks (id INTEGER PRIMARY KEY, plant_id INTEGER NOT NULL, round_id INTEGER, care_date TEXT NOT NULL, outcome TEXT NOT NULL, watering_event_id INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE round_members (round_id INTEGER NOT NULL, plant_id INTEGER NOT NULL, excluded_at TEXT, PRIMARY KEY(round_id, plant_id));
      CREATE TABLE watering_events (id INTEGER PRIMARY KEY, plant_id INTEGER NOT NULL, care_date TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', source_check_id INTEGER UNIQUE, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    """)
    db.commit()
    db.close()
    monkeypatch.setenv("PLANT_CARE_DB", str(path))
    initialize()
    db = sqlite3.connect(path)
    db.row_factory = sqlite3.Row
    assert db.execute("SELECT sort_position FROM plants WHERE id=1").fetchone()[0] == 0
    assert tuple(
        db.execute(
            "SELECT cadence_kind,cadence_value FROM watering_recommendations WHERE effective_to IS NULL"
        ).fetchone()
    ) == ("days", 4)
    assert (
        db.execute("SELECT status FROM inspection_rounds WHERE id=1").fetchone()[0] == "incomplete"
    )
    assert "next_check_date" in {row[1] for row in db.execute("PRAGMA table_info(plant_checks)")}
    db.close()


def test_backup_restore_keeps_valid_plant_data(tmp_path, monkeypatch):
    client = client_for(tmp_path, monkeypatch)
    plant = make_plant(client)
    backup = client.get("/api/backups/download")
    assert client.post(f"/api/plants/{plant['id']}/archive").status_code == 200
    restored = client.post(
        "/api/backups/restore-upload",
        data={"confirmation": "RESTORE"},
        files={"file": ("backup.sqlite3", backup.content, "application/x-sqlite3")},
    )
    assert restored.status_code == 200
    assert client.get(f"/api/plants/{plant['id']}").json()["archived_at"] is None


def test_managed_backup_has_marker_restores_and_preserves_schedule(tmp_path, monkeypatch):
    client = client_for(tmp_path, monkeypatch)
    before = make_plant(client, nickname="Before")
    created = client.post("/api/backups")
    assert created.status_code == 200
    backups = client.get("/api/backups").json()
    assert backups[0]["category"] == "on-demand"
    filename = backups[0]["filename"]
    assert client.get(f"/api/backups/{filename}/download").status_code == 200
    settings = client.get("/api/backups/settings").json()
    settings.update({"dailyTime": "02:30", "dailyRetention": 3})
    assert client.put("/api/backups/settings", json=settings).status_code == 200
    make_plant(client, nickname="After")
    response = client.post(
        "/api/backups/restore", json={"filename": filename, "confirmation": "RESTORE"}
    )
    assert response.status_code == 200
    assert response.json()["backup"].startswith("pre-restore-")
    assert client.get(f"/api/plants/{before['id']}").status_code == 200
    assert [item["nickname"] for item in client.get("/api/plants").json()] == ["Before"]
    assert client.get("/api/backups/settings").json()["dailyTime"] == "02:30"


def test_unmarked_upload_is_rejected_without_replacing_live_data(tmp_path, monkeypatch):
    client = client_for(tmp_path, monkeypatch)
    plant = make_plant(client)
    with sqlite3.connect(tmp_path / "unmarked.sqlite3") as db:
        db.execute("CREATE TABLE app_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
        db.execute("INSERT INTO app_metadata VALUES ('app_id', 'plant-care')")
        db.execute("INSERT INTO app_metadata VALUES ('schema_version', '4')")
    response = client.post(
        "/api/backups/restore-upload",
        data={"confirmation": "RESTORE"},
        files={
            "file": (
                "unmarked.sqlite3",
                (tmp_path / "unmarked.sqlite3").read_bytes(),
                "application/x-sqlite3",
            )
        },
    )
    assert response.status_code == 422
    assert client.get(f"/api/plants/{plant['id']}").status_code == 200


def test_backup_schedule_catches_up_once_and_retains_only_the_configured_count(
    tmp_path, monkeypatch
):
    client_for(tmp_path, monkeypatch)
    settings = backup_settings()
    settings.update({"weeklyEnabled": False, "dailyRetention": 1})
    with sqlite3.connect(tmp_path / "plant-care.sqlite3") as db:
        db.execute(
            "UPDATE backup_settings SET daily_enabled=1, weekly_enabled=0, daily_retention=1"
        )
    first = datetime(2026, 9, 1, 2, 0, tzinfo=main_module.TZ)
    run_scheduled_backups(first)
    run_scheduled_backups(first + timedelta(days=1))
    run_scheduled_backups(first + timedelta(days=2))
    items = client_for(tmp_path, monkeypatch).get("/api/backups").json()
    assert [item["category"] for item in items] == ["daily"]


def test_photo_is_processed_and_can_become_a_cover(tmp_path, monkeypatch):
    client = client_for(tmp_path, monkeypatch)
    plant = make_plant(client)
    source = io.BytesIO()
    Image.new("RGBA", (3200, 1200), (30, 160, 80, 140)).save(source, format="PNG")
    uploaded = client.post(
        f"/api/plants/{plant['id']}/photos",
        data={"caption": "New leaf"},
        files={"file": ("leaf.png", source.getvalue(), "image/png")},
    )
    assert uploaded.status_code == 201
    photo_id = uploaded.json()["id"]
    assert client.post(f"/api/photos/{photo_id}/cover").status_code == 200
    assert (
        client.get(f"/api/photos/{photo_id}?thumbnail=true").headers["content-type"] == "image/jpeg"
    )

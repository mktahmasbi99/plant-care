from __future__ import annotations

import io
import sqlite3

from fastapi.testclient import TestClient
from PIL import Image

from app.database import initialize
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
        "recommendation": {"interval_days": 4},
    }
    data.update(overrides)
    response = client.post("/api/plants", json=data)
    assert response.status_code == 201
    return response.json()


def test_dashboard_derives_due_date_from_watering_without_creating_rounds(tmp_path, monkeypatch):
    client = client_for(tmp_path, monkeypatch)
    plant = make_plant(client, initial_last_watered="2026-09-18")
    dashboard = client.get("/api/dashboard?day=2026-09-22").json()
    assert dashboard["due_count"] == 1
    assert dashboard["plants"][0]["id"] == plant["id"]
    assert dashboard["plants"][0]["status"] == {
        "status": "due",
        "next_check_date": "2026-09-22",
        "days_until_check": 0,
        "days_since": 4,
    }


def test_not_watered_uses_selected_recheck_and_undo_restores_due_state(tmp_path, monkeypatch):
    client = client_for(tmp_path, monkeypatch)
    plant = make_plant(client, initial_last_watered="2026-09-18")
    check = client.post(
        f"/api/plants/{plant['id']}/checks",
        json={"outcome": "not_watered", "care_date": "2026-09-22", "next_check_date": "2026-09-25"},
    )
    assert check.status_code == 200
    deferred = client.get("/api/dashboard?day=2026-09-22").json()["plants"][0]
    assert deferred["status"]["status"] == "on_track"
    assert deferred["status"]["next_check_date"] == "2026-09-25"
    assert client.delete(f"/api/checks/{check.json()['id']}").status_code == 204
    assert (
        client.get("/api/dashboard?day=2026-09-22").json()["plants"][0]["status"]["status"] == "due"
    )


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
    plant = make_plant(client)
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
    assert client.delete(f"/api/waterings/{watering['id']}").status_code == 204
    after_delete = client.get(f"/api/plants/{plant['id']}").json()
    assert not [
        event for event in after_delete["timeline"] if event["type"] in {"watering", "check"}
    ]


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

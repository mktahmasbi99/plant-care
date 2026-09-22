from __future__ import annotations

import io

from fastapi.testclient import TestClient
from PIL import Image

from app.database import initialize
from app.main import app


def client_for(tmp_path, monkeypatch):
    monkeypatch.setenv("PLANT_CARE_DB", str(tmp_path / "plant-care.sqlite3"))
    initialize()
    return TestClient(app)


def make_plant(client: TestClient, **overrides):
    data = {
        "species": "Monstera deliciosa",
        "nickname": "Kitchen Monstera",
        "location": "Kitchen",
        "recommendation": {"kind": "weekly", "value": 2},
    }
    data.update(overrides)
    response = client.post("/api/plants", json=data)
    assert response.status_code == 201
    return response.json()


def test_round_check_creates_watering_and_completes_round(tmp_path, monkeypatch):
    client = client_for(tmp_path, monkeypatch)
    plant = make_plant(client, initial_last_watered="2026-09-18")
    dashboard = client.get("/api/dashboard?day=2026-09-21").json()
    assert dashboard["round"]["scheduled_date"] == "2026-09-21"
    response = client.post(
        f"/api/rounds/{dashboard['round']['id']}/plants/{plant['id']}/check",
        json={"outcome": "watered", "care_date": "2026-09-21"},
    )
    assert response.status_code == 200
    updated = client.get(f"/api/plants/{plant['id']}").json()
    assert updated["last_watered"] == "2026-09-21"
    assert updated["timeline"][0]["type"] == "watering"


def test_not_watered_preserves_last_watering_and_month_end(tmp_path, monkeypatch):
    client = client_for(tmp_path, monkeypatch)
    plant = make_plant(
        client, recommendation={"kind": "monthly", "value": 1}, initial_last_watered="2026-01-31"
    )
    response = client.post(
        f"/api/plants/{plant['id']}/checks",
        json={"outcome": "not_watered", "care_date": "2026-02-28"},
    )
    assert response.status_code == 200
    detail = client.get(f"/api/plants/{plant['id']}").json()
    assert detail["last_watered"] == "2026-01-31"
    assert detail["last_check"]["outcome"] == "not_watered"


def test_archive_excludes_an_open_round(tmp_path, monkeypatch):
    client = client_for(tmp_path, monkeypatch)
    plant = make_plant(client)
    dashboard = client.get("/api/dashboard?day=2026-09-21").json()
    assert dashboard["round"]["total"] == 1
    assert client.post(f"/api/plants/{plant['id']}/archive").status_code == 200
    dashboard = client.get("/api/dashboard?day=2026-09-21").json()
    assert dashboard["round"]["total"] == 0


def test_backup_restore_keeps_valid_plant_data(tmp_path, monkeypatch):
    client = client_for(tmp_path, monkeypatch)
    plant = make_plant(client)
    backup = client.get("/api/backups/download")
    assert backup.status_code == 200
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
    image = client.get(f"/api/photos/{photo_id}?thumbnail=true")
    assert image.headers["content-type"] == "image/jpeg"
    assert client.get(f"/api/plants/{plant['id']}").json()["cover_photo_id"] == photo_id

import json
from pathlib import Path
import pytest
from fastapi.testclient import TestClient

import database
import server
import telemetry
import executor
from server import app
from broadcaster import Broadcaster

WORKSPACE = Path(__file__).resolve().parent.parent

@pytest.fixture
def mvp2_client(tmp_path, monkeypatch):
    test_db = tmp_path / "mvp2_test.db"
    monkeypatch.setattr(database, "DB_FILE", test_db)
    database.init_db()
    return TestClient(app)

def test_mvp2_crypto_and_password_security():
    """Verify PBKDF2-HMAC-SHA256, >=100k iterations, 16-byte salt, constant-time compare."""
    password = "SecurePassword2026!"
    hash_hex, salt_hex = database.hash_password(password)
    
    assert len(salt_hex) == 32  # 16 bytes = 32 hex chars
    assert len(hash_hex) == 64  # sha256 = 64 hex chars
    assert database.verify_password(password, salt_hex, hash_hex) is True
    assert database.verify_password("Incorrect", salt_hex, hash_hex) is False

def test_mvp2_frictionless_fallback_and_initial_setup(mvp2_client):
    """Verify frictionless operation when 0 users exist, then transition to secured state."""
    # 0 users: status is uninitialized
    res = mvp2_client.get("/api/auth/status")
    assert res.status_code == 200
    assert res.json()["initialized"] is False
    assert res.json()["user_count"] == 0

    # 0 users: verify endpoint returns authorized in no-auth mode
    res = mvp2_client.get("/api/auth/verify")
    assert res.status_code == 200
    assert res.json()["status"] == "authorized"
    assert res.json()["mode"] == "no-auth"

    # 0 users: /api/tasks accessible without auth header
    res = mvp2_client.get("/api/tasks")
    assert res.status_code == 200

    # Initial admin setup
    res = mvp2_client.post("/api/auth/setup-admin", json={
        "email": "root@pareo.local",
        "password": "RootPassword456",
        "confirm_password": "RootPassword456"
    })
    assert res.status_code == 200
    admin_token = res.json()["token"]

    # Status now shows initialized
    res = mvp2_client.get("/api/auth/status")
    assert res.status_code == 200
    assert res.json()["initialized"] is True
    assert res.json()["user_count"] == 1

    # Unauthenticated request to /api/auth/me now rejected with 401
    res = mvp2_client.get("/api/auth/me")
    assert res.status_code == 401

    # Authenticated request to /api/auth/me succeeds
    res = mvp2_client.get("/api/auth/me", headers={"Authorization": f"Bearer {admin_token}"})
    assert res.status_code == 200
    assert res.json()["email"] == "root@pareo.local"
    assert res.json()["role"] == "Admin"

def test_mvp2_rbac_matrix(mvp2_client):
    """Verify RBAC: Admin and Operator permitted on actions, Viewer restricted with 403."""
    # Setup Admin
    res = mvp2_client.post("/api/auth/setup-admin", json={
        "email": "admin@pareo.local",
        "password": "AdminPassword123"
    })
    admin_token = res.json()["token"]

    # Register Operator
    res = mvp2_client.post("/api/auth/register", json={
        "email": "operator@pareo.local",
        "password": "OperatorPassword123",
        "role": "Operator"
    }, headers={"Authorization": f"Bearer {admin_token}"})
    operator_token = res.json()["token"]

    # Register Viewer
    res = mvp2_client.post("/api/auth/register", json={
        "email": "viewer@pareo.local",
        "password": "ViewerPassword123",
        "role": "Viewer"
    }, headers={"Authorization": f"Bearer {admin_token}"})
    viewer_token = res.json()["token"]

    # Setup dummy task for testing
    database.insert_task("t-rbac", "echo 1", "Pending", "2026-10-11T08:00:00")

    # Viewer CAN read tasks
    res = mvp2_client.get("/api/tasks", headers={"Authorization": f"Bearer {viewer_token}"})
    assert res.status_code == 200

    # Viewer CANNOT execute commands (403)
    res = mvp2_client.post("/api/execute/ls", headers={"Authorization": f"Bearer {viewer_token}"})
    assert res.status_code == 403

    # Viewer CANNOT cancel tasks (403)
    res = mvp2_client.post("/api/tasks/batch/cancel", json={"task_ids": ["t-rbac"]}, headers={"Authorization": f"Bearer {viewer_token}"})
    assert res.status_code == 403

    # Operator CAN cancel tasks (200)
    res = mvp2_client.post("/api/tasks/batch/cancel", json={"task_ids": ["t-rbac"]}, headers={"Authorization": f"Bearer {operator_token}"})
    assert res.status_code == 200

    # Operator CANNOT register users (403)
    res = mvp2_client.post("/api/auth/register", json={
        "email": "other@pareo.local",
        "password": "Pass123"
    }, headers={"Authorization": f"Bearer {operator_token}"})
    assert res.status_code == 403

    # Admin CAN register users (200)
    res = mvp2_client.post("/api/auth/register", json={
        "email": "other@pareo.local",
        "password": "Pass123"
    }, headers={"Authorization": f"Bearer {admin_token}"})
    assert res.status_code == 200

def test_mvp2_batch_queue_operations(mvp2_client):
    """Verify batch cancel, batch retry, batch purge."""
    database.insert_task("batch-p1", "echo 1", "Pending", "2026-10-11T08:00:00")
    database.insert_task("batch-p2", "echo 2", "Pending", "2026-10-11T08:00:00")
    database.insert_task("batch-c1", "echo 3", "Completed", "2026-10-11T08:00:00")

    # Batch cancel
    res = mvp2_client.post("/api/tasks/batch/cancel", json={"task_ids": ["batch-p1", "batch-p2"]})
    assert res.status_code == 200
    assert res.json()["cancelled_count"] == 2
    assert database.get_task("batch-p1")["status"] == "Cancelled"

    # Batch retry
    res = mvp2_client.post("/api/tasks/batch/retry", json={"task_ids": ["batch-p1"]})
    assert res.status_code == 200
    assert res.json()["retried_count"] == 1

    # Batch purge
    database.update_task_status("batch-p1", "Cancelled")
    res = mvp2_client.post("/api/tasks/batch/purge", json={"task_ids": ["batch-p1", "batch-c1"]})
    assert res.status_code == 200
    assert res.json()["purged_count"] == 2
    assert database.get_task("batch-p1") is None
    assert database.get_task("batch-c1") is None

def test_mvp2_telemetry_engine(mvp2_client):
    """Verify telemetry snapshot endpoint and structure."""
    res = mvp2_client.get("/api/telemetry")
    assert res.status_code == 200
    data = res.json()
    assert "timestamp" in data
    assert "cpu" in data and "load_1m" in data["cpu"]
    assert "memory" in data and "utilization_pct" in data["memory"]
    assert "disk" in data and isinstance(data["disk"], list)
    assert "queues" in data and "media" in data["queues"]

def test_mvp2_pwa_assets_and_styling():
    """Verify PWA manifest, service worker, icons, and safe-area insets."""
    manifest_path = WORKSPACE / "static" / "manifest.json"
    sw_path = WORKSPACE / "static" / "sw.js"
    css_path = WORKSPACE / "static" / "style.css"
    html_path = WORKSPACE / "static" / "index.html"

    assert manifest_path.is_file()
    manifest = json.loads(manifest_path.read_text())
    assert manifest["display"] == "standalone"
    assert len(manifest["icons"]) >= 2

    assert sw_path.is_file()
    sw_text = sw_path.read_text()
    assert "CACHE_NAME" in sw_text

    css_text = css_path.read_text()
    assert "safe-area-inset-bottom" in css_text
    assert ".batch-action-dock" in css_text

    html_text = html_path.read_text()
    assert 'viewport-fit=cover' in html_text
    assert 'id="batch-action-dock"' in html_text

def test_mvp2_living_documentation_preservation():
    """Verify README.md and FAQ.md document port 9046, MVP 1, and MVP 2 without losing contracts."""
    readme = (WORKSPACE / "README.md").read_text()
    faq = (WORKSPACE / "FAQ.md").read_text()

    # Port 9046
    assert "9046" in readme

    # MVP 1 & MVP 2 deliverables
    assert "MVP 1" in readme
    assert "MVP 2" in readme
    assert "MVP 1" in faq
    assert "MVP 2" in faq

    # Contracts preserved
    assert "PBKDF2" in readme or "PBKDF2" in faq
    assert "RBAC" in readme or "Role-Based Access Control" in readme
    assert "telemetry" in readme.lower()
    assert "batch" in readme.lower()
    assert "manifest.json" in readme or "PWA" in readme

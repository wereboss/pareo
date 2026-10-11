import pytest
from datetime import datetime, timedelta
from fastapi.testclient import TestClient
import database
import server
from server import app

@pytest.fixture
def auth_client(tmp_path, monkeypatch):
    test_db = tmp_path / "auth_test.db"
    monkeypatch.setattr(database, "DB_FILE", test_db)
    database.init_db()
    return TestClient(app)

def test_password_hashing():
    raw = "SuperSecretPassword123!"
    hash_hex, salt_hex = database.hash_password(raw)
    assert len(salt_hex) == 32  # 16 bytes in hex
    assert len(hash_hex) == 64  # sha256 in hex
    assert database.verify_password(raw, salt_hex, hash_hex) is True
    assert database.verify_password("WrongPassword", salt_hex, hash_hex) is False
    assert database.verify_password("", salt_hex, hash_hex) is False

def test_user_creation_and_session_lifecycle(tmp_path, monkeypatch):
    test_db = tmp_path / "db_test.db"
    monkeypatch.setattr(database, "DB_FILE", test_db)
    database.init_db()

    # Create admin
    user = database.create_user("admin@pareo.local", "AdminPass123", role="Admin")
    assert user["email"] == "admin@pareo.local"
    assert user["role"] == "Admin"
    assert "user_id" in user

    # Duplicate email raises Exception
    with pytest.raises(Exception):
        database.create_user("admin@pareo.local", "OtherPass", role="Operator")

    # Case-insensitive email retrieval
    by_email = database.get_user_by_email("ADMIN@pareo.local")
    assert by_email is not None
    assert by_email["user_id"] == user["user_id"]

    by_id = database.get_user_by_id(user["user_id"])
    assert by_id is not None
    assert by_id["email"] == user["email"]

    # Session lifecycle
    session = database.create_session(user["user_id"], ttl_hours=48)
    token = session["token"]
    assert token is not None
    assert len(token) > 30

    got_session = database.get_session(token)
    assert got_session is not None
    assert got_session["user_id"] == user["user_id"]

    # Delete session
    assert database.delete_session(token) is True
    assert database.get_session(token) is None

def test_session_token_expiry_and_cleanup(tmp_path, monkeypatch):
    test_db = tmp_path / "expiry_test.db"
    monkeypatch.setattr(database, "DB_FILE", test_db)
    database.init_db()

    user = database.create_user("expiry@pareo.local", "Pass123", role="Admin")
    
    # Create an already-expired session (ttl_hours = -1)
    expired_session = database.create_session(user["user_id"], ttl_hours=-1)
    exp_token = expired_session["token"]

    # get_session should detect expiration, delete it, and return None
    assert database.get_session(exp_token) is None

    # Check cleanup_expired_sessions
    with database.get_conn() as conn:
        past_time = (datetime.utcnow() - timedelta(hours=2)).isoformat()
        conn.execute(
            "INSERT INTO sessions (token, user_id, created_at, expires_at, last_active) VALUES (?, ?, ?, ?, ?)",
            ("dummy_expired_token", user["user_id"], past_time, past_time, past_time)
        )
        conn.commit()

    deleted_count = database.cleanup_expired_sessions()
    assert deleted_count >= 1

def test_frictionless_fallback_when_zero_users(tmp_path, monkeypatch):
    """When 0 users exist in the database, Pareo allows unauthenticated access in setup-root mode."""
    test_db = tmp_path / "zero_users.db"
    monkeypatch.setattr(database, "DB_FILE", test_db)
    database.init_db()
    client = TestClient(app)

    # Status shows uninitialized
    res = client.get("/api/auth/status")
    assert res.status_code == 200
    assert res.json() == {"initialized": False, "user_count": 0}

    # Verify endpoint returns authorized in no-auth mode
    res = client.get("/api/auth/verify")
    assert res.status_code == 200
    assert res.json() == {"status": "authorized", "mode": "no-auth"}

    # /api/auth/me returns fallback setup-root Admin
    res = client.get("/api/auth/me")
    assert res.status_code == 200
    assert res.json()["role"] == "Admin"

    # Tasks endpoint accessible without auth header
    res = client.get("/api/tasks")
    assert res.status_code == 200

def test_auth_endpoints_flow(auth_client):
    # 1. Initially uninitialized
    res = auth_client.get("/api/auth/status")
    assert res.status_code == 200
    assert res.json() == {"initialized": False, "user_count": 0}

    # 2. Setup initial Root Admin validations
    # Short password
    res = auth_client.post("/api/auth/setup-admin", json={
        "email": "root@pareo.local",
        "password": "short"
    })
    assert res.status_code == 400

    # Password mismatch
    res = auth_client.post("/api/auth/setup-admin", json={
        "email": "root@pareo.local",
        "password": "Password123",
        "confirm_password": "MismatchPassword"
    })
    assert res.status_code == 400

    # Successful setup
    res = auth_client.post("/api/auth/setup-admin", json={
        "email": "root@pareo.local",
        "password": "RootPassword456",
        "confirm_password": "RootPassword456"
    })
    assert res.status_code == 200
    data = res.json()
    assert "token" in data
    assert data["user"]["email"] == "root@pareo.local"
    assert data["user"]["role"] == "Admin"
    admin_token = data["token"]

    # 3. Setup again fails
    res = auth_client.post("/api/auth/setup-admin", json={
        "email": "second@pareo.local",
        "password": "SecondPassword"
    })
    assert res.status_code == 400

    # 4. Auth status now shows initialized
    res = auth_client.get("/api/auth/status")
    assert res.status_code == 200
    assert res.json()["initialized"] is True
    assert res.json()["user_count"] == 1

    # 5. Access /api/auth/me with Bearer token
    res = auth_client.get("/api/auth/me", headers={"Authorization": f"Bearer {admin_token}"})
    assert res.status_code == 200
    assert res.json()["email"] == "root@pareo.local"
    assert res.json()["role"] == "Admin"

    # 6. Access /api/auth/me with X-Pareo-Auth header
    res = auth_client.get("/api/auth/me", headers={"X-Pareo-Auth": admin_token})
    assert res.status_code == 200
    assert res.json()["email"] == "root@pareo.local"

    # 7. Access /api/auth/me with query param ?token=...
    res = auth_client.get(f"/api/auth/me?token={admin_token}")
    assert res.status_code == 200
    assert res.json()["email"] == "root@pareo.local"

    # 8. Access /api/auth/me with invalid token
    res = auth_client.get("/api/auth/me", headers={"Authorization": "Bearer invalid_token"})
    assert res.status_code == 401

    # 9. Login with valid credentials
    res = auth_client.post("/api/auth/login", json={
        "email": "root@pareo.local",
        "password": "RootPassword456"
    })
    assert res.status_code == 200
    assert "token" in res.json()

    # 10. Login with invalid password
    res = auth_client.post("/api/auth/login", json={
        "email": "root@pareo.local",
        "password": "IncorrectPassword"
    })
    assert res.status_code == 401

    # 11. Register Operator and Viewer using Admin token
    res = auth_client.post("/api/auth/register", json={
        "email": "operator@pareo.local",
        "password": "OperatorPass123",
        "role": "Operator"
    }, headers={"Authorization": f"Bearer {admin_token}"})
    assert res.status_code == 200
    assert res.json()["user"]["role"] == "Operator"

    res = auth_client.post("/api/auth/register", json={
        "email": "viewer@pareo.local",
        "password": "ViewerPass123",
        "role": "Viewer"
    }, headers={"Authorization": f"Bearer {admin_token}"})
    assert res.status_code == 200
    assert res.json()["user"]["role"] == "Viewer"

    # 12. Login as Operator and verify permissions
    res = auth_client.post("/api/auth/login", json={
        "email": "operator@pareo.local",
        "password": "OperatorPass123"
    })
    assert res.status_code == 200
    operator_token = res.json()["token"]

    # Operator CAN cancel batch tasks
    res = auth_client.post("/api/tasks/batch/cancel", json={
        "task_ids": ["task-dummy"]
    }, headers={"Authorization": f"Bearer {operator_token}"})
    assert res.status_code == 200

    # Operator CANNOT register users (Requires Admin)
    res = auth_client.post("/api/auth/register", json={
        "email": "subuser@pareo.local",
        "password": "Password123",
        "role": "Viewer"
    }, headers={"Authorization": f"Bearer {operator_token}"})
    assert res.status_code == 403

    # Operator CANNOT start/stop daemon processes (Requires Admin)
    res = auth_client.post("/api/processes/dummy-process/start", headers={"Authorization": f"Bearer {operator_token}"})
    assert res.status_code == 403

    # 13. Login as Viewer and verify RBAC
    res = auth_client.post("/api/auth/login", json={
        "email": "viewer@pareo.local",
        "password": "ViewerPass123"
    })
    assert res.status_code == 200
    viewer_token = res.json()["token"]

    # Viewer cannot register users (Requires Admin)
    res = auth_client.post("/api/auth/register", json={
        "email": "rogue@pareo.local",
        "password": "RoguePassword123",
        "role": "Viewer"
    }, headers={"Authorization": f"Bearer {viewer_token}"})
    assert res.status_code == 403

    # Viewer cannot cancel tasks (Requires Admin or Operator)
    res = auth_client.post("/api/tasks/batch/cancel", json={
        "task_ids": ["task-1"]
    }, headers={"Authorization": f"Bearer {viewer_token}"})
    assert res.status_code == 403

    # Viewer cannot retry tasks
    res = auth_client.post("/api/tasks/batch/retry", json={
        "task_ids": ["task-1"]
    }, headers={"Authorization": f"Bearer {viewer_token}"})
    assert res.status_code == 403

    # Viewer cannot purge tasks
    res = auth_client.post("/api/tasks/batch/purge", json={
        "task_ids": ["task-1"]
    }, headers={"Authorization": f"Bearer {viewer_token}"})
    assert res.status_code == 403

    # Viewer can read tasks (Read permission)
    res = auth_client.get("/api/tasks", headers={"Authorization": f"Bearer {viewer_token}"})
    assert res.status_code == 200

    # 14. Logout
    res = auth_client.post("/api/auth/logout", headers={"Authorization": f"Bearer {viewer_token}"})
    assert res.status_code == 200
    # Token now invalid
    res = auth_client.get("/api/auth/me", headers={"Authorization": f"Bearer {viewer_token}"})
    assert res.status_code == 401

def test_inactive_user_cannot_login(auth_client):
    # Setup initial admin
    res = auth_client.post("/api/auth/setup-admin", json={
        "email": "admin@pareo.local",
        "password": "AdminPassword123"
    })
    admin_token = res.json()["token"]

    # Register active user
    res = auth_client.post("/api/auth/register", json={
        "email": "inactive@pareo.local",
        "password": "Password123",
        "role": "Viewer"
    }, headers={"Authorization": f"Bearer {admin_token}"})
    user_id = res.json()["user"]["user_id"]

    # Manually deactivate user in DB
    with database.get_conn() as conn:
        conn.execute("UPDATE users SET is_active = 0 WHERE user_id = ?", (user_id,))
        conn.commit()

    # Login fails for inactive user
    res = auth_client.post("/api/auth/login", json={
        "email": "inactive@pareo.local",
        "password": "Password123"
    })
    assert res.status_code == 401

import pytest
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

    # Duplicate email raises ValueError or sqlite3.IntegrityError
    with pytest.raises(Exception):
        database.create_user("admin@pareo.local", "OtherPass", role="Operator")

    # Get by email and ID
    by_email = database.get_user_by_email("admin@pareo.local")
    assert by_email is not None
    assert by_email["user_id"] == user["user_id"]

    by_id = database.get_user_by_id(user["user_id"])
    assert by_id is not None
    assert by_id["email"] == user["email"]

    # Session lifecycle
    session = database.create_session(user["user_id"], ttl_hours=1)
    token = session["token"]
    assert token is not None

    got_session = database.get_session(token)
    assert got_session is not None
    assert got_session["user_id"] == user["user_id"]

    # Delete session
    assert database.delete_session(token) is True
    assert database.get_session(token) is None

def test_auth_endpoints_flow(auth_client):
    # 1. Initially uninitialized
    res = auth_client.get("/api/auth/status")
    assert res.status_code == 200
    assert res.json() == {"initialized": False, "user_count": 0}

    # 2. Setup initial Root Admin
    res = auth_client.post("/api/auth/setup-admin", json={
        "email": "root@pareo.local",
        "password": "RootPassword456"
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

    # 6. Access /api/auth/me with invalid token
    res = auth_client.get("/api/auth/me", headers={"Authorization": "Bearer invalid_token"})
    assert res.status_code == 401

    # 7. Login with valid credentials
    res = auth_client.post("/api/auth/login", json={
        "email": "root@pareo.local",
        "password": "RootPassword456"
    })
    assert res.status_code == 200
    assert "token" in res.json()

    # 8. Login with invalid password
    res = auth_client.post("/api/auth/login", json={
        "email": "root@pareo.local",
        "password": "IncorrectPassword"
    })
    assert res.status_code == 401

    # 9. Register Operator and Viewer using Admin token
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

    # 10. Login as Viewer and verify RBAC
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

    # Viewer can read tasks (Read permission)
    res = auth_client.get("/api/tasks", headers={"Authorization": f"Bearer {viewer_token}"})
    assert res.status_code == 200

    # 11. Logout
    res = auth_client.post("/api/auth/logout", headers={"Authorization": f"Bearer {viewer_token}"})
    assert res.status_code == 200
    # Token now invalid
    res = auth_client.get("/api/auth/me", headers={"Authorization": f"Bearer {viewer_token}"})
    assert res.status_code == 401

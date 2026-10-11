from datetime import datetime, timezone
import pytest
from fastapi.testclient import TestClient
import database
import executor
from server import app

@pytest.fixture
def batch_client(tmp_path, monkeypatch):
    test_db = tmp_path / "batch_test.db"
    monkeypatch.setattr(database, "DB_FILE", test_db)
    database.init_db()
    return TestClient(app)

def test_database_batch_cancel_and_purge(tmp_path, monkeypatch):
    test_db = tmp_path / "db_batch.db"
    monkeypatch.setattr(database, "DB_FILE", test_db)
    database.init_db()

    now_iso = datetime.now(timezone.utc).isoformat()

    # Create several tasks using insert_task
    database.insert_task("task-1", "echo 1", "Pending", now_iso, queue_name="default")
    database.insert_task("task-2", "echo 2", "Running", now_iso, queue_name="default")
    database.insert_task("task-3", "echo 3", "Completed", now_iso, queue_name="default")

    # Batch cancel tasks 1, 2, 3
    cancelled = database.batch_cancel_tasks(["task-1", "task-2", "task-3"])
    assert len(cancelled) == 2  # Only Pending and Running are cancelled
    assert set(cancelled) == {"task-1", "task-2"}

    assert database.get_task("task-1")["status"] == "Cancelled"
    assert database.get_task("task-2")["status"] == "Cancelled"
    assert database.get_task("task-3")["status"] == "Completed"

    # Batch purge tasks 1 and 3
    purged = database.batch_purge_tasks(["task-1", "task-3"])
    assert len(purged) == 2
    assert set(purged) == {"task-1", "task-3"}

    assert database.get_task("task-1") is None
    assert database.get_task("task-3") is None
    assert database.get_task("task-2") is not None

def test_batch_api_endpoints(batch_client):
    now_iso = datetime.now(timezone.utc).isoformat()

    # Setup test tasks in DB
    database.insert_task("b-task-1", "echo 1", "Pending", now_iso, queue_name="default")
    database.insert_task("b-task-2", "echo 2", "Pending", now_iso, queue_name="default")
    database.insert_task("b-task-3", "echo 3", "Completed", now_iso, queue_name="default")

    # Test batch cancel endpoint
    res = batch_client.post("/api/tasks/batch/cancel", json={
        "task_ids": ["b-task-1", "b-task-2"]
    })
    assert res.status_code == 200
    assert res.json()["cancelled_count"] == 2

    t1 = database.get_task("b-task-1")
    t2 = database.get_task("b-task-2")
    assert t1["status"] == "Cancelled"
    assert t2["status"] == "Cancelled"

    # Test batch retry endpoint
    res = batch_client.post("/api/tasks/batch/retry", json={
        "task_ids": ["b-task-1", "b-task-2"]
    })
    assert res.status_code == 200
    assert res.json()["retried_count"] == 2

    t1_retried = database.get_task("b-task-1")
    assert t1_retried["status"] in ("Pending", "Running", "Completed")

    # Test batch purge endpoint
    # First ensure statuses are eligible for purge
    database.update_task_status("b-task-1", "Cancelled")
    database.update_task_status("b-task-2", "Cancelled")

    res = batch_client.post("/api/tasks/batch/purge", json={
        "task_ids": ["b-task-1", "b-task-2", "b-task-3"]
    })
    assert res.status_code == 200
    assert res.json()["purged_count"] == 3

    assert database.get_task("b-task-1") is None
    assert database.get_task("b-task-2") is None
    assert database.get_task("b-task-3") is None

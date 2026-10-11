import sqlite3
import pytest
from pathlib import Path
import database

@pytest.fixture
def temp_db(tmp_path, monkeypatch):
    test_db_path = tmp_path / "test_pareo.db"
    monkeypatch.setattr(database, "DB_FILE", test_db_path)
    database.init_db()
    yield test_db_path

def test_database_pragmas(temp_db):
    conn = database.get_conn()
    cur = conn.cursor()
    
    # Check journal_mode = wal
    cur.execute("PRAGMA journal_mode;")
    journal_mode = cur.fetchone()[0]
    assert journal_mode.lower() == "wal"
    
    # Check synchronous = normal (1)
    cur.execute("PRAGMA synchronous;")
    synchronous = cur.fetchone()[0]
    assert synchronous == 1
    
    # Check busy_timeout = 5000
    cur.execute("PRAGMA busy_timeout;")
    busy_timeout = cur.fetchone()[0]
    assert busy_timeout == 5000
    
    # Check wal_autocheckpoint = 1000
    cur.execute("PRAGMA wal_autocheckpoint;")
    wal_autocheckpoint = cur.fetchone()[0]
    assert wal_autocheckpoint == 1000
    
    conn.close()

def test_database_indices(temp_db):
    conn = database.get_conn()
    cur = conn.cursor()
    
    cur.execute("SELECT name, sql FROM sqlite_master WHERE type='index';")
    indices = {row["name"]: row["sql"] for row in cur.fetchall()}
    
    # Verify B-tree indices exist
    assert "idx_tasks_status" in indices
    assert "idx_tasks_queue_status" in indices
    assert "idx_tasks_start_time" in indices
    
    assert "tasks(status)" in indices["idx_tasks_status"].replace(" ", "")
    assert "tasks(queue_name,status)" in indices["idx_tasks_queue_status"].replace(" ", "")
    assert "tasks(start_timeDESC)" in indices["idx_tasks_start_time"].replace(" ", "")
    
    conn.close()

def test_task_crud_lifecycle(temp_db):
    task_id = "test-task-123"
    command = "ffmpeg -i input.mkv output.mp4"
    status = "Pending"
    start_time = "2026-10-11T12:00:00"
    queue = "media"
    
    # Insert
    database.insert_task(task_id, command, status, start_time, queue_name=queue)
    task = database.get_task(task_id)
    assert task is not None
    assert task["task_id"] == task_id
    assert task["command"] == command
    assert task["status"] == "Pending"
    assert task["queue_name"] == "media"
    assert task["output"] == ""
    
    # Update PID
    database.update_task_pid(task_id, 9999)
    task = database.get_task(task_id)
    assert task["pid"] == 9999
    
    # Update Status to Running
    database.update_task_status(task_id, "Running")
    task = database.get_task(task_id)
    assert task["status"] == "Running"
    
    # Append output
    database.append_task_output(task_id, "frame 1\n")
    database.append_task_output(task_id, "frame 2\n")
    task = database.get_task(task_id)
    assert task["output"] == "frame 1\nframe 2\n"
    
    # Complete
    end_time = "2026-10-11T12:05:00"
    database.update_task_status(task_id, "Completed", end_time=end_time)
    task = database.get_task(task_id)
    assert task["status"] == "Completed"
    assert task["end_time"] == end_time

def test_task_counts(temp_db):
    # Initial counts
    counts = database.get_task_counts()
    assert counts["ongoing"] == 0
    assert counts["pending"] == 0
    
    # Add pending task
    database.insert_task("p1", "cmd1", "Pending", "2026-10-11T12:00:00")
    database.insert_task("p2", "cmd2", "Pending", "2026-10-11T12:01:00")
    database.insert_task("r1", "cmd3", "Running", "2026-10-11T12:02:00")
    
    counts = database.get_task_counts()
    assert counts["pending"] == 2
    assert counts["ongoing"] == 1

def test_get_tasks_paginated(temp_db):
    for i in range(10):
        database.insert_task(
            f"task-{i:02d}",
            f"echo {i}",
            "Completed" if i % 2 == 0 else "Pending",
            f"2026-10-11T12:{i:02d}:00",
            queue_name="media" if i < 5 else "fs"
        )
        
    # Paginate limit 5
    page1 = database.get_tasks_paginated(limit=5, offset=0)
    assert len(page1) == 5
    
    # Filter by queue
    media_tasks = database.get_tasks_paginated(limit=10, queue="media")
    assert len(media_tasks) == 5
    assert all(t["queue_name"] == "media" for t in media_tasks.values())
    
    # Filter by status
    pending_tasks = database.get_tasks_paginated(limit=10, status="Pending")
    assert len(pending_tasks) == 5
    assert all(t["status"] == "Pending" for t in pending_tasks.values())

def test_recovery_mark_running_as_failed(temp_db):
    database.insert_task("r1", "cmd", "Running", "2026-10-11T10:00:00")
    database.insert_task("p1", "cmd", "Pending", "2026-10-11T10:01:00")
    
    database.mark_running_as_failed()
    
    r1 = database.get_task("r1")
    p1 = database.get_task("p1")
    assert r1["status"] == "Failed (Interrupted)"
    assert p1["status"] == "Pending"

def test_reset_task_for_retry(temp_db):
    database.insert_task("fail1", "cmd", "Failed (Code: 1)", "2026-10-11T10:00:00")
    database.append_task_output("fail1", "Some error trace")
    
    new_time = "2026-10-11T11:00:00"
    database.reset_task_for_retry("fail1", new_time)
    
    task = database.get_task("fail1")
    assert task["status"] == "Pending"
    assert task["output"] == ""
    assert task["start_time"] == new_time
    assert task["end_time"] == ""

def test_vacuum_db(temp_db):
    # vacuum_db should run without error
    database.vacuum_db()

def test_library_cache(temp_db):
    assert database.get_cached_library("movies", "action", False) is None
    database.set_cached_library("movies", "action", False, '{"files": ["m1.mp4"]}')
    cached = database.get_cached_library("movies", "action", False)
    assert cached == '{"files": ["m1.mp4"]}'

import os
import re
from pathlib import Path
import pytest
from fastapi.testclient import TestClient

WORKSPACE = Path(__file__).resolve().parent.parent

def test_port_9046_configuration():
    """Verify port 9046 is configured across run.py, run.sh, and pareo.service."""
    run_py = (WORKSPACE / "run.py").read_text()
    run_sh = (WORKSPACE / "run.sh").read_text()
    service = (WORKSPACE / "pareo.service").read_text()
    
    # run.py default port and env override
    assert 'os.environ.get("PORT", 9046)' in run_py or "os.environ.get('PORT', 9046)" in run_py
    assert 'host="0.0.0.0"' in run_py or "host='0.0.0.0'" in run_py
    
    # run.sh port configuration
    assert 'PORT="${PORT:-9046}"' in run_sh or 'PORT="9046"' in run_sh or '9046' in run_sh
    
    # pareo.service port configuration
    assert "9046" in service

def test_frictionless_no_auth_mode():
    """Verify /api/tasks, /api/auth/verify return 200 without auth headers."""
    from server import app
    client = TestClient(app)
    
    r_verify = client.get("/api/auth/verify")
    assert r_verify.status_code == 200
    assert r_verify.json()["status"] == "authorized"
    assert r_verify.json()["mode"] == "no-auth"
    
    r_tasks = client.get("/api/tasks")
    assert r_tasks.status_code == 200
    assert isinstance(r_tasks.json(), dict)

def test_dynamic_path_resolution_and_clean_codebase():
    """Verify BASE_DIR dynamic resolution and removal of hardcoded host paths."""
    import server
    import database
    import executor
    import command_builder
    
    # Verify BASE_DIR is Path object
    for mod in (server, database, executor, command_builder):
        assert hasattr(mod, "BASE_DIR")
        assert isinstance(mod.BASE_DIR, Path)
        assert mod.BASE_DIR == WORKSPACE
        
    # Check no hardcoded legacy user paths in python source files
    py_files = list(WORKSPACE.glob("*.py"))
    for py_file in py_files:
        content = py_file.read_text()
        assert "/home/sayang/Programs/pareo" not in content, f"Hardcoded path found in {py_file.name}"

def test_is_safe_path_string_guards():
    """Verify is_safe_path_string prevents newlines and length overflows."""
    from server import is_safe_path_string
    
    assert is_safe_path_string("valid/path/file.txt") is True
    assert is_safe_path_string("path\nwith\nnewlines") is False
    assert is_safe_path_string("path\rwith\rcarriagereturn") is False
    assert is_safe_path_string("path\0with\0null") is False
    assert is_safe_path_string("a" * 1024) is False
    assert is_safe_path_string("a" * 2000) is False

def test_database_indices_and_wal_pragmas(tmp_path, monkeypatch):
    """Verify database schema indices and WAL PRAGMAs."""
    import database
    test_db = tmp_path / "test.db"
    monkeypatch.setattr(database, "DB_FILE", test_db)
    database.init_db()
    
    conn = database.get_conn()
    cur = conn.cursor()
    
    # PRAGMAs
    cur.execute("PRAGMA journal_mode;")
    assert cur.fetchone()[0].lower() == "wal"
    cur.execute("PRAGMA synchronous;")
    assert cur.fetchone()[0] == 1
    cur.execute("PRAGMA busy_timeout;")
    assert cur.fetchone()[0] == 5000
    cur.execute("PRAGMA wal_autocheckpoint;")
    assert cur.fetchone()[0] == 1000
    
    # Indices
    cur.execute("SELECT name FROM sqlite_master WHERE type='index';")
    idx_names = [row["name"] for row in cur.fetchall()]
    assert "idx_tasks_status" in idx_names
    assert "idx_tasks_queue_status" in idx_names
    assert "idx_tasks_start_time" in idx_names
    
    conn.close()

def test_non_blocking_async_in_server():
    """Verify absence of synchronous subprocess calls in server.py."""
    server_source = (WORKSPACE / "server.py").read_text()
    assert "subprocess.run(" not in server_source
    assert "subprocess.call(" not in server_source

def test_broadcaster_pubsub_functionality():
    """Verify SSE broadcaster functionality."""
    from broadcaster import Broadcaster
    import asyncio
    
    async def run_pubsub():
        b = Broadcaster()
        q = await b.subscribe()
        b.broadcast_task_update("t-1", "Running", "fs", "2026-10-11T00:00:00")
        msg = await q.get()
        assert "event: task_update" in msg
        assert "t-1" in msg
        await b.unsubscribe(q)
        assert len(b._subscribers) == 0
        
    asyncio.run(run_pubsub())

def test_frontend_dual_themes_and_tokens():
    """Verify static/style.css defines wipeout and fallout-pipboy themes."""
    css = (WORKSPACE / "static" / "style.css").read_text()
    assert '[data-theme="wipeout"]' in css
    assert '[data-theme="fallout-pipboy"]' in css
    assert ".bottom-nav" in css
    assert ".task-card" in css
    assert "min-height: 44px" in css

def test_documentation_integrity_and_lessons_learned():
    """Verify README.md and FAQ.md document port 9046, MVP 1 features, and preserve prior contracts."""
    readme = (WORKSPACE / "README.md").read_text()
    faq = (WORKSPACE / "FAQ.md").read_text()
    
    # Port 9046 documented in README
    assert "9046" in readme
    
    # MVP 1 documented in both
    assert "MVP 1" in readme
    assert "MVP 1" in faq
    
    # Prior contracts preserved in README (multi-queue, executor, database, FFMPEG profile, Switchboard)
    assert "media" in readme
    assert "fs" in readme
    assert "network" in readme
    assert "default" in readme
    assert "executor.py" in readme
    assert "database.py" in readme
    assert "command_builder.py" in readme
    assert "ffmpeg" in readme
    assert "switchboard" in readme.lower() or "button" in readme.lower()

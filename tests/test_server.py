import asyncio
import inspect
import json
from pathlib import Path
import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

import server
from server import app, is_safe_path_string, is_path_allowed, run_async_subprocess, BASE_DIR, DEFAULT_CONVERSION_TEMP
from broadcaster import broadcaster

@pytest.fixture
def client():
    return TestClient(app)

def test_frictionless_no_auth_mode_endpoints(client):
    """Verify endpoints respond with 200 without requiring auth headers."""
    # /api/auth/verify
    res = client.get("/api/auth/verify")
    assert res.status_code == 200
    assert res.json() == {"status": "authorized", "mode": "no-auth"}
    
    # /api/auth/login
    res = client.post("/api/auth/login", json={"password": "anypassword"})
    assert res.status_code == 200
    assert res.json().get("mode") == "no-auth"
    
    # /api/auth/setup
    res = client.post("/api/auth/setup", json={"password": "anypassword"})
    assert res.status_code == 200
    assert res.json().get("mode") == "no-auth"
    
    # /api/tasks
    res = client.get("/api/tasks")
    assert res.status_code == 200
    
    # /api/tasks/counts
    res = client.get("/api/tasks/counts")
    assert res.status_code == 200
    assert "ongoing" in res.json()
    assert "pending" in res.json()
    
    # /api/processes/status
    res = client.get("/api/processes/status")
    assert res.status_code == 200
    
    # /api/config/ffmpeg
    res = client.get("/api/config/ffmpeg")
    assert res.status_code == 200
    
    # /api/config/fs
    res = client.get("/api/config/fs")
    assert res.status_code == 200
    
    # /api/config/switchboard
    res = client.get("/api/config/switchboard")
    assert res.status_code == 200
    
    # /api/config/cards
    res = client.get("/api/config/cards")
    assert res.status_code == 200
    
    # /api/libraries
    res = client.get("/api/libraries")
    assert res.status_code == 200

def test_dynamic_path_resolution():
    """Verify BASE_DIR and DEFAULT_CONVERSION_TEMP are dynamically resolved."""
    assert isinstance(BASE_DIR, Path)
    assert BASE_DIR.is_dir()
    assert (BASE_DIR / "server.py").exists()
    
    assert isinstance(DEFAULT_CONVERSION_TEMP, Path)
    assert DEFAULT_CONVERSION_TEMP == BASE_DIR / "conversion_temp"
    assert DEFAULT_CONVERSION_TEMP.is_dir()

def test_is_safe_path_string_security():
    """Verify protection against newlines, control characters, and length overflow."""
    # Valid paths
    assert is_safe_path_string("/home/sayang/video.mp4") is True
    assert is_safe_path_string("relative/path/to/file") is True
    assert is_safe_path_string(str(BASE_DIR)) is True
    
    # Reject newlines and control characters
    assert is_safe_path_string("/path/with/\nnewline") is False
    assert is_safe_path_string("/path/with/\rreturn") is False
    assert is_safe_path_string("/path/with/\0null") is False
    
    # Reject string length overflow >= 1024
    long_path = "/" + "a" * 1024
    assert is_safe_path_string(long_path) is False
    
    # Reject non-strings
    assert is_safe_path_string(None) is False
    assert is_safe_path_string(12345) is False
    assert is_safe_path_string(["/path"]) is False

def test_is_path_allowed_boundaries():
    """Verify lexical boundary checking and path traversal protection."""
    # Allowed path within BASE_DIR
    valid_path = str(BASE_DIR / "conversion_temp")
    assert is_path_allowed(valid_path) is True
    
    # Reject path traversal
    assert is_path_allowed("/etc/passwd") is False
    assert is_path_allowed("../../etc/shadow") is False
    
    # Reject unsafe strings directly in is_path_allowed
    assert is_path_allowed("/home/sayang/evil\npath") is False
    assert is_path_allowed("/" + "b" * 1025) is False

def test_run_async_subprocess_success():
    """Verify non-blocking async execution of commands."""
    async def run():
        returncode, stdout, stderr = await run_async_subprocess(["echo", "pareo_async_test"])
        assert returncode == 0
        assert "pareo_async_test" in stdout
        assert stderr == ""
    asyncio.run(run())

def test_run_async_subprocess_timeout():
    """Verify timeout terminates process and raises HTTP 504."""
    async def run():
        with pytest.raises(HTTPException) as exc_info:
            await run_async_subprocess(["sleep", "2"], timeout=0.2)
        assert exc_info.value.status_code == 504
        assert "timed out" in exc_info.value.detail
    asyncio.run(run())

def test_no_synchronous_subprocess_run_in_server():
    """Verify zero synchronous subprocess.run calls exist in server.py."""
    source = Path(server.__file__).read_text()
    assert "subprocess.run(" not in source
    assert "subprocess.call(" not in source
    assert "subprocess.check_call(" not in source
    assert "subprocess.check_output(" not in source

def test_async_route_handlers_in_server():
    """Verify route handlers doing subprocess or async queue operations are async functions."""
    route_map = {r.name: r.endpoint for r in app.routes if hasattr(r, "endpoint")}
    
    async_endpoints = [
        "stream_events",
        "execute_ls",
        "execute_ffmpeg",
        "execute_fs_action",
        "execute_switchboard",
        "execute_generic_card",
        "list_directory",
        "rename_fs_item",
        "cancel_task_endpoint",
        "retry_task_endpoint",
        "browse_library",
        "sync_library_item",
        "delete_library_item",
        "get_media_info",
        "start_media_conversion"
    ]
    for ep_name in async_endpoints:
        if ep_name in route_map:
            assert inspect.iscoroutinefunction(route_map[ep_name]), f"{ep_name} is not async"

def test_sse_endpoint_stream_and_broadcaster():
    """Directly test the /api/stream/events endpoint and its event stream generator."""
    async def run():
        class DummyRequest:
            async def is_disconnected(self):
                return False

        # Find the stream_events endpoint
        route = next(r for r in app.routes if getattr(r, "name", "") == "stream_events")
        streaming_resp = await route.endpoint(DummyRequest())
        
        assert streaming_resp.status_code == 200
        assert streaming_resp.media_type == "text/event-stream"
        assert streaming_resp.headers["Cache-Control"] == "no-cache"
        assert streaming_resp.headers["Connection"] == "keep-alive"
        assert streaming_resp.headers["X-Accel-Buffering"] == "no"
        
        gen = streaming_resp.body_iterator
        
        # 1st item: connected event
        item1 = await asyncio.wait_for(gen.__anext__(), timeout=1.0)
        assert item1.startswith("event: connected\n")
        
        # 2nd item: initial task counts event
        item2 = await asyncio.wait_for(gen.__anext__(), timeout=1.0)
        assert item2.startswith("event: task_counts\n")
        
        # 3rd item: broadcast live update
        broadcaster.broadcast_task_update("test-sse-task", "Running", "fs", "2026-10-11T12:00:00")
        item3 = await asyncio.wait_for(gen.__anext__(), timeout=1.0)
        assert item3.startswith("event: task_update\n")
        data3 = json.loads(item3.split("data: ")[1].strip())
        assert data3["task_id"] == "test-sse-task"
        assert data3["status"] == "Running"
        assert data3["queue_name"] == "fs"
        
        # Close generator
        await gen.aclose()
    asyncio.run(run())

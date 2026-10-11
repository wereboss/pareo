import asyncio
import json
from unittest.mock import patch
from pathlib import Path
import pytest
from fastapi.testclient import TestClient
import telemetry
import database
import executor
from broadcaster import Broadcaster, broadcaster
from server import app

@pytest.fixture
def client(tmp_path, monkeypatch):
    test_db = tmp_path / "tele_test.db"
    monkeypatch.setattr(database, "DB_FILE", test_db)
    database.init_db()
    return TestClient(app)

def test_cpu_metrics():
    metrics = telemetry.get_cpu_metrics()
    assert "load_1m" in metrics
    assert "load_5m" in metrics
    assert "load_15m" in metrics
    assert "cores" in metrics
    assert "utilization_pct" in metrics
    assert metrics["cores"] >= 1
    assert 0.0 <= metrics["utilization_pct"] <= 100.0

def test_memory_metrics():
    metrics = telemetry.get_memory_metrics()
    assert "total_mb" in metrics
    assert "used_mb" in metrics
    assert "available_mb" in metrics
    assert "utilization_pct" in metrics
    assert metrics["total_mb"] >= 0.0
    assert 0.0 <= metrics["utilization_pct"] <= 100.0

def test_disk_metrics():
    disks = telemetry.get_disk_metrics(["/workspace"])
    assert isinstance(disks, list)
    assert len(disks) >= 1
    disk = disks[0]
    assert "path" in disk
    assert "total_gb" in disk
    assert "used_gb" in disk
    assert "free_gb" in disk
    assert "utilization_pct" in disk
    assert disk["total_gb"] > 0
    assert 0.0 <= disk["utilization_pct"] <= 100.0

def test_queue_metrics_structure(client):
    queues = executor.get_queue_metrics()
    for q in ["media", "network", "fs", "default"]:
        assert q in queues
        assert "active" in queues[q]
        assert "pending" in queues[q]
        assert "limit" in queues[q]
        assert "saturation_pct" in queues[q]
        assert queues[q]["saturation_pct"] >= 0.0

def test_system_telemetry_snapshot():
    snapshot = telemetry.get_system_telemetry(["/workspace"])
    assert "timestamp" in snapshot
    assert "cpu" in snapshot
    assert "memory" in snapshot
    assert "disk" in snapshot
    assert "queues" in snapshot
    
    queues = snapshot["queues"]
    for q in ["media", "network", "fs", "default"]:
        assert q in queues
        assert "active" in queues[q]
        assert "limit" in queues[q]

def test_api_telemetry_endpoint(client):
    res = client.get("/api/telemetry")
    assert res.status_code == 200
    data = res.json()
    assert "timestamp" in data
    assert "cpu" in data
    assert "memory" in data
    assert "disk" in data
    assert "queues" in data

def test_sse_telemetry_broadcast():
    async def run():
        b = Broadcaster()
        q = await b.subscribe()
        sample_data = {
            "timestamp": "2026-10-11T08:00:00Z",
            "cpu": {"load_1m": 0.5, "cores": 4, "utilization_pct": 25.0},
            "memory": {"total_mb": 16000, "used_mb": 4000, "utilization_pct": 25.0},
            "disk": [],
            "queues": {}
        }
        b.broadcast_telemetry(sample_data)
        msg = await asyncio.wait_for(q.get(), timeout=1.0)
        assert msg.startswith("event: telemetry\n")
        data_str = msg.split("data: ")[1].strip()
        data = json.loads(data_str)
        assert data["cpu"]["utilization_pct"] == 25.0
        await b.unsubscribe(q)
    asyncio.run(run())

def test_missing_proc_fallback():
    """Verify fallback when /proc files do not exist (e.g. non-Linux systems)."""
    with patch.object(Path, "exists", return_value=False):
        cpu = telemetry.get_cpu_metrics()
        assert "load_1m" in cpu
        assert "cores" in cpu
        assert "utilization_pct" in cpu

        mem = telemetry.get_memory_metrics()
        assert "total_mb" in mem
        assert "used_mb" in mem
        assert "utilization_pct" in mem

import pytest
from fastapi.testclient import TestClient
import telemetry
import database
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

import os
import shutil
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, Any, List

_prev_cpu_times = None

def get_cpu_metrics() -> Dict[str, Any]:
    """Collects CPU load averages, core count, and utilization percentage."""
    global _prev_cpu_times
    try:
        load_1m, load_5m, load_15m = os.getloadavg()
    except (AttributeError, OSError):
        load_1m, load_5m, load_15m = (0.0, 0.0, 0.0)
        
    cores = os.cpu_count() or 1
    utilization_pct = 0.0

    # Read /proc/stat if running on Linux
    stat_file = Path("/proc/stat")
    if stat_file.exists():
        try:
            with open(stat_file, "r") as f:
                line = f.readline()
            if line.startswith("cpu "):
                parts = [float(x) for x in line.strip().split()[1:]]
                idle_time = parts[3] + (parts[4] if len(parts) > 4 else 0.0)
                total_time = sum(parts)
                
                if _prev_cpu_times is not None:
                    prev_idle, prev_total = _prev_cpu_times
                    idle_delta = idle_time - prev_idle
                    total_delta = total_time - prev_total
                    if total_delta > 0:
                        raw_pct = (1.0 - (idle_delta / total_delta)) * 100.0
                        utilization_pct = max(0.0, min(100.0, round(raw_pct, 1)))
                else:
                    utilization_pct = max(0.0, min(100.0, round((load_1m / cores) * 100.0, 1)))
                _prev_cpu_times = (idle_time, total_time)
            else:
                utilization_pct = max(0.0, min(100.0, round((load_1m / cores) * 100.0, 1)))
        except Exception:
            utilization_pct = max(0.0, min(100.0, round((load_1m / cores) * 100.0, 1)))
    else:
        utilization_pct = max(0.0, min(100.0, round((load_1m / cores) * 100.0, 1)))

    return {
        "load_1m": round(load_1m, 2),
        "load_5m": round(load_5m, 2),
        "load_15m": round(load_15m, 2),
        "cores": cores,
        "utilization_pct": utilization_pct
    }

def get_memory_metrics() -> Dict[str, Any]:
    """Extracts RAM metrics from /proc/meminfo or system stats."""
    total_mb = 0.0
    available_mb = 0.0
    used_mb = 0.0
    utilization_pct = 0.0

    meminfo_file = Path("/proc/meminfo")
    if meminfo_file.exists():
        try:
            info = {}
            with open(meminfo_file, "r") as f:
                for line in f:
                    parts = line.split(":")
                    if len(parts) == 2:
                        key = parts[0].strip()
                        val = parts[1].strip().split()[0]
                        info[key] = int(val)
            mem_total_kb = info.get("MemTotal", 0)
            mem_avail_kb = info.get("MemAvailable", info.get("MemFree", 0))
            total_mb = round(mem_total_kb / 1024.0, 1)
            available_mb = round(mem_avail_kb / 1024.0, 1)
            used_mb = round(max(0.0, total_mb - available_mb), 1)
            if total_mb > 0:
                utilization_pct = round((used_mb / total_mb) * 100.0, 1)
        except Exception:
            pass
            
    return {
        "total_mb": total_mb,
        "used_mb": used_mb,
        "available_mb": available_mb,
        "utilization_pct": utilization_pct
    }

def get_disk_metrics(allowed_roots: List[str] = None) -> List[Dict[str, Any]]:
    """Evaluates disk usage across configured allowed root directories."""
    if not allowed_roots:
        allowed_roots = ["/workspace"]

    disks = []
    seen = set()
    for root in allowed_roots:
        try:
            p = Path(root).resolve()
            p_str = str(p)
            if p_str in seen or not p.exists():
                continue
            seen.add(p_str)
            usage = shutil.disk_usage(p_str)
            total_gb = round(usage.total / (1024 ** 3), 1)
            used_gb = round(usage.used / (1024 ** 3), 1)
            free_gb = round(usage.free / (1024 ** 3), 1)
            util_pct = round((usage.used / usage.total) * 100.0, 1) if usage.total > 0 else 0.0
            disks.append({
                "path": p_str,
                "total_gb": total_gb,
                "used_gb": used_gb,
                "free_gb": free_gb,
                "utilization_pct": util_pct
            })
        except Exception:
            continue
    return disks

def get_system_telemetry(allowed_roots: List[str] = None) -> Dict[str, Any]:
    """Gathers full system telemetry snapshot."""
    import executor
    now_iso = datetime.now(timezone.utc).isoformat()
    return {
        "timestamp": now_iso,
        "cpu": get_cpu_metrics(),
        "memory": get_memory_metrics(),
        "disk": get_disk_metrics(allowed_roots),
        "queues": executor.get_queue_metrics()
    }

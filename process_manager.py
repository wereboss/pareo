import asyncio
import os
import signal
import socket
import subprocess
import re
from pathlib import Path
from typing import Optional, Dict, Any
import command_builder

BASE_DIR = Path(__file__).resolve().parent

async def is_port_open_async(port: int) -> bool:
    """Asynchronously checks if a local port is open by attempting a connection."""
    try:
        conn = asyncio.open_connection('127.0.0.1', port)
        _, writer = await asyncio.wait_for(conn, timeout=0.2)
        try:
            writer.close()
            await writer.wait_closed()
        except Exception:
            pass
        return True
    except Exception:
        return False

async def find_pid_by_port(port: int) -> Optional[int]:
    """Inspects the OS using lsof or ss to find the process ID listening on a port."""
    # 1. Try lsof
    try:
        proc = await asyncio.create_subprocess_shell(
            f"lsof -t -i :{port}",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE
        )
        stdout, _ = await proc.communicate()
        output = stdout.decode().strip()
        if output:
            pids = [int(p) for p in output.split() if p.isdigit()]
            if pids:
                return pids[0]
    except Exception:
        pass

    # 2. Try ss as a fallback (often installed by default on minimal setups)
    try:
        proc = await asyncio.create_subprocess_shell(
            f"ss -lptn sport = :{port}",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE
        )
        stdout, _ = await proc.communicate()
        output = stdout.decode().strip()
        if output:
            pid_match = re.search(r'pid=(\d+)', output)
            if pid_match:
                return int(pid_match.group(1))
    except Exception:
        pass

    return None

async def get_process_status(name: str, config: dict) -> dict:
    """Returns the current state, active PID, and port of the process."""
    port = config.get("port")
    if not port:
        return {"status": "Stopped", "pid": None, "error": "No port configured."}
    
    open_port = await is_port_open_async(port)
    if open_port:
        pid = await find_pid_by_port(port)
        if pid:
            return {"status": "Running", "pid": pid, "port": port}
        return {"status": "Running", "pid": None, "port": port, "note": "Port open, but PID lookup failed."}
    
    return {"status": "Stopped", "pid": None, "port": port}

async def get_all_process_statuses() -> Dict[str, Any]:
    """Returns statuses for all configured processes in config.json."""
    config = command_builder.load_config()
    processes = config.get("processes", {})
    statuses = {}
    for name, p_cfg in processes.items():
        statuses[name] = await get_process_status(name, p_cfg)
    return statuses

async def start_process(name: str) -> dict:
    """Spawns the process as a fully detached daemon/process group."""
    config = command_builder.load_config()
    processes = config.get("processes", {})
    if name not in processes:
        return {"success": False, "message": f"Process '{name}' not found in configuration."}
        
    p_cfg = processes[name]
    status_info = await get_process_status(name, p_cfg)
    if status_info["status"] == "Running":
        return {"success": False, "message": f"Process already running on port {p_cfg.get('port')}."}
    
    command = p_cfg.get("command")
    cwd = p_cfg.get("cwd") or str(BASE_DIR)
    log_file_path = p_cfg.get("log_file")
    
    if not command:
        return {"success": False, "message": "No command configured."}
        
    if log_file_path:
        if not os.path.isabs(log_file_path):
            log_file_path = str(BASE_DIR / log_file_path)
        
        os.makedirs(os.path.dirname(log_file_path), exist_ok=True)
        log_fd = open(log_file_path, "a")
    else:
        log_fd = subprocess.DEVNULL

    try:
        process = subprocess.Popen(
            command,
            shell=True,
            start_new_session=True,
            cwd=cwd,
            stdout=log_fd,
            stderr=log_fd
        )
        return {
            "success": True, 
            "message": f"Process spawned successfully with OS PGID/PID: {process.pid}", 
            "pid": process.pid
        }
    except Exception as e:
        return {"success": False, "message": f"Failed to spawn process: {str(e)}"}
    finally:
        if log_file_path and log_fd != subprocess.DEVNULL:
            log_fd.close()

async def stop_process(name: str, force: bool = False) -> dict:
    """Gracefully terminates (SIGTERM) or kills (SIGKILL) the process group."""
    config = command_builder.load_config()
    processes = config.get("processes", {})
    if name not in processes:
        return {"success": False, "message": f"Process '{name}' not found in configuration."}
        
    p_cfg = processes[name]
    status_info = await get_process_status(name, p_cfg)
    if status_info["status"] == "Stopped":
        return {"success": False, "message": "Process is not running."}
    
    pid = status_info.get("pid")
    if not pid:
        port = p_cfg.get("port")
        try:
            cmd = f"fuser -k -9 {port}/tcp" if force else f"fuser -k {port}/tcp"
            proc = await asyncio.create_subprocess_shell(cmd)
            await proc.wait()
            return {"success": True, "message": f"Sent kill command to port {port} via fuser."}
        except Exception as e:
            return {"success": False, "message": f"PID lookup failed and fuser failed: {str(e)}"}

    try:
        sig = signal.SIGKILL if force else signal.SIGTERM
        os.killpg(pid, sig)
        return {"success": True, "message": f"Sent signal {sig.name} to process group {pid}."}
    except ProcessLookupError:
        try:
            os.kill(pid, sig)
            return {"success": True, "message": f"Sent signal {sig.name} directly to PID {pid}."}
        except Exception as e:
            return {"success": False, "message": f"Failed to stop process: {str(e)}"}
    except Exception as e:
        return {"success": False, "message": f"Failed to stop process: {str(e)}"}

def read_last_lines(file_path: str, num_lines: int = 100) -> str:
    """Reads the last N lines of a file safely and efficiently."""
    if not isinstance(file_path, str) or "\n" in file_path or "\r" in file_path or "\0" in file_path or len(file_path) >= 1024:
        return "Invalid file path"
        
    if not os.path.isabs(file_path):
        file_path = str(BASE_DIR / file_path)
        
    if not os.path.exists(file_path):
        return f"Log file not found: {file_path}"
        
    try:
        with open(file_path, 'r', encoding='utf-8', errors='replace') as f:
            try:
                f.seek(0, os.SEEK_END)
                size = f.tell()
                chunk_size = min(size, 50 * 1024)
                f.seek(size - chunk_size)
                lines = f.readlines()
                if len(lines) > 1 and chunk_size < size:
                    lines = lines[1:]
                return "".join(lines[-num_lines:])
            except Exception:
                f.seek(0)
                lines = f.readlines()
                return "".join(lines[-num_lines:])
    except Exception as e:
        return f"Failed to read logs: {str(e)}"

def get_process_logs(name: str, lines: int = 200) -> str:
    """Retrieves log file output for a named process."""
    config = command_builder.load_config()
    processes = config.get("processes", {})
    if name not in processes:
        return f"Process '{name}' not found."
    log_file = processes[name].get("log_file")
    if not log_file:
        return f"No log_file configured for '{name}'."
    return read_last_lines(log_file, num_lines=lines)

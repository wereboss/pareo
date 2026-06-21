import asyncio
import os
import signal
import socket
import subprocess
import re
from typing import Optional, Dict, Any

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

async def start_process(name: str, config: dict) -> dict:
    """Spawns the process as a fully detached daemon/process group."""
    status_info = await get_process_status(name, config)
    if status_info["status"] == "Running":
        return {"success": False, "message": f"Process already running on port {config.get('port')}."}
    
    command = config.get("command")
    cwd = config.get("cwd") or os.getcwd()
    log_file_path = config.get("log_file")
    
    if not command:
        return {"success": False, "message": "No command configured."}
        
    if log_file_path:
        # Resolve log file relative to cwd or root
        if not os.path.isabs(log_file_path):
            log_file_path = os.path.join(os.getcwd(), log_file_path)
        
        # Ensure log folder exists
        os.makedirs(os.path.dirname(log_file_path), exist_ok=True)
        log_fd = open(log_file_path, "a")
    else:
        log_fd = subprocess.DEVNULL

    try:
        # start_new_session=True detaches the process group so it runs independently of Pareo
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

async def stop_process(name: str, config: dict, force: bool = False) -> dict:
    """Gracefully terminates (SIGTERM) or kills (SIGKILL) the process group."""
    status_info = await get_process_status(name, config)
    if status_info["status"] == "Stopped":
        return {"success": False, "message": "Process is not running."}
    
    pid = status_info.get("pid")
    if not pid:
        # If port is open but PID lookup failed, try killing the port binding via fuser
        port = config.get("port")
        try:
            cmd = f"fuser -k -9 {port}/tcp" if force else f"fuser -k {port}/tcp"
            proc = await asyncio.create_subprocess_shell(cmd)
            await proc.wait()
            return {"success": True, "message": f"Sent kill command to port {port} via fuser."}
        except Exception as e:
            return {"success": False, "message": f"PID lookup failed and fuser failed: {str(e)}"}

    try:
        # Since we ran Popen with start_new_session=True, the process group ID is equal to the PID.
        # Sending a signal to -pid (negative pid) sends it to the entire process group, terminating
        # both the shell wrapper and the actual server process.
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
    """Reads the last N lines of a file efficiently by seeking close to the end."""
    if not os.path.exists(file_path):
        return f"Log file not found: {file_path}"
    
    # Resolve relative to cwd if needed
    if not os.path.isabs(file_path):
        file_path = os.path.join(os.getcwd(), file_path)
        
    try:
        with open(file_path, 'r', encoding='utf-8', errors='replace') as f:
            try:
                f.seek(0, os.SEEK_END)
                size = f.tell()
                # 50KB read limit is more than enough for ~100 lines
                chunk_size = min(size, 50 * 1024)
                f.seek(size - chunk_size)
                lines = f.readlines()
                # If we seeked mid-line, discard the first line as it may be truncated
                if len(lines) > 1 and chunk_size < size:
                    lines = lines[1:]
                return "".join(lines[-num_lines:])
            except Exception:
                # Fallback to reading the full file if it is small or seek fails
                f.seek(0)
                lines = f.readlines()
                return "".join(lines[-num_lines:])
    except Exception as e:
        return f"Failed to read logs: {str(e)}"

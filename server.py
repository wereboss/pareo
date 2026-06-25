import os
import glob
from pathlib import Path
import asyncio
from contextlib import asynccontextmanager
from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from typing import List, Optional
import executor
import command_builder
import database
import process_manager

@asynccontextmanager
async def lifespan(app: FastAPI):
    # 1. Boot up the SQLite database
    database.init_db()
    
    # 2. Recover State (Mark orphaned tasks as failed, requeue pending)
    recovered_count = executor.recover_tasks()
    print(f"[*] Pareo Engine Boot: Recovered {recovered_count} pending tasks.")
    
    # NEW: Start the parallel workers
    executor.start_workers()

    print("--- TRUE ROUTING ORDER ---")
    for idx, route in enumerate(app.routes):
        route_type = "API Endpoint" if hasattr(route, "methods") else "CATCH-ALL MOUNT"
        path = getattr(route, "path", getattr(route, "name", "Unknown"))
        print(f"{idx} | {route_type} | {path}")
    print("--------------------------")

    yield
    # Cleanly stop workers on shutdown
    await executor.stop_workers()

app = FastAPI(title="Pareo API", lifespan=lifespan)

class GenericTaskRequest(BaseModel):
    card_name: str
    inputs: dict

# 1. Unified Pydantic Model
class FfmpegRequest(BaseModel):
    input_target: str
    output_target: str
    profile: str = "Standard HEVC"
    mode: str = "single" 
    output_extension: str = ".mp4"

class FsRequest(BaseModel):
    action: str
    source_paths: List[str]
    destination_path: Optional[str] = ""
    remote_server: Optional[str] = ""  # NEW: Tracks the target server
    source_server: Optional[str] = ""  # NEW: Tracks the source server

class SwitchboardRequest(BaseModel):
    category: str
    button_name: str

class RenameRequest(BaseModel):
    source_path: str
    new_name: str
    remote_server: Optional[str] = ""

@app.post("/api/execute/ls")
async def execute_ls():
    """Queues the 'ls -ltr' command."""
    task_id = await executor.start_task("ls -ltr")
    return {"task_id": task_id, "message": "Command queued."}

# 2. Rich Configuration Endpoint
@app.get("/api/config/ffmpeg")
def get_ffmpeg_config():
    """Serves the complete FFMPEG profile schema from config.json."""
    config = command_builder.load_config()
    profiles = config.get("ffmpeg", {}).get("profiles", {})
    return {"profiles": profiles}

# 3. Unified Execution Engine
@app.post("/api/execute/ffmpeg")
async def execute_ffmpeg(request: FfmpegRequest):
    """Handles both single and batch FFMPEG executions with strict config validation."""
    config = command_builder.load_config()
    profiles = config.get("ffmpeg", {}).get("profiles", {})
    
    if request.profile not in profiles:
        raise HTTPException(status_code=400, detail="Invalid profile selected.")
        
    profile_data = profiles[request.profile]
    
    # Validation 1: Check if the requested mode is allowed by the config
    if request.mode not in profile_data.get("modes", []):
        raise HTTPException(status_code=400, detail=f"Profile '{request.profile}' does not support {request.mode} mode.")
        
    queued_count = 0
    
    if request.mode == "single":
        # Route: Single Execution
        command = command_builder.build_ffmpeg_command(
            request.input_target, 
            request.output_target, 
            request.profile
        )
        # CRITICAL FIX: Route to 'media' queue
        await executor.start_task(command, queue_name="media")
        queued_count = 1
        
    elif request.mode == "batch":
        # Route: Batch Execution
        ext = request.output_extension if request.output_extension.startswith('.') else f".{request.output_extension}"
        allowed_exts = profile_data.get("allowed_extensions", [])
        
        # Validation 2: Check if the output extension is allowed by the config
        if allowed_exts and ext not in allowed_exts:
             raise HTTPException(status_code=400, detail=f"Extension '{ext}' not allowed for profile '{request.profile}'.")
             
        files = glob.glob(request.input_target)
        if not files:
            return {"message": "No files found matching the pattern.", "queued_count": 0}
            
        # Ensure the destination folder exists
        os.makedirs(request.output_target, exist_ok=True)
        
        # Unpack the wildcard and queue individual commands
        for file_path in files:
            if not os.path.isfile(file_path):
                continue
                
            filename_without_ext = Path(file_path).stem
            output_file_path = os.path.join(request.output_target, f"{filename_without_ext}{ext}")
            
            command = command_builder.build_ffmpeg_command(file_path, output_file_path, request.profile)
            # CRITICAL FIX: Route to 'media' queue
            await executor.start_task(command, queue_name="media")
            queued_count += 1
            
    return {"message": f"Successfully queued {queued_count} task(s).", "queued_count": queued_count}

# --- FILE SYSTEM ENDPOINTS ---

@app.get("/api/config/fs")
def get_fs_config():
    """Serves the File Operations config schema."""
    config = command_builder.load_config()
    return config.get("file_operations", {})

@app.get("/api/config/bookmarks")
def get_bookmarks_config():
    """Serves the global bookmarks schema for quick-access paths."""
    config = command_builder.load_config()
    return config.get("bookmarks", {})

@app.get("/api/config/remotes")
def get_remotes_config():
    """Serves the Remote Servers config schema (including context-aware bookmarks)."""
    config = command_builder.load_config()
    return config.get("remote_servers", {})

def list_remote_directory(remote_name: str, target_path: str):
    import subprocess
    import json
    config = command_builder.load_config()
    remotes = config.get("remote_servers", {})
    if remote_name not in remotes:
        raise HTTPException(status_code=400, detail=f"Remote server '{remote_name}' not configured.")
        
    rc = remotes[remote_name]
    user = rc.get("user")
    host = rc.get("host")
    key_path = rc.get("key_path")
    
    # Python one-liner to execute on the remote machine
    remote_python_code = (
        "import os, json, sys\n"
        "target = sys.argv[1] if len(sys.argv) > 1 else '/'\n"
        "try:\n"
        "    abs_target = os.path.abspath(target)\n"
        "    items = []\n"
        "    if os.path.exists(abs_target) and os.path.isdir(abs_target):\n"
        "        for entry in os.scandir(abs_target):\n"
        "            try:\n"
        "                is_dir = entry.is_dir()\n"
        "                size = entry.stat().st_size if not is_dir else 0\n"
        "                items.append({'name': entry.name, 'path': entry.path, 'is_dir': is_dir, 'size': size})\n"
        "            except Exception:\n"
        "                pass\n"
        "        items.sort(key=lambda x: (not x['is_dir'], x['name'].lower()))\n"
        "        parent = os.path.dirname(abs_target)\n"
        "        if parent == abs_target:\n"
        "            parent = None\n"
        "        print(json.dumps({'success': True, 'target_path': abs_target, 'parent_path': parent, 'items': items}))\n"
        "    else:\n"
        "        print(json.dumps({'success': False, 'error': 'Not a directory or does not exist'}))\n"
        "except Exception as e:\n"
        "    print(json.dumps({'success': False, 'error': str(e)}))\n"
    )
    
    escaped_code = remote_python_code.replace('"', '\\"').replace('$', '\\$')
    ssh_cmd = [
        "ssh",
        "-o", "StrictHostKeyChecking=no",
        "-i", key_path,
        f"{user}@{host}",
        f"env PATH=\"/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/sbin\" python3 -c \"{escaped_code}\" \"{target_path}\""
    ]
    
    try:
        proc = subprocess.run(ssh_cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=10.0)
        if proc.returncode != 0:
            raise HTTPException(status_code=500, detail=f"SSH command failed: {proc.stderr}")
            
        result = json.loads(proc.stdout.strip())
        if not result.get("success"):
            raise HTTPException(status_code=400, detail=result.get("error", "Unknown remote error"))
            
        return result
    except subprocess.TimeoutExpired:
        raise HTTPException(status_code=504, detail="Connection to remote server timed out.")
    except json.JSONDecodeError:
        raise HTTPException(status_code=500, detail=f"Invalid response from remote server: {proc.stdout} {proc.stderr}")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


def rename_remote_item(remote_name: str, source_path: str, new_name: str):
    import subprocess
    config = command_builder.load_config()
    remotes = config.get("remote_servers", {})
    if remote_name not in remotes:
        raise HTTPException(status_code=400, detail=f"Remote server '{remote_name}' not configured.")
        
    rc = remotes[remote_name]
    user = rc.get("user")
    host = rc.get("host")
    key_path = rc.get("key_path")
    
    remote_code = (
        "import os, sys\n"
        "src = sys.argv[1]\n"
        "new_name = sys.argv[2]\n"
        "try:\n"
        "    if not os.path.exists(src):\n"
        "        print('404: Source not found')\n"
        "        sys.exit(1)\n"
        "    parent = os.path.dirname(src)\n"
        "    dest = os.path.join(parent, new_name)\n"
        "    if os.path.exists(dest):\n"
        "        print('400: Destination exists')\n"
        "        sys.exit(2)\n"
        "    os.rename(src, dest)\n"
        "    print('200: Success')\n"
        "except Exception as e:\n"
        "    print(f'500: {e}')\n"
        "    sys.exit(3)\n"
    )
    
    escaped_code = remote_code.replace('"', '\\"').replace('$', '\\$')
    ssh_cmd = [
        "ssh",
        "-o", "StrictHostKeyChecking=no",
        "-i", key_path,
        f"{user}@{host}",
        f"env PATH=\"/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/sbin\" python3 -c \"{escaped_code}\" \"{source_path}\" \"{new_name}\""
    ]
    
    try:
        proc = subprocess.run(ssh_cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=10.0)
        output = proc.stdout.strip()
        
        if proc.returncode == 1:
            raise HTTPException(status_code=404, detail="Source file or folder not found on remote server.")
        elif proc.returncode == 2:
            raise HTTPException(status_code=400, detail="A file or folder with the new name already exists on remote server.")
        elif proc.returncode != 0:
            raise HTTPException(status_code=500, detail=f"Failed to rename on remote: {output} {proc.stderr}")
            
        return {"success": True, "message": f"Renamed remote item to {new_name}"}
    except subprocess.TimeoutExpired:
        raise HTTPException(status_code=504, detail="Connection to remote server timed out.")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/fs/list")
def list_directory(target_path: str = "/", remote_server: Optional[str] = ""):
    """Returns a JSON array of files and folders for the Explorer Modal."""
    if remote_server:
        return list_remote_directory(remote_server, target_path)
        
    try:
        p = Path(target_path)
        if not p.exists() or not p.is_dir():
            raise HTTPException(status_code=404, detail="Directory not found or invalid.")
        
        items = []
        for child in p.iterdir():
            try:
                items.append({
                    "name": child.name,
                    "path": str(child.absolute()),
                    "is_dir": child.is_dir(),
                    "size": child.stat().st_size if child.is_file() else 0
                })
            except PermissionError:
                pass # Gracefully skip files Pareo doesn't have read access to
                
        # Sort folders first, then alphabetically
        items.sort(key=lambda x: (not x["is_dir"], x["name"].lower()))
        parent_path = str(p.parent.absolute()) if p.parent != p else None
        return {
            "target_path": str(p.absolute()),
            "parent_path": parent_path,
            "items": items
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/fs/rename")
def rename_fs_item(request: RenameRequest):
    """Renames a file or folder immediately using local or remote os.rename."""
    if request.remote_server:
        return rename_remote_item(request.remote_server, request.source_path, request.new_name)
        
    src = Path(request.source_path)
    if not src.exists():
        raise HTTPException(status_code=404, detail="Source file or folder not found.")
        
    # Construct the destination path in the same parent directory
    dest = src.parent / request.new_name
    
    if dest.exists():
        raise HTTPException(status_code=400, detail="A file or folder with the new name already exists.")
        
    try:
        os.rename(str(src), str(dest))
        return {"success": True, "message": f"Renamed to {request.new_name}"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to rename: {str(e)}")

@app.post("/api/execute/fs")
async def execute_fs_action(request: FsRequest):
    """Executes local or remote file operations."""
    config = command_builder.load_config()
    fs_config = config.get("file_operations", {}).get("actions", {})
    remotes_config = config.get("remote_servers", {})
    
    if request.action not in fs_config:
        raise HTTPException(status_code=400, detail="Invalid action selected.")
        
    action_data = fs_config[request.action]
    remote_creds = None
    
    # Validation 1: Require Destination
    if action_data.get("requires_destination") and not request.destination_path:
        raise HTTPException(status_code=400, detail=f"Action '{request.action}' requires a destination path.")
        
    # Validation 2: Require Remote Server (for local-to-remote actions)
    if action_data.get("requires_remote") and not request.source_server:
        if not request.remote_server or request.remote_server not in remotes_config:
            raise HTTPException(status_code=400, detail="A valid Remote Server must be selected for this action.")
        remote_creds = remotes_config[request.remote_server]
        
    queued_count = 0
    for src in request.source_paths:
        if request.source_server:
            # We are performing actions on a remote filesystem context
            if request.source_server not in remotes_config:
                raise HTTPException(status_code=400, detail=f"Source remote server '{request.source_server}' not configured.")
            
            src_creds = remotes_config[request.source_server]
            user = src_creds.get("user")
            host = src_creds.get("host")
            key_path = src_creds.get("key_path")
            
            if action_data.get("requires_remote"):
                # Remote action: Pulling file from remote source to local destination
                if request.action == "Remote Copy (SCP)":
                    cmd = f'scp -o StrictHostKeyChecking=no -i "{key_path}" -r {user}@{host}:"{src}" "{request.destination_path}"'
                elif request.action == "Remote Move (SCP)":
                    cmd = f'scp -o StrictHostKeyChecking=no -i "{key_path}" -r {user}@{host}:"{src}" "{request.destination_path}" && ssh -o StrictHostKeyChecking=no -i "{key_path}" {user}@{host} "rm -rf \\"{src}\\""'
                else:
                    cmd = command_builder.build_fs_command(request.action, src, request.destination_path, src_creds)
            else:
                # Standard local-style action on remote machine: execute it over SSH
                local_cmd = command_builder.build_fs_command(request.action, src, request.destination_path, None)
                escaped_cmd = local_cmd.replace('\\', '\\\\').replace('"', '\\"')
                cmd = f'ssh -o StrictHostKeyChecking=no -i "{key_path}" {user}@{host} "{escaped_cmd}"'
        else:
            # Local source context
            cmd = command_builder.build_fs_command(
                request.action, 
                src, 
                request.destination_path, 
                remote_creds
            )
            
        # Route to 'fs' queue
        await executor.start_task(cmd, queue_name="fs")
        queued_count += 1
        
    return {"message": f"Successfully queued {queued_count} file operations.", "queued_count": queued_count}


@app.get("/api/tasks")
def get_tasks(
    limit: Optional[int] = 15, 
    offset: Optional[int] = 0,
    queue: Optional[str] = None,
    status: Optional[str] = None,
    command: Optional[str] = None
):
    """Retrieves historical tasks from SQLite with pagination (excluding large output logs) and optional filters."""
    # Clean empty strings into None
    q = queue if queue else None
    s = status if status else None
    c = command if command else None
    return database.get_tasks_paginated(limit=limit, offset=offset, queue=q, status=s, command=c)

@app.get("/api/tasks/{task_id}")
def get_single_task(task_id: str):
    """Retrieves high-speed streaming data from SQLite."""
    task = database.get_task(task_id)
    if task:
        return task
    return {"error": "Task not found"}


@app.post("/api/tasks/{task_id}/retry")
async def retry_task_endpoint(task_id: str):
    """Resets a failed task and pushes it back into the queue."""
    try:
        await executor.retry_task(task_id)
        return {"message": "Task re-queued successfully."}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))   


@app.post("/api/tasks/{task_id}/cancel")
async def cancel_task_endpoint(task_id: str):
    """Cancels a running or pending task."""
    try:
        await executor.cancel_task(task_id)
        return {"message": "Task cancelled successfully."}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/api/tasks/purge")
def purge_tasks_endpoint(age: str):
    """Purges completed, failed, or cancelled tasks older than the specified age."""
    if age not in ['1d', '1w', '2w', 'all']:
        raise HTTPException(status_code=400, detail="Invalid age threshold. Must be '1d', '1w', '2w', or 'all'.")
    try:
        deleted_count = database.purge_tasks(age)
        return {"message": f"Successfully purged {deleted_count} task(s).", "count": deleted_count}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/config/switchboard")
def get_switchboard_config():
    """Serves the Switchboard layout structure."""
    config = command_builder.load_config()
    return config.get("switchboard", {})

@app.post("/api/execute/switchboard")
async def execute_switchboard(request: SwitchboardRequest):
    """Fires a fire-and-forget switchboard command (Standard or Detached)."""
    config = command_builder.load_config()
    switchboard = config.get("switchboard", {})
    
    if request.category not in switchboard or request.button_name not in switchboard[request.category]:
        raise HTTPException(status_code=400, detail="Switchboard button not found in configuration.")
        
    cmd_data = switchboard[request.category][request.button_name]
    
    # Check if the config is a dict (new detached schema) or string (legacy)
    if isinstance(cmd_data, dict):
        command = cmd_data.get("command", "")
        detached = cmd_data.get("detached", False)
    else:
        command = cmd_data
        detached = False
    
    # Execute
    result = await executor.fire_immediate_command(command, detached=detached)
    
    if not result["success"]:
        raise HTTPException(status_code=500, detail=result["output"])
        
    return {"message": result["output"]}

@app.get("/api/config/generic_cards")
def get_generic_cards():
    """Serves the generic card layouts to the frontend."""
    config = command_builder.load_config()
    return config.get("generic_cards", {})

@app.post("/api/execute/generic")
async def execute_generic(request: GenericTaskRequest):
    """Parses dynamic inputs into a template and queues the task."""
    config = command_builder.load_config()
    cards = config.get("generic_cards", {})
    
    if request.card_name not in cards:
        raise HTTPException(status_code=404, detail="Generic card configuration not found.")
        
    card_config = cards[request.card_name]
    command = card_config.get("command_template", "")
    
    # Inject the user inputs into the {placeholders}
    for key, value in request.inputs.items():
        command = command.replace(f"{{{key}}}", str(value))
        
    # Identify the target parallel queue
    queue_name = card_config.get("task_type", "default")
    
    # Submit to the parallel engine using the correct function name
    task_id = await executor.start_task(command, queue_name=queue_name)
    
    return {
        "message": "Task generated and queued.", 
        "task_id": task_id, 
        "queue": queue_name,
        "final_command": command
    }

class ProcessActionRequest(BaseModel):
    name: str

class ProcessStopRequest(BaseModel):
    name: str
    force: Optional[bool] = False

@app.get("/api/config/processes")
def get_processes_config():
    """Serves the processes configuration schema."""
    config = command_builder.load_config()
    return config.get("process_monitors", {})

@app.get("/api/processes/status")
async def get_all_processes_status():
    """Retrieves current status for all configured server processes in parallel."""
    config = command_builder.load_config()
    monitors = config.get("process_monitors", {})
    names = list(monitors.keys())
    tasks = [process_manager.get_process_status(name, monitors[name]) for name in names]
    results = await asyncio.gather(*tasks)
    return {name: res for name, res in zip(names, results)}

@app.post("/api/processes/start")
async def start_monitored_process(request: ProcessActionRequest):
    """Spawns a configured process group in the background."""
    config = command_builder.load_config()
    monitors = config.get("process_monitors", {})
    if request.name not in monitors:
        raise HTTPException(status_code=404, detail="Process configuration not found.")
    
    res = await process_manager.start_process(request.name, monitors[request.name])
    if not res["success"]:
        raise HTTPException(status_code=400, detail=res["message"])
    return res

@app.post("/api/processes/stop")
async def stop_monitored_process(request: ProcessStopRequest):
    """Stops or force-kills a running process group."""
    config = command_builder.load_config()
    monitors = config.get("process_monitors", {})
    if request.name not in monitors:
        raise HTTPException(status_code=404, detail="Process configuration not found.")
    
    res = await process_manager.stop_process(request.name, monitors[request.name], force=request.force)
    if not res["success"]:
        raise HTTPException(status_code=400, detail=res["message"])
    return res

@app.get("/api/processes/logs")
def get_monitored_process_logs(name: str, lines: Optional[int] = 100):
    """Returns the tail end of the log file for the specified process."""
    config = command_builder.load_config()
    monitors = config.get("process_monitors", {})
    if name not in monitors:
        raise HTTPException(status_code=404, detail="Process configuration not found.")
    
    log_file = monitors[name].get("log_file")
    if not log_file:
        raise HTTPException(status_code=400, detail="No log file configured for this process.")
    
    content = process_manager.read_last_lines(log_file, lines)
    return {"name": name, "logs": content}

    # THIS MUST BE THE VERY LAST THING IN THE FILE
app.mount("/", StaticFiles(directory="static", html=True), name="static")
import os
import glob
from pathlib import Path
import asyncio
from contextlib import asynccontextmanager
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from typing import List, Optional
import executor
import command_builder
import database
import process_manager

def get_allowed_roots(remote_server: Optional[str] = None) -> List[str]:
    """Retrieves allowed root directories for path restriction from config.json."""
    config = command_builder.load_config()
    if remote_server:
        remotes = config.get("remote_servers", {})
        if remote_server in remotes:
            return remotes[remote_server].get("allowed_roots", ["/Users/sri", "/Volumes"])
        return ["/Users/sri", "/Volumes"]
    return config.get("allowed_roots", ["/home/sayang", "/Volumes"])

def is_path_allowed(target_path: str, remote_server: Optional[str] = None) -> bool:
    """Verifies if target_path falls strictly within allowed root folders."""
    allowed = get_allowed_roots(remote_server)
    try:
        normalized = os.path.normpath(target_path)
        # If it's local, resolve symlinks for extra security
        if not remote_server:
            target = Path(target_path)
            if target.exists():
                resolved = target.resolve()
            else:
                parent = target
                while not parent.exists():
                    if parent.parent == parent:
                        break
                    parent = parent.parent
                resolved = parent.resolve()
            normalized = str(resolved)
            
        for root in allowed:
            root_norm = os.path.normpath(root)
            try:
                common = os.path.commonpath([root_norm, normalized])
                if common == root_norm:
                    return True
            except ValueError:
                pass
    except Exception:
        pass
    return False

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

# --- AUTHENTICATION SYSTEM ---
import hashlib

class PasswordAuthRequest(BaseModel):
    password: str

def hash_password(password: str) -> str:
    return hashlib.sha256(password.encode("utf-8")).hexdigest()

@app.middleware("http")
async def auth_middleware(request: Request, call_next):
    path = request.url.path
    if not path.startswith("/api") or path in ("/api/auth/setup", "/api/auth/verify", "/api/auth/login"):
        return await call_next(request)
        
    config = command_builder.load_config()
    master_hash = config.get("master_password_hash")
    
    if not master_hash:
        return await call_next(request)
        
    auth_header = request.headers.get("X-Pareo-Auth")
    if not auth_header or auth_header != master_hash:
        return JSONResponse(status_code=401, content={"detail": "Unauthorized: Invalid or missing X-Pareo-Auth header."})
        
    return await call_next(request)

@app.get("/api/auth/verify")
def verify_auth(request: Request):
    """Checks the authentication status of the client session."""
    config = command_builder.load_config()
    master_hash = config.get("master_password_hash")
    
    if not master_hash:
        return {"status": "setup_needed"}
        
    auth_header = request.headers.get("X-Pareo-Auth")
    if auth_header == master_hash:
        return {"status": "authorized"}
        
    return {"status": "unauthorized"}

@app.post("/api/auth/setup")
def setup_password(req: PasswordAuthRequest):
    """Saves the initial master password hash to config.json."""
    config = command_builder.load_config()
    if config.get("master_password_hash"):
        raise HTTPException(status_code=400, detail="Master password is already configured.")
        
    password_hash = hash_password(req.password)
    config["master_password_hash"] = password_hash
    import json
    with open('config.json', 'w') as f:
        json.dump(config, f, indent=4)
        
    return {"message": "Master password successfully configured.", "token": password_hash}

@app.post("/api/auth/login")
def login_auth(req: PasswordAuthRequest):
    """Verifies credentials and returns the authorization token."""
    config = command_builder.load_config()
    master_hash = config.get("master_password_hash")
    
    if not master_hash:
        raise HTTPException(status_code=400, detail="Authentication is not configured yet.")
        
    password_hash = hash_password(req.password)
    if password_hash == master_hash:
        return {"status": "authorized", "token": password_hash}
        
    raise HTTPException(status_code=401, detail="Incorrect password.")

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
    
    # Path Validation
    if not is_path_allowed(request.output_target):
        raise HTTPException(status_code=403, detail="Access denied: Output path is outside allowed directories.")
    input_prefix = request.input_target.split('*')[0]
    if not is_path_allowed(input_prefix):
        raise HTTPException(status_code=403, detail="Access denied: Input path is outside allowed directories.")

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
    allowed_roots = rc.get("allowed_roots", ["/Users/sri", "/Volumes"])
    allowed_roots_json = json.dumps(allowed_roots)
    
    # Python one-liner to execute on the remote machine
    remote_python_code = (
        "import os, json, sys, pathlib\n"
        "target = sys.argv[1] if len(sys.argv) > 1 else '/'\n"
        "roots = json.loads(sys.argv[2])\n"
        "def is_allowed(p_str):\n"
        "    try:\n"
        "        p = pathlib.Path(p_str)\n"
        "        if p.exists(): resolved = p.resolve()\n"
        "        else:\n"
        "            parent = p\n"
        "            while not parent.exists():\n"
        "                if parent.parent == parent: break\n"
        "                parent = parent.parent\n"
        "            resolved = parent.resolve()\n"
        "        for r in roots:\n"
        "            rp = pathlib.Path(r).resolve()\n"
        "            if rp == resolved or rp in resolved.parents: return True\n"
        "    except Exception: pass\n"
        "    return False\n"
        "try:\n"
        "    abs_target = os.path.abspath(target)\n"
        "    if not is_allowed(abs_target):\n"
        "        abs_target = os.path.abspath(roots[0])\n"
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
        "        if parent == abs_target or not is_allowed(parent):\n"
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
        f"env PATH=\"/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/sbin\" python3 -c \"{escaped_code}\" \"{target_path}\" '{allowed_roots_json}'"
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
    import json
    config = command_builder.load_config()
    remotes = config.get("remote_servers", {})
    if remote_name not in remotes:
        raise HTTPException(status_code=400, detail=f"Remote server '{remote_name}' not configured.")
        
    rc = remotes[remote_name]
    user = rc.get("user")
    host = rc.get("host")
    key_path = rc.get("key_path")
    allowed_roots = rc.get("allowed_roots", ["/Users/sri", "/Volumes"])
    allowed_roots_json = json.dumps(allowed_roots)
    
    remote_code = (
        "import os, sys, pathlib, json\n"
        "src = sys.argv[1]\n"
        "new_name = sys.argv[2]\n"
        "roots = json.loads(sys.argv[3])\n"
        "def is_allowed(p_str):\n"
        "    try:\n"
        "        p = pathlib.Path(p_str)\n"
        "        if p.exists(): resolved = p.resolve()\n"
        "        else:\n"
        "            parent = p\n"
        "            while not parent.exists():\n"
        "                if parent.parent == parent: break\n"
        "                parent = parent.parent\n"
        "            resolved = parent.resolve()\n"
        "        for r in roots:\n"
        "            rp = pathlib.Path(r).resolve()\n"
        "            if rp == resolved or rp in resolved.parents: return True\n"
        "    except Exception: pass\n"
        "    return False\n"
        "try:\n"
        "    if not is_allowed(src):\n"
        "        print('403: Forbidden path')\n"
        "        sys.exit(4)\n"
        "    if not os.path.exists(src):\n"
        "        print('404: Source not found')\n"
        "        sys.exit(1)\n"
        "    parent = os.path.dirname(src)\n"
        "    dest = os.path.join(parent, new_name)\n"
        "    if not is_allowed(dest):\n"
        "        print('403: Forbidden destination path')\n"
        "        sys.exit(5)\n"
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
        f"env PATH=\"/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/sbin\" python3 -c \"{escaped_code}\" \"{source_path}\" \"{new_name}\" '{allowed_roots_json}'"
    ]
    
    try:
        proc = subprocess.run(ssh_cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=10.0)
        output = proc.stdout.strip()
        
        if proc.returncode == 1:
            raise HTTPException(status_code=404, detail="Source file or folder not found on remote server.")
        elif proc.returncode == 2:
            raise HTTPException(status_code=400, detail="A file or folder with the new name already exists on remote server.")
        elif proc.returncode in (4, 5):
            raise HTTPException(status_code=403, detail="Access denied: Path is outside allowed directories.")
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
    allowed = get_allowed_roots(remote_server)
    if not allowed:
        raise HTTPException(status_code=500, detail="Allowed roots not configured.")
        
    # If client requests root or empty or not allowed, redirect to the first allowed root
    if target_path == "/" or not target_path or not is_path_allowed(target_path, remote_server):
        target_path = allowed[0]
        
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
    dest = src.parent / request.new_name
    
    if not is_path_allowed(str(src)) or not is_path_allowed(str(dest)):
        raise HTTPException(status_code=403, detail="Access denied: Path is outside allowed directories.")
        
    if not src.exists():
        raise HTTPException(status_code=404, detail="Source file or folder not found.")
    
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
        
    # Path Validation
    if request.destination_path:
        dest_server = None
        if action_data.get("requires_remote") and request.remote_server:
            dest_server = request.remote_server
        elif request.source_server and not action_data.get("requires_remote"):
            dest_server = request.source_server
            
        if not is_path_allowed(request.destination_path, dest_server):
            raise HTTPException(status_code=403, detail="Access denied: Destination path is outside allowed directories.")
            
    src_server = request.source_server if request.source_server else None
    for src in request.source_paths:
        if not is_path_allowed(src, src_server):
            raise HTTPException(status_code=403, detail="Access denied: Source path is outside allowed directories.")

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

@app.get("/api/tasks/counts")
def get_task_counts():
    """Serves real-time ongoing and pending task counts for the header ticker."""
    return database.get_task_counts()

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

def _clean_shell_url(url_str: str) -> str:
    cleaned = str(url_str).replace('"', '').replace("'", "")
    return f"'{cleaned}'"

@app.post("/api/execute/generic")
async def execute_generic(request: GenericTaskRequest):
    """Parses dynamic inputs into a template and queues the task(s)."""
    import re
    config = command_builder.load_config()
    cards = config.get("generic_cards", {})
    
    if request.card_name not in cards:
        raise HTTPException(status_code=404, detail="Generic card configuration not found.")
        
    card_config = cards[request.card_name]
    
    # Path validation for generic card inputs
    inputs_schema = card_config.get("inputs", [])
    for inp in inputs_schema:
        inp_id = inp.get("id")
        inp_type = inp.get("type")
        if inp_type in ("directory", "file") and inp_id in request.inputs:
            val = str(request.inputs[inp_id])
            if not is_path_allowed(val):
                raise HTTPException(status_code=403, detail=f"Access denied: Input '{inp_id}' path is outside allowed directories.")

    template = card_config.get("command_template", "")
    queue_name = card_config.get("task_type", "default")
    batch_size = card_config.get("batch_size")
    
    # Check if we have a multi-link input (e.g. 'url' or similar list field)
    urls_input = request.inputs.get("url", "")
    urls_list = []
    if urls_input:
        # Split by newlines, spaces, or commas
        items = re.split(r'[\r\n,\s]+', str(urls_input).strip())
        urls_list = [item.strip() for item in items if item.strip()]
        
    if batch_size or len(urls_list) > 1:
        if not urls_list:
            raise HTTPException(status_code=400, detail="No valid URLs or links provided.")
            
        bs = int(batch_size) if batch_size else 5
        url_batches = [urls_list[i:i + bs] for i in range(0, len(urls_list), bs)]
        
        queued_tasks = []
        for batch in url_batches:
            # Single-quote each URL safely for shell command execution
            batch_url_str = " ".join(_clean_shell_url(u) for u in batch)
            
            cmd = template
            for key, value in request.inputs.items():
                if key == "url":
                    cmd = cmd.replace("{url}", batch_url_str)
                else:
                    cmd = cmd.replace(f"{{{key}}}", str(value))
                    
            task_id = await executor.start_task(cmd, queue_name=queue_name)
            queued_tasks.append(task_id)
            
        return {
            "message": f"Successfully queued {len(queued_tasks)} task(s) ({len(urls_list)} links total).",
            "queued_count": len(queued_tasks),
            "queue": queue_name
        }
    else:
        # Single execution fallback
        command = template
        for key, value in request.inputs.items():
            if key == "url" and urls_list:
                single_url_str = _clean_shell_url(urls_list[0])
                command = command.replace("{url}", single_url_str)
            else:
                command = command.replace(f"{{{key}}}", str(value))
                
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


# --- FOLDER LIBRARIES SYSTEM ---

class LibrarySyncRequest(BaseModel):
    library_name: str
    relative_path: str
    direction: str # "backup" or "restore"

def get_local_library_metadata(base_path: str, subpath: str, deep_scan: bool = False) -> dict:
    import os
    from pathlib import Path
    target_path = Path(base_path) / subpath
    try:
        target_path = target_path.resolve()
    except Exception:
        pass
    
    if not is_path_allowed(str(target_path), None):
        raise Exception(f"Access denied: Path '{target_path}' is outside allowed directories.")
        
    if not target_path.exists() or not target_path.is_dir():
        return {}
        
    result = {}
    if deep_scan:
        for root, dirs, files in os.walk(str(target_path)):
            for name in dirs + files:
                full_path = Path(root) / name
                try:
                    rel_path = full_path.relative_to(target_path).as_posix()
                    is_dir = full_path.is_dir()
                    stat = full_path.stat()
                    size = stat.st_size if not is_dir else 0
                    mtime = stat.st_mtime
                    result[rel_path] = {
                        "name": name,
                        "is_dir": is_dir,
                        "size": size,
                        "mtime": mtime,
                        "path": str(full_path.absolute())
                    }
                except Exception:
                    pass
    else:
        for entry in os.scandir(str(target_path)):
            try:
                is_dir = entry.is_dir()
                stat = entry.stat()
                size = stat.st_size if not is_dir else 0
                mtime = stat.st_mtime
                result[entry.name] = {
                    "name": entry.name,
                    "is_dir": is_dir,
                    "size": size,
                    "mtime": mtime,
                    "path": entry.path
                }
            except Exception:
                pass
    return result

def get_remote_library_metadata(remote_server: str, base_path: str, subpath: str, deep_scan: bool = False) -> dict:
    import subprocess
    import json
    config = command_builder.load_config()
    remotes = config.get("remote_servers", {})
    if remote_server not in remotes:
        raise Exception(f"Remote server '{remote_server}' not configured.")
        
    rc = remotes[remote_server]
    user = rc.get("user")
    host = rc.get("host")
    key_path = rc.get("key_path")
    allowed_roots = rc.get("allowed_roots", ["/Users/sri", "/Volumes"])
    allowed_roots_json = json.dumps(allowed_roots)
    
    remote_python_code = (
        "import os, json, sys, pathlib\n"
        "base_path = sys.argv[1]\n"
        "subpath = sys.argv[2]\n"
        "roots = json.loads(sys.argv[3])\n"
        "deep_scan = sys.argv[4].lower() == 'true'\n"
        "def is_allowed(p_str):\n"
        "    try:\n"
        "        p = pathlib.Path(p_str)\n"
        "        if p.exists(): resolved = p.resolve()\n"
        "        else:\n"
        "            parent = p\n"
        "            while not parent.exists():\n"
        "                if parent.parent == parent: break\n"
        "                parent = parent.parent\n"
        "            resolved = parent.resolve()\n"
        "        for r in roots:\n"
        "            rp = pathlib.Path(r).resolve()\n"
        "            if rp == resolved or rp in resolved.parents: return True\n"
        "    except Exception: pass\n"
        "    return False\n"
        "try:\n"
        "    target_path = os.path.join(base_path, subpath)\n"
        "    p = pathlib.Path(target_path)\n"
        "    abs_target = str(p.resolve() if p.exists() else p)\n"
        "    if not is_allowed(abs_target):\n"
        "        print(json.dumps({'success': False, 'error': 'Path outside allowed roots'}))\n"
        "        sys.exit(0)\n"
        "    result = {}\n"
        "    if not os.path.exists(abs_target) or not os.path.isdir(abs_target):\n"
        "        print(json.dumps({'success': True, 'metadata': {}}))\n"
        "        sys.exit(0)\n"
        "    if deep_scan:\n"
        "        for root, dirs, files in os.walk(abs_target):\n"
        "            for name in dirs + files:\n"
        "                full = os.path.join(root, name)\n"
        "                rel = str(pathlib.Path(full).relative_to(abs_target).as_posix())\n"
        "                is_d = os.path.isdir(full)\n"
        "                try:\n"
        "                    st = os.stat(full)\n"
        "                    size = st.st_size if not is_d else 0\n"
        "                    mtime = st.st_mtime\n"
        "                except Exception:\n"
        "                    size = 0\n"
        "                    mtime = 0\n"
        "                result[rel] = {'name': name, 'is_dir': is_d, 'size': size, 'mtime': mtime, 'path': full}\n"
        "    else:\n"
        "        with os.scandir(abs_target) as it:\n"
        "            for entry in it:\n"
        "                try:\n"
        "                    is_d = entry.is_dir()\n"
        "                    st = entry.stat()\n"
        "                    size = st.st_size if not is_d else 0\n"
        "                    mtime = st.st_mtime\n"
        "                    result[entry.name] = {'name': entry.name, 'is_dir': is_d, 'size': size, 'mtime': mtime, 'path': entry.path}\n"
        "                except Exception:\n"
        "                    pass\n"
        "    print(json.dumps({'success': True, 'metadata': result}))\n"
        "except Exception as e:\n"
        "    print(json.dumps({'success': False, 'error': str(e)}))\n"
    )
    
    escaped_code = remote_python_code.replace('"', '\\"').replace('$', '\\$')
    ssh_cmd = [
        "ssh",
        "-o", "StrictHostKeyChecking=no",
        "-i", key_path,
        f"{user}@{host}",
        f"env PATH=\"/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/sbin\" python3 -c \"{escaped_code}\" \"{base_path}\" \"{subpath}\" '{allowed_roots_json}' '{str(deep_scan)}'"
    ]
    
    proc = subprocess.run(ssh_cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=20.0)
    if proc.returncode != 0:
        raise Exception(f"SSH command failed: {proc.stderr}")
        
    res = json.loads(proc.stdout.strip())
    if not res.get("success"):
        raise Exception(res.get("error", "Unknown remote error"))
        
    return res.get("metadata", {})

def get_library_union(source_meta: dict, backup_meta: dict) -> list:
    union_keys = set(source_meta.keys()).union(set(backup_meta.keys()))
    items = []
    
    for key in union_keys:
        src = source_meta.get(key)
        bk = backup_meta.get(key)
        
        name = src["name"] if src else bk["name"]
        is_dir = src["is_dir"] if src else bk["is_dir"]
        
        if src and not bk:
            status = "only_source"
        elif bk and not src:
            status = "only_backup"
        else:
            if is_dir:
                status = "synced"
            else:
                size_match = src["size"] == bk["size"]
                time_match = abs(src["mtime"] - bk["mtime"]) < 2.0
                if size_match and time_match:
                    status = "synced"
                else:
                    status = "pending_sync"
                    
        items.append({
            "relative_path": key,
            "name": name,
            "is_dir": is_dir,
            "source_exists": src is not None,
            "backup_exists": bk is not None,
            "status": status,
            "source_size": src["size"] if src else None,
            "backup_size": bk["size"] if bk else None,
            "source_path": src["path"] if src else None,
            "backup_path": bk["path"] if bk else None,
        })
        
    items.sort(key=lambda x: (not x["is_dir"], x["name"].lower()))
    return items

@app.get("/api/libraries")
def list_libraries():
    """Returns all configured folder libraries."""
    config = command_builder.load_config()
    return config.get("libraries", {})

@app.get("/api/libraries/browse")
def browse_library(library_name: str, subpath: str = "", deep_scan: bool = False):
    """Gathers sync comparison for a library's source and backup folders."""
    config = command_builder.load_config()
    libraries = config.get("libraries", {})
    if library_name not in libraries:
        raise HTTPException(status_code=404, detail="Library not configured.")
        
    lib = libraries[library_name]
    src_cfg = lib.get("source")
    bk_cfg = lib.get("backup")
    
    if not src_cfg or not bk_cfg:
        raise HTTPException(status_code=400, detail="Library source and backup settings must be configured.")
        
    # Get source metadata
    try:
        if src_cfg["server"] == "local":
            src_meta = get_local_library_metadata(src_cfg["path"], subpath, deep_scan)
        else:
            src_meta = get_remote_library_metadata(src_cfg["server"], src_cfg["path"], subpath, deep_scan)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Source listing failed: {str(e)}")
        
    # Get backup metadata
    try:
        if bk_cfg["server"] == "local":
            bk_meta = get_local_library_metadata(bk_cfg["path"], subpath, deep_scan)
        else:
            bk_meta = get_remote_library_metadata(bk_cfg["server"], bk_cfg["path"], subpath, deep_scan)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Backup listing failed: {str(e)}")
        
    union_items = get_library_union(src_meta, bk_meta)
    
    # If it is a deep_scan, filter out synced items
    if deep_scan:
        union_items = [item for item in union_items if item["status"] != "synced"]
        
    return {
        "library_name": library_name,
        "subpath": subpath,
        "deep_scan": deep_scan,
        "items": union_items
    }

@app.post("/api/libraries/sync")
async def sync_library_item(request: LibrarySyncRequest):
    """Queues a file copy task to align source and backup repositories."""
    config = command_builder.load_config()
    libraries = config.get("libraries", {})
    remotes = config.get("remote_servers", {})
    
    if request.library_name not in libraries:
        raise HTTPException(status_code=404, detail="Library not configured.")
        
    lib = libraries[request.library_name]
    src_cfg = lib.get("source")
    bk_cfg = lib.get("backup")
    
    if request.direction == "backup":
        from_cfg = src_cfg
        to_cfg = bk_cfg
    else:
        from_cfg = bk_cfg
        to_cfg = src_cfg
        
    import os
    from pathlib import Path
    
    item_rel_path = request.relative_path.replace("\\", "/")
    
    src_base = from_cfg["path"].rstrip("/")
    dst_base = to_cfg["path"].rstrip("/")
    
    src_full = f"{src_base}/{item_rel_path}"
    dst_full = f"{dst_base}/{item_rel_path}"
    
    if not is_path_allowed(src_full, None if from_cfg["server"] == "local" else from_cfg["server"]):
        raise HTTPException(status_code=403, detail="Access denied: Source path is outside allowed roots.")
    if not is_path_allowed(dst_full, None if to_cfg["server"] == "local" else to_cfg["server"]):
        raise HTTPException(status_code=403, detail="Access denied: Destination path is outside allowed roots.")
        
    dst_parent = "/".join(dst_full.split("/")[:-1])
    
    if to_cfg["server"] == "local":
        os.makedirs(dst_parent, exist_ok=True)
    else:
        if to_cfg["server"] not in remotes:
            raise HTTPException(status_code=400, detail="Destination remote server not configured.")
        rc = remotes[to_cfg["server"]]
        user = rc.get("user")
        host = rc.get("host")
        key_path = rc.get("key_path")
        mkdir_cmd = [
            "ssh", "-o", "StrictHostKeyChecking=no", "-i", key_path,
            f"{user}@{host}", f"mkdir -p '{dst_parent}'"
        ]
        import subprocess
        subprocess.run(mkdir_cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)

    if from_cfg["server"] == "local" and to_cfg["server"] == "local":
        cmd = f'cp -r "{src_full}" "{dst_parent}/"'
    elif from_cfg["server"] == "local" and to_cfg["server"] != "local":
        rc = remotes[to_cfg["server"]]
        user = rc.get("user")
        host = rc.get("host")
        key_path = rc.get("key_path")
        cmd = f'scp -o StrictHostKeyChecking=no -i "{key_path}" -r "{src_full}" {user}@{host}:"{dst_parent}/"'
    elif from_cfg["server"] != "local" and to_cfg["server"] == "local":
        rc = remotes[from_cfg["server"]]
        user = rc.get("user")
        host = rc.get("host")
        key_path = rc.get("key_path")
        cmd = f'scp -o StrictHostKeyChecking=no -i "{key_path}" -r {user}@{host}:"{src_full}" "{dst_parent}/"'
    else:
        rc_from = remotes[from_cfg["server"]]
        rc_to = remotes[to_cfg["server"]]
        cmd = f'scp -3 -o StrictHostKeyChecking=no -i "{rc_from.get("key_path")}" -i "{rc_to.get("key_path")}" -r {rc_from.get("user")}@{rc_from.get("host")}:"{src_full}" {rc_to.get("user")}@{rc_to.get("host")}:"{dst_parent}/"'
        
    await executor.start_task(cmd, queue_name="fs")
    return {"message": "Sync copy task queued successfully.", "command": cmd}

    # THIS MUST BE THE VERY LAST THING IN THE FILE
app.mount("/", StaticFiles(directory="static", html=True), name="static")
import os
import glob
import uuid
import shlex
import json
from datetime import datetime
from pathlib import Path
import asyncio
from contextlib import asynccontextmanager
from fastapi import FastAPI, HTTPException, Request, BackgroundTasks, Depends
from fastapi.responses import JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from typing import List, Optional
import executor
import command_builder
import database
import process_manager
import telemetry
from broadcaster import broadcaster

BASE_DIR = Path(__file__).resolve().parent
DEFAULT_CONVERSION_TEMP = BASE_DIR / "conversion_temp"
DEFAULT_CONVERSION_TEMP.mkdir(parents=True, exist_ok=True)

def is_safe_path_string(p: str) -> bool:
    """Guards polymorphic path strings against newlines, control chars, and length overflow."""
    if not isinstance(p, str):
        return False
    if "\n" in p or "\r" in p or "\0" in p or len(p) >= 1024:
        return False
    return True

def get_allowed_roots(remote_server: Optional[str] = None) -> List[str]:
    """Retrieves allowed root directories for path restriction from config.json."""
    config = command_builder.load_config()
    if remote_server:
        remotes = config.get("remote_servers", {})
        if remote_server in remotes:
            return remotes[remote_server].get("allowed_roots", ["/Users/sri", "/Volumes"])
        return ["/Users/sri", "/Volumes"]
    roots = list(config.get("allowed_roots", ["/home/sayang", "/Volumes"]))
    if str(BASE_DIR) not in roots:
        roots.append(str(BASE_DIR))
    return roots

def is_path_allowed(target_path: str, remote_server: Optional[str] = None) -> bool:
    """Verifies if target_path falls strictly within allowed root folders with boundary checks."""
    if not is_safe_path_string(target_path):
        return False
        
    allowed = get_allowed_roots(remote_server)
    try:
        normalized = os.path.normpath(target_path)
        # If it's local, resolve symlinks for extra security
        if not remote_server:
            try:
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
            except (OSError, ValueError):
                return False
            
        for root in allowed:
            root_norm = os.path.normpath(root)
            try:
                common = os.path.commonpath([root_norm, normalized])
                if common == root_norm:
                    return True
            except (ValueError, OSError):
                pass
    except Exception:
        pass
    return False

async def run_async_subprocess(cmd_args: list, timeout: float = 15.0):
    """Executes a subprocess asynchronously with explicit timeout and clean process group termination."""
    proc = await asyncio.create_subprocess_exec(
        *cmd_args,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE
    )
    try:
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout)
        return proc.returncode, stdout.decode('utf-8', errors='replace'), stderr.decode('utf-8', errors='replace')
    except asyncio.TimeoutError:
        try:
            proc.terminate()
            await asyncio.wait_for(proc.wait(), timeout=2.0)
        except Exception:
            try:
                proc.kill()
            except Exception:
                pass
        raise HTTPException(status_code=504, detail="Subprocess timed out after 15 seconds.")

_telemetry_task = None

@asynccontextmanager
async def lifespan(app: FastAPI):
    global _telemetry_task
    # 1. Boot up the SQLite database
    database.init_db()
    database.cleanup_expired_sessions()
    
    # 2. Recover State (Mark orphaned tasks as failed, requeue pending)
    recovered_count = executor.recover_tasks()
    print(f"[*] Pareo Engine Boot: Recovered {recovered_count} pending tasks.")
    
    # 3. Start parallel workers
    executor.start_workers()

    # 4. Background telemetry sampler (every 2.0s)
    async def _telemetry_sampler():
        while True:
            try:
                data = telemetry.get_system_telemetry(get_allowed_roots())
                broadcaster.broadcast_telemetry(data)
            except Exception:
                pass
            await asyncio.sleep(2.0)

    _telemetry_task = asyncio.create_task(_telemetry_sampler())

    print("--- PAREO V2 ROUTING READY (PORT 9046) ---")
    for idx, route in enumerate(app.routes):
        route_type = "API Endpoint" if hasattr(route, "methods") else "CATCH-ALL MOUNT"
        path = getattr(route, "path", getattr(route, "name", "Unknown"))
        print(f"{idx} | {route_type} | {path}")
    print("------------------------------------------")

    yield
    # Cleanly stop telemetry & workers on shutdown
    if _telemetry_task:
        _telemetry_task.cancel()
    await executor.stop_workers()

app = FastAPI(title="Pareo API", lifespan=lifespan)

# --- AUTHENTICATION & RBAC (MVP 2) ---
class PasswordAuthRequest(BaseModel):
    password: str

class UserSetupRequest(BaseModel):
    email: str
    password: str
    confirm_password: Optional[str] = None

class UserRegisterRequest(BaseModel):
    email: str
    password: str
    role: Optional[str] = "Viewer"

class UserLoginRequest(BaseModel):
    email: Optional[str] = None
    password: str

class BatchTaskRequest(BaseModel):
    task_ids: List[str]

async def get_current_user(request: Request) -> dict:
    """Extracts and verifies authenticated user session. Allows setup mode if 0 users."""
    user_count = database.count_users()
    if user_count == 0:
        return {
            "user_id": "setup-root",
            "email": "admin@pareo.local",
            "role": "Admin",
            "is_active": 1,
            "created_at": ""
        }

    token = None
    auth_header = request.headers.get("Authorization")
    if auth_header and auth_header.startswith("Bearer "):
        token = auth_header[7:].strip()
    elif request.headers.get("X-Pareo-Auth"):
        token = request.headers.get("X-Pareo-Auth").strip()
    elif "token" in request.query_params:
        token = request.query_params["token"].strip()

    if not token:
        raise HTTPException(status_code=401, detail="Authentication token required")

    session = database.get_session(token)
    if not session:
        raise HTTPException(status_code=401, detail="Invalid or expired session token")

    user = database.get_user_by_id(session["user_id"])
    if not user or not user.get("is_active"):
        raise HTTPException(status_code=401, detail="User account is inactive or disabled")

    user_dict = dict(user)
    user_dict.pop("password_hash", None)
    user_dict.pop("salt", None)
    user_dict["token"] = token
    return user_dict

def require_role(allowed_roles: List[str]):
    """Role-Based Access Control dependency factory."""
    async def role_checker(user: dict = Depends(get_current_user)):
        if user.get("role") not in allowed_roles:
            raise HTTPException(status_code=403, detail="Forbidden: Insufficient privileges for this operation")
        return user
    return role_checker

@app.middleware("http")
async def auth_middleware(request: Request, call_next):
    """Pass-through middleware allowing FastAPI dependencies to enforce fine-grained auth."""
    return await call_next(request)

@app.get("/api/auth/status")
def auth_status():
    """Returns whether system is initialized with at least one user."""
    cnt = database.count_users()
    return {"initialized": cnt > 0, "user_count": cnt}

@app.post("/api/auth/setup-admin")
def setup_admin(req: UserSetupRequest):
    """Creates the root Admin account on first system initialization."""
    if database.count_users() > 0:
        raise HTTPException(status_code=400, detail="System is already initialized.")
    if req.confirm_password and req.password != req.confirm_password:
        raise HTTPException(status_code=400, detail="Passwords do not match.")
    if not req.email or "@" not in req.email or len(req.email) >= 256:
        raise HTTPException(status_code=400, detail="Invalid email address.")
    if len(req.password) < 6:
        raise HTTPException(status_code=400, detail="Password must be at least 6 characters.")
    user = database.create_user(req.email, req.password, role="Admin")
    session = database.create_session(user["user_id"])
    return {"token": session["token"], "user": user}

@app.post("/api/auth/register")
def register_user(req: UserRegisterRequest, request: Request):
    """Registers a user account. Requires Admin credentials once initialized."""
    user_count = database.count_users()
    if user_count > 0:
        token = None
        auth_header = request.headers.get("Authorization")
        if auth_header and auth_header.startswith("Bearer "):
            token = auth_header[7:].strip()
        elif request.headers.get("X-Pareo-Auth"):
            token = request.headers.get("X-Pareo-Auth").strip()
        elif "token" in request.query_params:
            token = request.query_params["token"].strip()
            
        if not token:
            raise HTTPException(status_code=401, detail="Admin token required to register users.")
        sess = database.get_session(token)
        if not sess:
            raise HTTPException(status_code=401, detail="Invalid token.")
        admin_user = database.get_user_by_id(sess["user_id"])
        if not admin_user or admin_user.get("role") != "Admin":
            raise HTTPException(status_code=403, detail="Only Admin can register new users.")

    if not req.email or "@" not in req.email or len(req.email) >= 256:
        raise HTTPException(status_code=400, detail="Invalid email address.")
    if len(req.password) < 6:
        raise HTTPException(status_code=400, detail="Password must be at least 6 characters.")

    existing = database.get_user_by_email(req.email)
    if existing:
        raise HTTPException(status_code=400, detail="Email already registered")

    role = "Admin" if user_count == 0 else (req.role or "Viewer")
    if role not in ["Admin", "Operator", "Viewer"]:
        role = "Viewer"

    user = database.create_user(req.email, req.password, role=role)
    session = database.create_session(user["user_id"])
    return {"token": session["token"], "user": user}

@app.post("/api/auth/login")
def login_auth(req: UserLoginRequest):
    """Validates user credentials, creates session, or provides backwards-compat fallback."""
    user_count = database.count_users()
    if user_count == 0 or not req.email:
        return {"status": "authorized", "mode": "no-auth", "token": "no-auth-token"}

    user = database.get_user_by_email(req.email)
    if not user or not user.get("is_active"):
        raise HTTPException(status_code=401, detail="Invalid email or password")

    if not database.verify_password(req.password, user["salt"], user["password_hash"]):
        raise HTTPException(status_code=401, detail="Invalid email or password")

    database.update_user_last_login(user["user_id"])
    session = database.create_session(user["user_id"])
    return {
        "token": session["token"],
        "user": {
            "user_id": user["user_id"],
            "email": user["email"],
            "role": user["role"],
            "created_at": user["created_at"]
        }
    }

@app.post("/api/auth/logout")
def logout_auth(request: Request, user: dict = Depends(get_current_user)):
    """Revokes active session."""
    token = user.get("token")
    if token:
        database.delete_session(token)
    return {"status": "logged_out"}

@app.get("/api/auth/me")
def get_current_user_profile(user: dict = Depends(get_current_user)):
    """Returns profile for currently authenticated user."""
    return {
        "user_id": user["user_id"],
        "email": user["email"],
        "role": user["role"],
        "created_at": user.get("created_at", "")
    }

@app.get("/api/auth/verify")
def verify_auth(request: Request):
    """Validates session or reports uninitialized state."""
    user_count = database.count_users()
    if user_count == 0:
        return {"status": "authorized", "mode": "no-auth"}
    token = None
    auth_header = request.headers.get("Authorization")
    if auth_header and auth_header.startswith("Bearer "):
        token = auth_header[7:].strip()
    elif request.headers.get("X-Pareo-Auth"):
        token = request.headers.get("X-Pareo-Auth").strip()
    elif "token" in request.query_params:
        token = request.query_params["token"].strip()
    if not token:
        return {"status": "unauthorized", "mode": "auth"}
    session = database.get_session(token)
    if not session:
        return {"status": "unauthorized", "mode": "auth"}
    user = database.get_user_by_id(session["user_id"])
    if not user or not user.get("is_active"):
        return {"status": "unauthorized", "mode": "auth"}
    return {
        "status": "authorized",
        "mode": "auth",
        "user": {
            "user_id": user["user_id"],
            "email": user["email"],
            "role": user["role"]
        }
    }

@app.post("/api/auth/setup")
def setup_password(req: PasswordAuthRequest):
    """Compatibility endpoint for legacy password setup tests."""
    return {"status": "authorized", "mode": "no-auth", "token": "no-auth-token"}

# --- TELEMETRY & BATCH QUEUE ENDPOINTS ---

@app.get("/api/telemetry")
def get_telemetry_snapshot(user: dict = Depends(get_current_user)):
    """Returns current host and queue telemetry snapshot."""
    return telemetry.get_system_telemetry(get_allowed_roots())

@app.post("/api/tasks/batch/cancel")
async def batch_cancel_tasks_endpoint(req: BatchTaskRequest, user: dict = Depends(require_role(["Admin", "Operator"]))):
    """Cancels multiple tasks in one call."""
    cancelled = await executor.batch_cancel_tasks(req.task_ids)
    return {"cancelled_count": len(cancelled), "task_ids": cancelled}

@app.post("/api/tasks/batch/retry")
async def batch_retry_tasks_endpoint(req: BatchTaskRequest, user: dict = Depends(require_role(["Admin", "Operator"]))):
    """Retries multiple failed or cancelled tasks in one call."""
    retried = await executor.batch_retry_tasks(req.task_ids)
    return {"retried_count": len(retried), "task_ids": retried}

@app.post("/api/tasks/batch/purge")
async def batch_purge_tasks_endpoint(req: BatchTaskRequest, user: dict = Depends(require_role(["Admin", "Operator"]))):
    """Purges multiple finished or cancelled tasks in one call."""
    purged = await executor.batch_purge_tasks(req.task_ids)
    return {"purged_count": len(purged), "task_ids": purged}

# --- REAL-TIME SERVER-SENT EVENTS (SSE) BUS ---
@app.get("/api/stream/events")
async def stream_events(request: Request):
    """Server-Sent Events endpoint streaming live task status, logs, queue counts, and telemetry."""
    user_count = database.count_users()
    if user_count > 0:
        token = None
        auth_header = request.headers.get("Authorization")
        if auth_header and auth_header.startswith("Bearer "):
            token = auth_header[7:].strip()
        elif request.headers.get("X-Pareo-Auth"):
            token = request.headers.get("X-Pareo-Auth").strip()
        elif "token" in request.query_params:
            token = request.query_params["token"].strip()
            
        if not token:
            raise HTTPException(status_code=401, detail="Authentication token required")
        session = database.get_session(token)
        if not session:
            raise HTTPException(status_code=401, detail="Invalid or expired session token")

    queue = await broadcaster.subscribe()
    
    async def event_generator():
        # Yield initial connected event
        yield f"event: connected\ndata: {json.dumps({'status': 'connected'})}\n\n"
        
        # Yield initial task counts
        try:
            counts = database.get_task_counts()
            yield f"event: task_counts\ndata: {json.dumps(counts)}\n\n"
        except Exception:
            pass

        try:
            while True:
                if await request.is_disconnected():
                    break
                try:
                    msg = await asyncio.wait_for(queue.get(), timeout=15.0)
                    yield msg
                except asyncio.TimeoutError:
                    # 15s keepalive heartbeat ping
                    yield ": ping\n\n"
        except (asyncio.CancelledError, GeneratorExit, Exception):
            pass
        finally:
            await broadcaster.unsubscribe(queue)

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no"
        }
    )


# --- MODELS ---
class GenericTaskRequest(BaseModel):
    card_name: str
    inputs: dict

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
    remote_server: Optional[str] = ""
    source_server: Optional[str] = ""

class SwitchboardRequest(BaseModel):
    category: str
    button_name: str

class RenameRequest(BaseModel):
    source_path: str
    new_name: str
    remote_server: Optional[str] = ""

# --- CONFIG & EXECUTION ENDPOINTS ---

@app.post("/api/execute/ls")
async def execute_ls(user: dict = Depends(require_role(["Admin", "Operator"]))):
    """Queues the 'ls -ltr' command."""
    task_id = await executor.start_task("ls -ltr")
    return {"task_id": task_id, "message": "Command queued."}

@app.get("/api/config/ffmpeg")
def get_ffmpeg_config(user: dict = Depends(get_current_user)):
    """Serves the complete FFMPEG profile schema from config.json."""
    config = command_builder.load_config()
    profiles = config.get("ffmpeg", {}).get("profiles", {})
    return {"profiles": profiles}

@app.post("/api/execute/ffmpeg")
async def execute_ffmpeg(request: FfmpegRequest, user: dict = Depends(require_role(["Admin", "Operator"]))):
    """Builds and queues one or multiple FFMPEG jobs."""
    if not is_path_allowed(request.input_target) or not is_path_allowed(request.output_target):
        raise HTTPException(status_code=403, detail="Access denied: Paths must reside within allowed root directories.")
        
    tasks = []
    
    if request.mode == "single":
        command = command_builder.build_ffmpeg_command(
            request.input_target, 
            request.output_target, 
            request.profile
        )
        task_id = await executor.start_task(command, queue_name="media")
        tasks.append(task_id)
        
    elif request.mode == "batch":
        src_path = Path(request.input_target)
        dest_path = Path(request.output_target)
        
        if not src_path.is_dir() or not dest_path.is_dir():
            raise HTTPException(status_code=400, detail="Batch mode requires both Input and Output targets to be directories.")
            
        extensions = ('*.mp4', '*.mkv', '*.avi', '*.mov', '*.flv', '*.ts')
        files = []
        for ext in extensions:
            files.extend(src_path.glob(ext))
            
        if not files:
            raise HTTPException(status_code=404, detail="No matching media files found in the source directory.")
            
        for file in sorted(files):
            out_filename = f"{file.stem}{request.output_extension}"
            out_file = dest_path / out_filename
            command = command_builder.build_ffmpeg_command(str(file), str(out_file), request.profile)
            task_id = await executor.start_task(command, queue_name="media")
            tasks.append(task_id)

    return {"message": f"Successfully queued {len(tasks)} FFMPEG task(s).", "tasks": tasks}

@app.get("/api/config/fs")
def get_fs_config(user: dict = Depends(get_current_user)):
    """Serves the file operations configuration."""
    config = command_builder.load_config()
    return config.get("file_operations", {})

@app.get("/api/config/bookmarks")
def get_bookmarks_config(user: dict = Depends(get_current_user)):
    """Serves the global bookmarks schema for quick-access paths."""
    config = command_builder.load_config()
    return config.get("bookmarks", {})

@app.get("/api/config/remotes")
def get_remotes_config(user: dict = Depends(get_current_user)):
    """Serves the Remote Servers config schema (including context-aware bookmarks)."""
    config = command_builder.load_config()
    return config.get("remote_servers", {})

# --- ASYNC REMOTE FS HANDLERS ---

async def list_remote_directory(remote_name: str, target_path: str):
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
        retcode, stdout, stderr = await run_async_subprocess(ssh_cmd, timeout=15.0)
        if retcode != 0:
            raise HTTPException(status_code=500, detail=f"SSH command failed: {stderr}")
            
        result = json.loads(stdout.strip())
        if not result.get("success"):
            raise HTTPException(status_code=400, detail=result.get("error", "Unknown remote error"))
            
        return result
    except HTTPException:
        raise
    except json.JSONDecodeError:
        raise HTTPException(status_code=500, detail=f"Invalid response from remote server: {stdout} {stderr}")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

async def rename_remote_item(remote_name: str, source_path: str, new_name: str):
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
        retcode, stdout, stderr = await run_async_subprocess(ssh_cmd, timeout=15.0)
        output = stdout.strip()
        
        if retcode == 1:
            raise HTTPException(status_code=404, detail="Source file or folder not found on remote server.")
        elif retcode == 2:
            raise HTTPException(status_code=400, detail="A file or folder with the new name already exists on remote server.")
        elif retcode in (4, 5):
            raise HTTPException(status_code=403, detail="Access denied: Path is outside allowed directories.")
        elif retcode != 0:
            raise HTTPException(status_code=500, detail=f"Failed to rename on remote: {output} {stderr}")
            
        return {"success": True, "message": f"Renamed remote item to {new_name}"}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/fs/list")
async def list_directory(target_path: str = "/", remote_server: Optional[str] = "", user: dict = Depends(get_current_user)):
    """Returns a JSON array of files and folders for the Explorer Modal."""
    allowed = get_allowed_roots(remote_server)
    if not allowed:
        raise HTTPException(status_code=500, detail="Allowed roots not configured.")
        
    if target_path == "/" or not target_path or not is_path_allowed(target_path, remote_server):
        target_path = allowed[0]
        
    if remote_server:
        return await list_remote_directory(remote_server, target_path)
        
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
                pass
                
        items.sort(key=lambda x: (not x["is_dir"], x["name"].lower()))
        parent_path = str(p.parent.absolute()) if p.parent != p else None
        return {
            "target_path": str(p.absolute()),
            "parent_path": parent_path,
            "items": items
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/fs/rename")
async def rename_fs_item(request: RenameRequest, user: dict = Depends(require_role(["Admin", "Operator"]))):
    """Renames a file or folder immediately using local or remote execution."""
    if request.remote_server:
        return await rename_remote_item(request.remote_server, request.source_path, request.new_name)
        
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
async def execute_fs_action(request: FsRequest, user: dict = Depends(require_role(["Admin", "Operator"]))):
    """Queues one or multiple file system operations."""
    config = command_builder.load_config()
    actions = config.get("file_operations", {}).get("actions", {})
    remotes = config.get("remote_servers", {})
    
    action_data = actions.get(request.action)
    if not action_data:
        raise HTTPException(status_code=400, detail=f"Unknown file operation: {request.action}")
        
    requires_remote = action_data.get("requires_remote", False)
    remote_config = remotes.get(request.remote_server) if (requires_remote and request.remote_server) else None
    
    if requires_remote and not remote_config:
        raise HTTPException(status_code=400, detail=f"Action '{request.action}' requires a valid remote server.")

    for src in request.source_paths:
        if not is_path_allowed(src, request.source_server or None):
            raise HTTPException(status_code=403, detail=f"Access denied for source path: {src}")
            
    if action_data.get("requires_dest"):
        if not request.destination_path:
            raise HTTPException(status_code=400, detail=f"Action '{request.action}' requires a destination path.")
        if not is_path_allowed(request.destination_path, request.remote_server or None):
            raise HTTPException(status_code=403, detail="Access denied for destination path.")

    tasks = []
    for src in request.source_paths:
        command = command_builder.build_fs_command(
            request.action,
            src,
            request.destination_path,
            remote_config
        )
        task_id = await executor.start_task(command, queue_name="fs")
        tasks.append(task_id)
        
    return {"message": f"Successfully queued {len(tasks)} file operation(s).", "tasks": tasks}

# --- SWITCHBOARD & GENERIC TASKS ---
@app.get("/api/config/switchboard")
def get_switchboard_config(user: dict = Depends(get_current_user)):
    """Serves the dynamic switchboard layout."""
    config = command_builder.load_config()
    return config.get("switchboard", {})

@app.post("/api/execute/switchboard")
async def execute_switchboard(request: SwitchboardRequest, user: dict = Depends(require_role(["Admin", "Operator"]))):
    """Dispatches a switchboard action based on its configuration."""
    config = command_builder.load_config()
    switchboard = config.get("switchboard", {})
    category_buttons = switchboard.get(request.category, {}).get("buttons", {})
    
    button_data = category_buttons.get(request.button_name)
    if not button_data:
        raise HTTPException(status_code=400, detail=f"Button '{request.button_name}' not found.")
        
    command = button_data.get("command")
    execution_type = button_data.get("type", "queue")
    
    if not command:
        raise HTTPException(status_code=400, detail="No command associated with this action.")

    if execution_type == "immediate":
        res = await executor.fire_immediate_command(command, detached=False)
        return {
            "type": "immediate",
            "success": res["success"],
            "output": res["output"]
        }
    elif execution_type == "detached":
        res = await executor.fire_immediate_command(command, detached=True)
        return {
            "type": "detached",
            "success": res["success"],
            "output": res["output"]
        }
    else:
        q_name = executor.resolve_queue_from_command(command)
        task_id = await executor.start_task(command, queue_name=q_name)
        return {
            "type": "queue",
            "task_id": task_id,
            "message": f"Task successfully queued in '{q_name.upper()}'."
        }

@app.get("/api/config/cards")
def get_generic_cards_config(user: dict = Depends(get_current_user)):
    """Serves custom form definitions from config.json."""
    config = command_builder.load_config()
    return config.get("cards", {})

@app.post("/api/execute/generic")
async def execute_generic_card(request: GenericTaskRequest, user: dict = Depends(require_role(["Admin", "Operator"]))):
    """Parses inputs and pushes the resolved command to the background executor."""
    config = command_builder.load_config()
    cards = config.get("cards", {})
    
    card_data = cards.get(request.card_name)
    if not card_data:
        raise HTTPException(status_code=400, detail=f"Card '{request.card_name}' does not exist.")
        
    template = card_data.get("command_template", "")
    for field in card_data.get("fields", []):
        name = field["name"]
        val = request.inputs.get(name, field.get("default", ""))
        
        if field.get("type") == "path":
            if not is_path_allowed(str(val)):
                raise HTTPException(status_code=403, detail=f"Access denied for path field '{name}'.")
                
        template = template.replace(f"{{{name}}}", str(val))
        
    q_name = card_data.get("queue", executor.resolve_queue_from_command(template))
    task_id = await executor.start_task(template, queue_name=q_name)
    return {"message": f"Task queued successfully in {q_name.upper()}.", "task_id": task_id}

# --- PROCESS SUPERVISION ---
@app.get("/api/config/processes")
def get_processes_config(user: dict = Depends(get_current_user)):
    """Serves the processes configuration from config.json."""
    config = command_builder.load_config()
    return config.get("processes", {})

@app.get("/api/processes/status")
async def get_all_process_statuses(user: dict = Depends(get_current_user)):
    """Returns dynamic status checks for all configured processes."""
    statuses = await process_manager.get_all_process_statuses()
    return statuses

@app.post("/api/processes/{name}/start")
async def start_process_endpoint(name: str, user: dict = Depends(require_role(["Admin"]))):
    """Spawns the target process daemon."""
    res = await process_manager.start_process(name)
    if not res["success"]:
        raise HTTPException(status_code=500, detail=res["message"])
    return res

@app.post("/api/processes/{name}/stop")
async def stop_process_endpoint(name: str, user: dict = Depends(require_role(["Admin"]))):
    """Halts the target process daemon."""
    res = await process_manager.stop_process(name)
    if not res["success"]:
        raise HTTPException(status_code=500, detail=res["message"])
    return res

@app.get("/api/processes/{name}/logs")
def get_process_logs_endpoint(name: str, lines: int = 200, user: dict = Depends(get_current_user)):
    """Fetches real-time log output for a daemon process."""
    logs = process_manager.get_process_logs(name, lines=lines)
    return {"name": name, "logs": logs}

# --- TASK QUERIES & LIFECYCLE ---
@app.get("/api/tasks/counts")
def get_task_counts(user: dict = Depends(get_current_user)):
    """Returns exact counts of ongoing and pending tasks."""
    return database.get_task_counts()

@app.get("/api/tasks")
def get_tasks(limit: int = 15, offset: int = 0, queue: str = None, status: str = None, command: str = None, user: dict = Depends(get_current_user)):
    """Retrieves paginated historical tasks metadata."""
    return database.get_tasks_paginated(limit=limit, offset=offset, queue=queue, status=status, command=command)

@app.get("/api/tasks/{task_id}")
def get_task_details(task_id: str, user: dict = Depends(get_current_user)):
    """Retrieves full details and complete terminal output for a task."""
    task = database.get_task(task_id)
    if not task:
        return {"error": "Task not found."}
    return task

@app.get("/api/tasks/{task_id}/output")
def get_task_output(task_id: str, user: dict = Depends(get_current_user)):
    """Retrieves pure output text for a task."""
    task = database.get_task(task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    return {"task_id": task_id, "output": task.get("output", "")}

@app.post("/api/tasks/{task_id}/cancel")
async def cancel_task_endpoint(task_id: str, user: dict = Depends(require_role(["Admin", "Operator"]))):
    """Terminates an ongoing task or removes it from queue."""
    try:
        await executor.cancel_task(task_id)
        return {"message": "Task cancelled successfully."}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

@app.post("/api/tasks/{task_id}/retry")
async def retry_task_endpoint(task_id: str, user: dict = Depends(require_role(["Admin", "Operator"]))):
    """Requeues a failed or cancelled task."""
    try:
        await executor.retry_task(task_id)
        return {"message": "Task requeued successfully."}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

@app.post("/api/tasks/purge")
def purge_tasks_endpoint(age: str = "1w", user: dict = Depends(require_role(["Admin", "Operator"]))):
    """Prunes historical completed/failed tasks from SQLite."""
    try:
        deleted = database.purge_tasks(age)
        return {"message": f"Successfully purged {deleted} tasks."}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

# --- FOLDER LIBRARIES & MEDIA CONVERSION PIPELINE ---

def get_local_library_metadata(base_path: str, subpath: str, deep_scan: bool = False) -> dict:
    """Scans local folder directory structure and computes metadata."""
    target_path = os.path.join(base_path, subpath)
    p = Path(target_path)
    if not p.exists() or not p.is_dir():
        return {}
        
    result = {}
    if deep_scan:
        for root, dirs, files in os.walk(str(p.resolve())):
            for name in dirs + files:
                try:
                    full = os.path.join(root, name)
                    rel = os.path.relpath(full, str(p.resolve()))
                    is_d = os.path.isdir(full)
                    st = os.stat(full)
                    size = st.st_size if not is_d else 0
                    mtime = st.st_mtime
                    result[rel] = {
                        "name": name,
                        "is_dir": is_d,
                        "size": size,
                        "mtime": mtime,
                        "path": full
                    }
                except Exception:
                    pass
    else:
        with os.scandir(str(p.resolve())) as it:
            for entry in it:
                try:
                    is_d = entry.is_dir()
                    st = entry.stat()
                    size = st.st_size if not is_d else 0
                    mtime = st.st_mtime
                    result[entry.name] = {
                        "name": entry.name,
                        "is_dir": is_d,
                        "size": size,
                        "mtime": mtime,
                        "path": entry.path
                    }
                except Exception:
                    pass
    return result

async def get_remote_library_metadata(remote_server: str, base_path: str, subpath: str, deep_scan: bool = False) -> dict:
    """Scans remote directory asynchronously over SSH with 15s timeout."""
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
        "                try:\n"
        "                    full = os.path.join(root, name)\n"
        "                    rel = os.path.relpath(full, abs_target)\n"
        "                    is_d = os.path.isdir(full)\n"
        "                    st = os.stat(full)\n"
        "                    size = st.st_size if not is_d else 0\n"
        "                    mtime = st.st_mtime\n"
        "                    result[rel] = {'name': name, 'is_dir': is_d, 'size': size, 'mtime': mtime, 'path': full}\n"
        "                except Exception:\n"
        "                    pass\n"
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
    
    retcode, stdout, stderr = await run_async_subprocess(ssh_cmd, timeout=15.0)
    if retcode != 0:
        raise Exception(f"SSH command failed: {stderr}")
        
    res = json.loads(stdout.strip())
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
        elif not src and bk:
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
def list_libraries(user: dict = Depends(get_current_user)):
    """Returns all configured folder libraries."""
    config = command_builder.load_config()
    return config.get("libraries", {})

@app.get("/api/libraries/browse")
async def browse_library(library_name: str, subpath: str = "", deep_scan: bool = False, nocache: bool = False, user: dict = Depends(get_current_user)):
    """Gathers sync comparison for a library's source and backup folders asynchronously."""
    config = command_builder.load_config()
    libraries = config.get("libraries", {})
    if library_name not in libraries:
        raise HTTPException(status_code=404, detail="Library not configured.")
        
    lib = libraries[library_name]
    src_cfg = lib.get("source")
    bk_cfg = lib.get("backup")
    
    if not src_cfg or not bk_cfg:
        raise HTTPException(status_code=400, detail="Library source and backup settings must be configured.")
        
    # 1. Try to fetch from cache if nocache is False
    if not nocache:
        try:
            cached_data = database.get_cached_library(library_name, subpath, deep_scan)
            if cached_data:
                cached_items = json.loads(cached_data)
                return {
                    "library_name": library_name,
                    "subpath": subpath,
                    "deep_scan": deep_scan,
                    "source_base": src_cfg["path"],
                    "source_server": src_cfg["server"],
                    "backup_base": bk_cfg["path"],
                    "backup_server": bk_cfg["server"],
                    "items": cached_items,
                    "cached": True
                }
        except Exception:
            pass
            
    # 2. Get top-level source metadata
    try:
        if src_cfg["server"] == "local":
            src_top = get_local_library_metadata(src_cfg["path"], subpath, deep_scan=False)
        else:
            src_top = await get_remote_library_metadata(src_cfg["server"], src_cfg["path"], subpath, deep_scan=False)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to scan Source folder: {str(e)}")

    # 3. Get top-level backup metadata
    try:
        if bk_cfg["server"] == "local":
            bk_top = get_local_library_metadata(bk_cfg["path"], subpath, deep_scan=False)
        else:
            bk_top = await get_remote_library_metadata(bk_cfg["server"], bk_cfg["path"], subpath, deep_scan=False)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to scan Backup folder: {str(e)}")

    # 4. Compute differences
    items = get_library_union(src_top, bk_top)
    
    # 5. Cache result
    try:
        database.set_cached_library(library_name, subpath, deep_scan, json.dumps(items))
    except Exception:
        pass
        
    return {
        "library_name": library_name,
        "subpath": subpath,
        "deep_scan": deep_scan,
        "source_base": src_cfg["path"],
        "source_server": src_cfg["server"],
        "backup_base": bk_cfg["path"],
        "backup_server": bk_cfg["server"],
        "items": items,
        "cached": False
    }

class LibrarySyncRequest(BaseModel):
    library_name: str
    relative_path: str
    direction: str

class LibraryDeleteRequest(BaseModel):
    library_name: str
    relative_path: str
    target: str

class MediaInfoRequest(BaseModel):
    library_name: str
    relative_path: str

class MediaConvertRequest(BaseModel):
    library_name: str
    relative_path: str
    profile_name: str

@app.post("/api/libraries/sync")
async def sync_library_item(request: LibrarySyncRequest, user: dict = Depends(require_role(["Admin", "Operator"]))):
    """Queues a file copy task to align source and backup repositories."""
    config = command_builder.load_config()
    libraries = config.get("libraries", {})
    remotes = config.get("remote_servers", {})
    
    if request.library_name not in libraries:
        raise HTTPException(status_code=404, detail="Library not configured.")
        
    lib = libraries[request.library_name]
    src_cfg = lib.get("source")
    bk_cfg = lib.get("backup")
    
    item_rel_path = request.relative_path.replace("\\", "/")
    
    async def build_cmd(from_cfg, to_cfg, rel_path):
        src_base = from_cfg["path"].rstrip("/")
        dst_base = to_cfg["path"].rstrip("/")
        src_full = f"{src_base}/{rel_path}"
        dst_full = f"{dst_base}/{rel_path}"
        
        if not is_path_allowed(src_full, None if from_cfg["server"] == "local" else from_cfg["server"]):
            raise HTTPException(status_code=403, detail="Access denied: Path is outside allowed roots.")
        if not is_path_allowed(dst_full, None if to_cfg["server"] == "local" else to_cfg["server"]):
            raise HTTPException(status_code=403, detail="Access denied: Path is outside allowed roots.")
            
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
            try:
                await run_async_subprocess(mkdir_cmd, timeout=15.0)
            except Exception:
                pass
            
        if from_cfg["server"] == "local" and to_cfg["server"] == "local":
            return f'cp -r "{src_full}" "{dst_parent}/"'
        elif from_cfg["server"] == "local" and to_cfg["server"] != "local":
            rc = remotes[to_cfg["server"]]
            user = rc.get("user")
            host = rc.get("host")
            key_path = rc.get("key_path")
            return f'scp -o StrictHostKeyChecking=no -i "{key_path}" -r "{src_full}" {user}@{host}:"{dst_parent}/"'
        elif from_cfg["server"] != "local" and to_cfg["server"] == "local":
            rc = remotes[from_cfg["server"]]
            user = rc.get("user")
            host = rc.get("host")
            key_path = rc.get("key_path")
            return f'scp -o StrictHostKeyChecking=no -i "{key_path}" -r {user}@{host}:"{src_full}" "{dst_parent}/"'
        else:
            rc_from = remotes[from_cfg["server"]]
            rc_to = remotes[to_cfg["server"]]
            return f'scp -3 -o StrictHostKeyChecking=no -i "{rc_from.get("key_path")}" -i "{rc_to.get("key_path")}" -r {rc_from.get("user")}@{rc_from.get("host")}:"{src_full}" {rc_to.get("user")}@{rc_to.get("host")}:"{dst_parent}/"'

    if request.direction == "source_to_backup":
        cmd = await build_cmd(src_cfg, bk_cfg, item_rel_path)
    elif request.direction == "backup_to_source":
        cmd = await build_cmd(bk_cfg, src_cfg, item_rel_path)
    elif request.direction == "both":
        src_base = src_cfg["path"].rstrip("/")
        dst_base = bk_cfg["path"].rstrip("/")
        src_full = f"{src_base}/{item_rel_path}"
        dst_full = f"{dst_base}/{item_rel_path}"
        
        if not is_path_allowed(src_full, None if src_cfg["server"] == "local" else src_cfg["server"]):
            raise HTTPException(status_code=403, detail="Access denied: Source path is outside allowed roots.")
        if not is_path_allowed(dst_full, None if bk_cfg["server"] == "local" else bk_cfg["server"]):
            raise HTTPException(status_code=403, detail="Access denied: Destination path is outside allowed roots.")
            
        async def ensure_parent_exists(server_name, path):
            parent = "/".join(path.rstrip("/").split("/")[:-1])
            if not parent:
                return
            if server_name == "local":
                os.makedirs(parent, exist_ok=True)
            else:
                if server_name not in remotes:
                    return
                rc = remotes[server_name]
                mkdir_cmd = [
                    "ssh", "-o", "StrictHostKeyChecking=no", "-i", rc["key_path"],
                    f"{rc['user']}@{rc['host']}", f"mkdir -p '{parent}'"
                ]
                try:
                    await run_async_subprocess(mkdir_cmd, timeout=15.0)
                except Exception:
                    pass
                
        await ensure_parent_exists(src_cfg["server"], src_full)
        await ensure_parent_exists(bk_cfg["server"], dst_full)

        src_dir = src_full if src_full.endswith("/") else f"{src_full}/"
        dst_dir = dst_full if dst_full.endswith("/") else f"{dst_full}/"
        
        if src_cfg["server"] == "local" and bk_cfg["server"] == "local":
            cmd1 = f'rsync -avzu "{src_dir}" "{dst_dir}"'
            cmd2 = f'rsync -avzu "{dst_dir}" "{src_dir}"'
            cmd = f'{cmd1} && {cmd2}'
        elif src_cfg["server"] == "local" and bk_cfg["server"] != "local":
            rc = remotes[bk_cfg["server"]]
            ssh_opt = f'-e "ssh -o StrictHostKeyChecking=no -i {rc["key_path"]}"'
            cmd1 = f'rsync -avzu {ssh_opt} "{src_dir}" {rc["user"]}@{rc["host"]}:"{dst_dir}"'
            cmd2 = f'rsync -avzu {ssh_opt} {rc["user"]}@{rc["host"]}:"{dst_dir}" "{src_dir}"'
            cmd = f'{cmd1} && {cmd2}'
        elif src_cfg["server"] != "local" and bk_cfg["server"] == "local":
            rc = remotes[src_cfg["server"]]
            ssh_opt = f'-e "ssh -o StrictHostKeyChecking=no -i {rc["key_path"]}"'
            cmd1 = f'rsync -avzu {ssh_opt} {rc["user"]}@{rc["host"]}:"{src_dir}" "{dst_dir}"'
            cmd2 = f'rsync -avzu {ssh_opt} "{dst_dir}" {rc["user"]}@{rc["host"]}:"{src_dir}"'
            cmd = f'{cmd1} && {cmd2}'
        else:
            raise HTTPException(status_code=400, detail="Bidirectional sync between two remote servers is not supported.")
    else:
        raise HTTPException(status_code=400, detail="Invalid sync direction.")
        
    await executor.start_task(cmd, queue_name="fs")
    return {"message": "Sync copy task queued successfully.", "command": cmd}

@app.post("/api/libraries/delete")
async def delete_library_item(request: LibraryDeleteRequest, user: dict = Depends(require_role(["Admin", "Operator"]))):
    """Queues a deletion task for a library item."""
    config = command_builder.load_config()
    libraries = config.get("libraries", {})
    remotes = config.get("remote_servers", {})
    
    if request.library_name not in libraries:
        raise HTTPException(status_code=404, detail="Library not configured.")
        
    lib = libraries[request.library_name]
    target_cfg = lib.get(request.target)
    if not target_cfg:
        raise HTTPException(status_code=400, detail="Invalid target specified.")
        
    base_path = target_cfg["path"].rstrip("/")
    rel_path = request.relative_path.replace("\\", "/")
    full_path = f"{base_path}/{rel_path}"
    
    if not is_path_allowed(full_path, None if target_cfg["server"] == "local" else target_cfg["server"]):
        raise HTTPException(status_code=403, detail="Access denied: Path is outside allowed roots.")
        
    if target_cfg["server"] == "local":
        cmd = f'rm -rf "{full_path}"'
    else:
        if target_cfg["server"] not in remotes:
            raise HTTPException(status_code=400, detail="Remote server not configured.")
        rc = remotes[target_cfg["server"]]
        cmd = f'ssh -o StrictHostKeyChecking=no -i "{rc.get("key_path")}" {rc.get("user")}@{rc.get("host")} "rm -rf \'{full_path}\'"'
        
    await executor.start_task(cmd, queue_name="fs")
    return {"message": "Deletion task queued successfully.", "command": cmd}

async def run_pipeline_command(task_id: str, command: str) -> bool:
    start_time = datetime.now().isoformat()
    database.update_task_status(task_id, "Running", "")
    database.update_task_start_time(task_id, start_time)
    broadcaster.broadcast_task_update(task_id, "Running", "media", start_time)
    counts = database.get_task_counts()
    broadcaster.broadcast_task_counts(counts["ongoing"], counts["pending"])
    
    try:
        process = await asyncio.create_subprocess_shell(
            command,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE
        )
        
        async def read_stream(stream):
            while True:
                chunk = await stream.read(1024)
                if not chunk:
                    break
                decoded = chunk.decode('utf-8', errors='replace').replace('\r', '\n')
                database.append_task_output(task_id, decoded)
                broadcaster.broadcast_task_output(task_id, decoded)
                await asyncio.sleep(0.01)
                
        await asyncio.gather(
            read_stream(process.stdout),
            read_stream(process.stderr)
        )
        
        await process.wait()
        
        end_time = datetime.now().isoformat()
        if process.returncode == 0:
            database.update_task_status(task_id, "Completed", end_time)
            broadcaster.broadcast_task_update(task_id, "Completed", "media", start_time)
            counts = database.get_task_counts()
            broadcaster.broadcast_task_counts(counts["ongoing"], counts["pending"])
            return True
        else:
            status_msg = f"Failed (Exit Code {process.returncode})"
            database.update_task_status(task_id, status_msg, end_time)
            broadcaster.broadcast_task_update(task_id, status_msg, "media", start_time)
            counts = database.get_task_counts()
            broadcaster.broadcast_task_counts(counts["ongoing"], counts["pending"])
            return False
            
    except Exception as e:
        end_time = datetime.now().isoformat()
        database.append_task_output(task_id, f"\nPipeline error: {str(e)}")
        database.update_task_status(task_id, "Failed (Exception)", end_time)
        broadcaster.broadcast_task_update(task_id, "Failed (Exception)", "media", start_time)
        counts = database.get_task_counts()
        broadcaster.broadcast_task_counts(counts["ongoing"], counts["pending"])
        return False

async def run_conversion_pipeline_task(
    library_name: str,
    relative_path: str,
    profile_name: str,
    t1_id: str,
    t2_id: str,
    t3_id: str
):
    import shutil
    
    config = command_builder.load_config()
    libraries = config.get("libraries", {})
    remotes = config.get("remote_servers", {})
    profiles = config.get("ffmpeg", {}).get("profiles", {})
    
    lib = libraries[library_name]
    src_cfg = lib.get("source")
    server = src_cfg["server"]
    base_path = src_cfg["path"].rstrip("/")
    rel_path = relative_path.replace("\\", "/")
    
    src_full = f"{base_path}/{rel_path}"
    filename = rel_path.split("/")[-1]
    name_base, ext = os.path.splitext(filename)
    
    profile = profiles.get(profile_name, {})
    out_ext = ext
    allowed_exts = profile.get("allowed_extensions", [])
    if allowed_exts:
        if ext.lower() not in allowed_exts:
            out_ext = allowed_exts[0]
            
    suffix = f"_{profile_name.replace(' ', '_')}"
    candidate = f"{name_base}{suffix}{out_ext}"
    
    async def async_file_exists(path):
        if server == "local":
            return os.path.exists(path)
        else:
            rc = remotes[server]
            cmd = [
                "ssh", "-o", "StrictHostKeyChecking=no", "-i", rc["key_path"],
                f"{rc['user']}@{rc['host']}", f"test -e {shlex.quote(path)}"
            ]
            try:
                code, _, _ = await run_async_subprocess(cmd, timeout=15.0)
                return code == 0
            except Exception:
                return False
            
    parent_rel_path = "/".join(rel_path.split("/")[:-1])
    parent_full_path = f"{base_path}/{parent_rel_path}" if parent_rel_path else base_path
    
    counter = 1
    dest_filename = candidate
    while await async_file_exists(f"{parent_full_path}/{dest_filename}"):
        dest_filename = f"{name_base}{suffix}_{counter}{out_ext}"
        counter += 1
        await asyncio.sleep(0.05)
        
    dest_full_path = f"{parent_full_path}/{dest_filename}"
    
    conversion_temp = str(DEFAULT_CONVERSION_TEMP)
    
    temp_src_id = str(uuid.uuid4())
    temp_src_file = ""
    temp_dst_file = os.path.join(conversion_temp, f"{temp_src_id}_{dest_filename}")
    
    try:
        # --- STAGE 1: COPY TO CONVERSION MACHINE ---
        if server == "local":
            database.update_task_status(t1_id, "Running")
            database.update_task_start_time(t1_id, datetime.now().isoformat())
            database.append_task_output(t1_id, "Source file is already local. Skipping copy stage.")
            database.update_task_status(t1_id, "Completed", datetime.now().isoformat())
            broadcaster.broadcast_task_update(t1_id, "Completed", "media")
            
            local_src_file = src_full
        else:
            temp_src_file = os.path.join(conversion_temp, f"{temp_src_id}_{filename}")
            local_src_file = temp_src_file
            
            rc = remotes[server]
            copy_cmd = f'scp -o StrictHostKeyChecking=no -i "{rc.get("key_path")}" -r {rc.get("user")}@{rc.get("host")}:"{src_full}" "{temp_src_file}"'
            
            success = await run_pipeline_command(t1_id, copy_cmd)
            if not success:
                end_time = datetime.now().isoformat()
                database.update_task_status(t2_id, "Failed (Dependency Failed)", end_time)
                database.update_task_status(t3_id, "Failed (Dependency Failed)", end_time)
                broadcaster.broadcast_task_update(t2_id, "Failed (Dependency Failed)", "media")
                broadcaster.broadcast_task_update(t3_id, "Failed (Dependency Failed)", "media")
                return
                
        # --- STAGE 2: CONVERT ---
        flags = profile.get("flags", "")
        convert_cmd = f'ffmpeg -y -i "{local_src_file}" {flags} "{temp_dst_file}"'
        
        success = await run_pipeline_command(t2_id, convert_cmd)
        if not success:
            end_time = datetime.now().isoformat()
            database.update_task_status(t3_id, "Failed (Dependency Failed)", end_time)
            broadcaster.broadcast_task_update(t3_id, "Failed (Dependency Failed)", "media")
            return
            
        # --- STAGE 3: BRING BACK CONVERTED FILE ---
        database.update_task_status(t3_id, "Running")
        database.update_task_start_time(t3_id, datetime.now().isoformat())
        broadcaster.broadcast_task_update(t3_id, "Running", "media")
        
        if server == "local":
            try:
                database.append_task_output(t3_id, f"Moving local converted file to target: {dest_full_path}")
                shutil.move(temp_dst_file, dest_full_path)
                database.update_task_status(t3_id, "Completed", datetime.now().isoformat())
                broadcaster.broadcast_task_update(t3_id, "Completed", "media")
            except Exception as e:
                database.append_task_output(t3_id, f"\nError moving file: {str(e)}")
                database.update_task_status(t3_id, "Failed (Move Error)", datetime.now().isoformat())
                broadcaster.broadcast_task_update(t3_id, "Failed (Move Error)", "media")
        else:
            rc = remotes[server]
            bring_back_cmd = f'scp -o StrictHostKeyChecking=no -i "{rc.get("key_path")}" "{temp_dst_file}" {rc.get("user")}@{rc.get("host")}:"{dest_full_path}"'
            
            success = await run_pipeline_command(t3_id, bring_back_cmd)
            
    finally:
        if temp_src_file and os.path.exists(temp_src_file):
            try:
                os.remove(temp_src_file)
            except Exception:
                pass
        if temp_dst_file and os.path.exists(temp_dst_file):
            try:
                os.remove(temp_dst_file)
            except Exception:
                pass

@app.post("/api/libraries/media-info")
async def get_media_info(request: MediaInfoRequest, user: dict = Depends(get_current_user)):
    """Retrieves ffprobe stream details for a media file."""
    config = command_builder.load_config()
    libraries = config.get("libraries", {})
    remotes = config.get("remote_servers", {})
    
    if request.library_name not in libraries:
        raise HTTPException(status_code=404, detail="Library not configured.")
        
    lib = libraries[request.library_name]
    src_cfg = lib.get("source")
    bk_cfg = lib.get("backup")
    
    async def remote_file_exists(server_name, path):
        if server_name == "local":
            return os.path.exists(path)
        else:
            if server_name not in remotes:
                return False
            rc = remotes[server_name]
            cmd = [
                "ssh", "-o", "StrictHostKeyChecking=no", "-i", rc["key_path"],
                f"{rc['user']}@{rc['host']}", f"test -e {shlex.quote(path)}"
            ]
            try:
                retcode, _, _ = await run_async_subprocess(cmd, timeout=15.0)
                return retcode == 0
            except Exception:
                return False
            
    rel_path = request.relative_path.replace("\\", "/")
    src_path = f"{src_cfg['path'].rstrip('/')}/{rel_path}"
    
    if await remote_file_exists(src_cfg["server"], src_path):
        target_cfg = src_cfg
        full_path = src_path
    elif await remote_file_exists(bk_cfg["server"], f"{bk_cfg['path'].rstrip('/')}/{rel_path}"):
        target_cfg = bk_cfg
        full_path = f"{bk_cfg['path'].rstrip('/')}/{rel_path}"
    else:
        raise HTTPException(status_code=404, detail="File does not exist in either repository.")
        
    server = target_cfg["server"]
    
    if not is_path_allowed(full_path, None if server == "local" else server):
        raise HTTPException(status_code=403, detail="Access denied: Path is outside allowed roots.")
        
    escaped_path = shlex.quote(full_path)
    
    if server == "local":
        cmd = [
            "ffprobe", "-v", "quiet", "-print_format", "json",
            "-show_format", "-show_streams", full_path
        ]
        retcode, stdout, stderr = await run_async_subprocess(cmd, timeout=15.0)
    else:
        if server not in remotes:
            raise HTTPException(status_code=400, detail="Remote server not configured.")
        rc = remotes[server]
        ffprobe_cmd = f"/usr/local/bin/ffprobe -v quiet -print_format json -show_format -show_streams {escaped_path}"
        cmd = [
            "ssh", "-o", "StrictHostKeyChecking=no", "-i", rc.get("key_path"),
            f"{rc.get('user')}@{rc.get('host')}", ffprobe_cmd
        ]
        retcode, stdout, stderr = await run_async_subprocess(cmd, timeout=15.0)
        
    if retcode != 0:
        raise HTTPException(
            status_code=500,
            detail=f"Failed to fetch media info. Return code: {retcode}. Stderr: {stderr.strip()}."
        )
        
    try:
        data = json.loads(stdout)
    except Exception:
        raise HTTPException(status_code=500, detail="Failed to parse ffprobe output.")
        
    streams = data.get("streams", [])
    format_data = data.get("format", {})
    
    duration_sec = float(format_data.get("duration", 0))
    hours = int(duration_sec // 3600)
    minutes = int((duration_sec % 3600) // 60)
    seconds = int(duration_sec % 60)
    formatted_duration = f"{hours:02d}:{minutes:02d}:{seconds:02d}" if hours > 0 else f"{minutes:02d}:{seconds:02d}"
    
    size_bytes = int(format_data.get("size", 0))
    formatted_size = f"{size_bytes / (1024 * 1024):.2f} MB" if size_bytes < 1024**3 else f"{size_bytes / (1024**3):.2f} GB"
    
    bitrate = int(format_data.get("bit_rate", 0))
    formatted_bitrate = f"{bitrate // 1000} kbps" if bitrate > 0 else "unknown"
    
    details = {
        "filename": rel_path.split("/")[-1],
        "format": format_data.get("format_long_name", format_data.get("format_name", "unknown")),
        "duration": formatted_duration,
        "size": formatted_size,
        "bitrate": formatted_bitrate,
        "video": [],
        "audio": [],
        "subtitle": []
    }
    
    for s in streams:
        codec_type = s.get("codec_type")
        codec_name = s.get("codec_name", "unknown")
        
        if codec_type == "video":
            width = s.get("width", "unknown")
            height = s.get("height", "unknown")
            fps_eval = s.get("avg_frame_rate", "0/0")
            fps = "unknown"
            if "/" in fps_eval:
                try:
                    num, den = map(int, fps_eval.split("/"))
                    if den > 0:
                        fps = round(num / den, 2)
                except Exception:
                    pass
            details["video"].append({
                "codec": codec_name.upper(),
                "resolution": f"{width}x{height}",
                "fps": fps
            })
        elif codec_type == "audio":
            channels = s.get("channels", "unknown")
            lang = s.get("tags", {}).get("language", "unknown")
            details["audio"].append({
                "codec": codec_name.upper(),
                "channels": channels,
                "language": lang
            })
        elif codec_type == "subtitle":
            lang = s.get("tags", {}).get("language", "unknown")
            details["subtitle"].append({
                "codec": codec_name,
                "language": lang
            })
            
    return details

@app.post("/api/libraries/media-convert")
async def start_media_conversion(request: MediaConvertRequest, background_tasks: BackgroundTasks, user: dict = Depends(require_role(["Admin", "Operator"]))):
    config = command_builder.load_config()
    libraries = config.get("libraries", {})
    profiles = config.get("ffmpeg", {}).get("profiles", {})
    
    if request.library_name not in libraries:
        raise HTTPException(status_code=404, detail="Library not configured.")
    if request.profile_name not in profiles:
        raise HTTPException(status_code=404, detail="Profile not configured.")
        
    filename = request.relative_path.split("/")[-1]
    
    t1_id = str(uuid.uuid4())
    t2_id = str(uuid.uuid4())
    t3_id = str(uuid.uuid4())
    
    now_time = datetime.now().isoformat()
    
    t1_name = f"[Stage 1/3] Copy to Conversion Machine: {filename}"
    database.insert_task(t1_id, t1_name, "Pending", now_time, "pipeline")
    
    t2_name = f"[Stage 2/3] Convert ({request.profile_name}): {filename}"
    database.insert_task(t2_id, t2_name, "Pending", now_time, "pipeline")
    
    t3_name = f"[Stage 3/3] Bring back Converted File: {filename}"
    database.insert_task(t3_id, t3_name, "Pending", now_time, "pipeline")
    
    background_tasks.add_task(
        run_conversion_pipeline_task,
        request.library_name,
        request.relative_path,
        request.profile_name,
        t1_id,
        t2_id,
        t3_id
    )
    
    return {
        "message": "Media conversion pipeline started.",
        "tasks": [t1_id, t2_id, t3_id]
    }

# Static files mount - must be after all /api routes
app.mount("/", StaticFiles(directory=str(BASE_DIR / "static"), html=True), name="static")
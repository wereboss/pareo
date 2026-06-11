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

@asynccontextmanager
async def lifespan(app: FastAPI):
    # 1. Boot up the SQLite database
    database.init_db()
    
    # 2. Recover State (Mark orphaned tasks as failed, requeue pending)
    recovered_count = executor.recover_tasks()
    print(f"[*] Pareo Engine Boot: Recovered {recovered_count} pending tasks.")
    
    # 3. Boot up the background queue worker
    worker_task = asyncio.create_task(executor.worker_loop())
    yield
    # Cancel the worker when the server stops
    worker_task.cancel()

app = FastAPI(title="Pareo API", lifespan=lifespan)

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
        await executor.start_task(command)
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
            await executor.start_task(command)
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

@app.get("/api/fs/list")
def list_directory(target_path: str = "/"):
    """Returns a JSON array of files and folders for the Explorer Modal."""
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
        return {"target_path": str(p.absolute()), "items": items}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

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
        
    # Validation 2: Require Remote Server
    if action_data.get("requires_remote"):
        if not request.remote_server or request.remote_server not in remotes_config:
            raise HTTPException(status_code=400, detail="A valid Remote Server must be selected for this action.")
        remote_creds = remotes_config[request.remote_server]
        
    queued_count = 0
    for src in request.source_paths:
        cmd = command_builder.build_fs_command(
            request.action, 
            src, 
            request.destination_path, 
            remote_creds
        )
        await executor.start_task(cmd)
        queued_count += 1
        
    return {"message": f"Successfully queued {queued_count} file operations.", "queued_count": queued_count}


@app.get("/api/tasks")
def get_tasks():
    """Retrieves all historical tasks from SQLite."""
    return database.get_all_tasks()

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

if os.path.exists("static"):
    app.mount("/", StaticFiles(directory="static", html=True), name="static")
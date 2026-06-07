import os
import glob
from pathlib import Path
import asyncio
from contextlib import asynccontextmanager
from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
import executor
import command_builder

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Boot up the queue worker when the server starts
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

@app.get("/api/tasks")
def get_tasks():
    return executor.tasks_db

@app.get("/api/tasks/{task_id}")
def get_single_task(task_id: str):
    if task_id in executor.tasks_db:
        return executor.tasks_db[task_id]
    return {"error": "Task not found"}

if os.path.exists("static"):
    app.mount("/", StaticFiles(directory="static", html=True), name="static")
import os
import asyncio
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
import executor
import command_builder

# Manage the background worker lifecycle
@asynccontextmanager
async def lifespan(app: FastAPI):
    # Boot up the queue worker when the server starts
    worker_task = asyncio.create_task(executor.worker_loop())
    yield
    # Cancel the worker when the server stops
    worker_task.cancel()

app = FastAPI(title="Pareo API", lifespan=lifespan)

# 1. Update the Pydantic model to include an optional profile
class FfmpegRequest(BaseModel):
    input_path: str
    output_path: str
    profile: str = "Default"

@app.post("/api/execute/ls")
async def execute_ls():
    """Queues the 'ls -ltr' command."""
    # Notice we await start_task now
    task_id = await executor.start_task("ls -ltr")
    return {"task_id": task_id, "message": "Command queued."}

# 2. Add this NEW endpoint right before the @app.post("/api/execute/ls") route
@app.get("/api/config/ffmpeg")
def get_ffmpeg_config():
    """Serves the available FFMPEG profiles from config.json to the frontend."""
    import command_builder
    config = command_builder.load_config()
    profiles = config.get("ffmpeg", {}).get("profiles", {})
    # Return just the profile names (keys) for the dropdown
    return {"profiles": list(profiles.keys())}

# 3. Update the execute_ffmpeg route to pass the profile to the builder
@app.post("/api/execute/ffmpeg")
async def execute_ffmpeg(request: FfmpegRequest):
    """Queues an FFMPEG conversion command with a specific profile."""
    command = command_builder.build_ffmpeg_command(
        request.input_path, 
        request.output_path, 
        request.profile
    )
    task_id = await executor.start_task(command)
    return {"task_id": task_id, "message": "FFMPEG command queued."}

@app.get("/api/tasks")
def get_tasks():
    return executor.tasks_db

@app.get("/api/tasks/{task_id}")
def get_single_task(task_id: str):
    """Retrieves the real-time state of a single specific task."""
    if task_id in executor.tasks_db:
        return executor.tasks_db[task_id]
    return {"error": "Task not found"}

if os.path.exists("static"):
    app.mount("/", StaticFiles(directory="static", html=True), name="static")





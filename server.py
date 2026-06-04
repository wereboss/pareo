import os
from fastapi import FastAPI, BackgroundTasks
from fastapi.staticfiles import StaticFiles
import executor

app = FastAPI(title="Pareo API")

@app.post("/api/execute/ls")
async def execute_ls(background_tasks: BackgroundTasks):
    """
    Triggers the 'ls -ltr' command.
    Returns immediately while the command runs in the background.
    """
    command = "ls -ltr"
    
    # 1. Register the task in the database and get an ID
    task_id = executor.start_task(command)
    
    # 2. Hand the execution off to FastAPI's background thread
    background_tasks.add_task(executor.execute_command, task_id, command)
    
    # 3. Return the ID immediately so the frontend can start polling
    return {"task_id": task_id, "message": f"Command '{command}' scheduled."}

from pydantic import BaseModel
import command_builder

# Define the expected JSON payload for FFMPEG
class FfmpegRequest(BaseModel):
    input_path: str
    output_path: str

@app.post("/api/execute/ffmpeg")
async def execute_ffmpeg(request: FfmpegRequest, background_tasks: BackgroundTasks):
    """
    Triggers an FFMPEG conversion command based on user inputs.
    """
    # 1. Build the dynamic command
    command = command_builder.build_ffmpeg_command(request.input_path, request.output_path)
    
    # 2. Register the task
    task_id = executor.start_task(command)
    
    # 3. Hand off to background execution
    background_tasks.add_task(executor.execute_command, task_id, command)
    
    return {"task_id": task_id, "message": "FFMPEG command scheduled."}

@app.get("/api/tasks")
def get_tasks():
    """
    Retrieves the current state of all tasks in the in-memory database.
    """
    return executor.tasks_db

# Note: We will uncomment the line below once we build the frontend in the next step.
# It tells FastAPI to serve our HTML/JS/CSS files from the /static directory.

if os.path.exists("static"):
    app.mount("/", StaticFiles(directory="static", html=True), name="static")
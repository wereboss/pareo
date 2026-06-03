import asyncio
import uuid
from datetime import datetime

# In-memory store for task states (MVP)
tasks_db = {}

async def execute_command(task_id: str, command: str):
    """Runs the command asynchronously and updates the tasks_db."""
    tasks_db[task_id]["status"] = "Running"
    
    try:
        # Execute the shell command non-blocking
        process = await asyncio.create_subprocess_shell(
            command,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE
        )
        
        # Wait for completion and capture output streams
        stdout, stderr = await process.communicate()
        
        # Update state based on execution results
        tasks_db[task_id]["status"] = "Completed" if process.returncode == 0 else "Failed"
        tasks_db[task_id]["output"] = stdout.decode('utf-8').strip() if stdout else ""
        tasks_db[task_id]["error"] = stderr.decode('utf-8').strip() if stderr else ""
        tasks_db[task_id]["return_code"] = process.returncode

    except Exception as e:
        tasks_db[task_id]["status"] = "Failed"
        tasks_db[task_id]["error"] = str(e)
        tasks_db[task_id]["return_code"] = -1
    finally:
        tasks_db[task_id]["end_time"] = datetime.now().isoformat()

def start_task(command: str) -> str:
    """Initializes a new task in the database and returns its ID."""
    task_id = str(uuid.uuid4())
    
    tasks_db[task_id] = {
        "task_id": task_id,
        "command": command,
        "status": "Pending",
        "start_time": datetime.now().isoformat(),
        "end_time": None,
        "output": "",
        "error": "",
        "return_code": None
    }
    
    return task_id
import asyncio
import uuid
from datetime import datetime

# In-memory store for task states
tasks_db = {}

async def _read_stream(stream, task_id):
    """Reads an asyncio stream line by line and appends to the task output."""
    while True:
        line = await stream.readline()
        if not line:
            break
        decoded_line = line.decode('utf-8', errors='replace').strip()
        if decoded_line:
            # We unify all output into a single text block for easier UI rendering
            tasks_db[task_id]["output"] += decoded_line + "\n"

async def execute_command(task_id: str, command: str):
    """Runs the command asynchronously and streams output to tasks_db."""
    tasks_db[task_id]["status"] = "Running"
    
    try:
        process = await asyncio.create_subprocess_shell(
            command,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE
        )
        
        # Read stdout and stderr concurrently as the process runs
        await asyncio.gather(
            _read_stream(process.stdout, task_id),
            _read_stream(process.stderr, task_id)
        )
        
        # Wait for the process to formally exit
        await process.wait()
        
        tasks_db[task_id]["status"] = "Completed" if process.returncode == 0 else "Failed"
        tasks_db[task_id]["return_code"] = process.returncode

    except Exception as e:
        tasks_db[task_id]["status"] = "Failed"
        tasks_db[task_id]["output"] += f"\nSystem Error: {str(e)}"
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
        "output": "", # We removed 'error' as a separate field; everything streams here now
        "return_code": None
    }
    
    return task_id
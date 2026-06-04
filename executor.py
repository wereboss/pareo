import asyncio
import uuid
from datetime import datetime

tasks_db = {}
# Initialize the asynchronous queue
task_queue = asyncio.Queue()

async def _read_stream(stream, task_id):
    """Reads stream in chunks to instantly capture FFMPEG's carriage returns (\r)."""
    while True:
        # Read up to 1KB of raw data at a time instead of waiting for a full line
        chunk = await stream.read(1024)
        if not chunk:
            break
        
        decoded_chunk = chunk.decode('utf-8', errors='replace')
        # Translate carriage returns into standard newlines for the web UI
        decoded_chunk = decoded_chunk.replace('\r', '\n')
        
        if decoded_chunk:
            tasks_db[task_id]["output"] += decoded_chunk

async def execute_command(task_id: str, command: str):
    """Runs the command asynchronously and streams output to tasks_db."""
    tasks_db[task_id]["status"] = "Running"
    
    try:
        process = await asyncio.create_subprocess_shell(
            command,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE
        )
        
        await asyncio.gather(
            _read_stream(process.stdout, task_id),
            _read_stream(process.stderr, task_id)
        )
        
        await process.wait()
        
        tasks_db[task_id]["status"] = "Completed" if process.returncode == 0 else "Failed"
        tasks_db[task_id]["return_code"] = process.returncode

    except Exception as e:
        tasks_db[task_id]["status"] = "Failed"
        tasks_db[task_id]["output"] += f"\nSystem Error: {str(e)}"
        tasks_db[task_id]["return_code"] = -1
    finally:
        tasks_db[task_id]["end_time"] = datetime.now().isoformat()

async def worker_loop():
    """Background worker that continuously pulls and processes tasks sequentially."""
    while True:
        # Wait until a task is available in the queue
        task_id, command = await task_queue.get()
        try:
            await execute_command(task_id, command)
        finally:
            # Tell the queue that the task is entirely finished
            task_queue.task_done()

async def start_task(command: str) -> str:
    """Initializes a new task in the database and queues it for execution."""
    task_id = str(uuid.uuid4())
    
    tasks_db[task_id] = {
        "task_id": task_id,
        "command": command,
        "status": "Pending",
        "start_time": datetime.now().isoformat(),
        "end_time": None,
        "output": "",
        "return_code": None
    }
    
    # Push the task to the queue instead of running it immediately
    await task_queue.put((task_id, command))
    return task_id
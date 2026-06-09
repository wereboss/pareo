import asyncio
import uuid
from datetime import datetime
import database

# The queue now holds a tuple: (task_id, command)
task_queue = asyncio.Queue()

async def start_task(command: str) -> str:
    """Generates an ID, saves to SQLite, and pushes to the worker queue."""
    task_id = str(uuid.uuid4())
    start_time = datetime.now().isoformat()
    
    database.insert_task(task_id, command, "Pending", start_time)
    await task_queue.put((task_id, command))
    return task_id

def recover_tasks():
    """Runs on server boot to handle orphaned tasks and requeue pending ones."""
    # 1. Protect files by marking interrupted 'Running' tasks as Failed
    database.mark_running_as_failed()
    
    # 2. Push any 'Pending' tasks back into the asyncio queue
    pending = database.get_pending_tasks()
    for pt in pending:
        task_queue.put_nowait((pt["task_id"], pt["command"]))
    
    return len(pending)

async def _read_stream(stream, task_id):
    """Reads stream in chunks and writes directly to SQLite."""
    while True:
        chunk = await stream.read(1024)
        if not chunk:
            break
        
        decoded_chunk = chunk.decode('utf-8', errors='replace').replace('\r', '\n')
        if decoded_chunk:
            database.append_task_output(task_id, decoded_chunk)

async def run_command(task_id: str, command: str):
    database.update_task_status(task_id, "Running")
    
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
        
        return_code = await process.wait()
        end_time = datetime.now().isoformat()
        
        if return_code == 0:
            database.update_task_status(task_id, "Completed", end_time)
        else:
            database.update_task_status(task_id, f"Failed (Code: {return_code})", end_time)
            
    except Exception as e:
        end_time = datetime.now().isoformat()
        database.append_task_output(task_id, f"\nExecution Error: {str(e)}")
        database.update_task_status(task_id, "Failed (Exception)", end_time)

async def retry_task(task_id: str):
    """Validates and pushes a failed task back into the worker queue."""
    task = database.get_task(task_id)
    if not task:
        raise ValueError("Task not found.")
        
    # Safety check: Prevent re-queuing a task that is already running or completed
    if 'Failed' not in task['status']:
        raise ValueError("Only failed or interrupted tasks can be retried.")
        
    new_start_time = datetime.now().isoformat()
    database.reset_task_for_retry(task_id, new_start_time)
    
    await task_queue.put((task_id, task['command']))
    return True

async def worker_loop():
    """Background loop that processes one database task at a time."""
    while True:
        task_id, command = await task_queue.get()
        await run_command(task_id, command)
        task_queue.task_done()
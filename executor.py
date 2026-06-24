import asyncio
import uuid
from datetime import datetime
import database
import subprocess

# 1. Add a global list at the top of executor.py to hold references
active_workers = []
running_processes = {}  # Tracks task_id -> asyncio subprocess object mapping

# UPDATED: Added a dedicated 'fs' queue
task_queues = {
    "media": asyncio.Queue(),
    "network": asyncio.Queue(),
    "fs": asyncio.Queue(),       
    "default": asyncio.Queue()
}

# 3. Add a print statement to start_task to prove it entered the queue
async def start_task(command: str, queue_name: str = "default") -> str:
    task_id = str(uuid.uuid4())
    start_time = datetime.now().isoformat()
    
    database.insert_task(task_id, command, "Pending", start_time, queue_name)
    
    target_queue = task_queues.get(queue_name, task_queues["default"])
    await target_queue.put((task_id, command))
    
    print(f"[*] Pushed task {task_id[:8]} into queue: {queue_name.upper()}") # NEW
    return task_id

def resolve_queue_from_command(command: str) -> str:
    """Fallback router to detect queue type for legacy tasks lacking queue_name."""
    cmd_lower = command.lower()
    if cmd_lower.startswith("ffmpeg"):
        return "media"
    elif cmd_lower.startswith("aria2c"):
        return "network"
    elif any(cmd_lower.startswith(prefix) for prefix in ["cp ", "mv ", "rm ", "tar ", "scp "]):
        return "fs"
    return "default"

def recover_tasks():
    """Runs on server boot to handle orphaned tasks and requeue pending ones in their correct queues."""
    import os
    from datetime import datetime
    
    # 1. Fetch running tasks and verify if they are still alive
    with database.get_conn() as conn:
        cur = conn.execute("SELECT * FROM tasks WHERE status = 'Running'")
        running_tasks = [dict(row) for row in cur.fetchall()]
        
    for rt in running_tasks:
        task_id = rt["task_id"]
        pid = rt.get("pid")
        still_running = False
        if pid:
            try:
                # Signal 0 checks process existence without killing it
                os.kill(pid, 0)
                still_running = True
            except (ProcessLookupError, PermissionError):
                pass
        
        if still_running:
            print(f"[*] Task {task_id[:8]} (PID {pid}) is still running in the background. Letting it finish.")
        else:
            print(f"[*] Task {task_id[:8]} (PID {pid}) is no longer active. Marking as Failed (Interrupted).")
            end_time = datetime.now().isoformat()
            database.update_task_status(task_id, "Failed (Interrupted)", end_time)
            database.append_task_output(task_id, "\n[Task interrupted due to server reboot]")
            
    # 2. Recover pending tasks
    pending = database.get_pending_tasks()
    for pt in pending:
        q_name = pt.get("queue_name")
        if not q_name:
            q_name = resolve_queue_from_command(pt["command"])
            
        target_queue = task_queues.get(q_name, task_queues["default"])
        target_queue.put_nowait((pt["task_id"], pt["command"]))
        print(f"[*] Recovered pending task {pt['task_id'][:8]} into queue: {q_name.upper()}")
    
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
            # CRITICAL FIX: Yield control back to the asyncio event loop
            # This prevents heavy progress-bar spam from blocking other parallel tasks
            await asyncio.sleep(0.05)

async def fire_immediate_command(command: str, detached: bool = False) -> dict:
    """Executes a command immediately. If detached, spawns an independent OS process."""
    if detached:
        try:
            process = subprocess.Popen(
                command,
                shell=True,
                start_new_session=True,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL
            )
            output_msg = (
                f"Detached process successfully spawned.\n"
                f"PID: {process.pid}\n"
                f"Command: {command}"
            )
            return {"success": True, "output": output_msg}
        except Exception as e:
            return {"success": False, "output": f"Failed to spawn detached process: {str(e)}"}

    try:
        process = await asyncio.create_subprocess_shell(
            command,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE
        )
        
        try:
            stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=30.0)
        except asyncio.TimeoutError:
            process.kill()
            return {"success": False, "output": "Execution timed out after 30 seconds."}

        return_code = process.returncode
        output = stdout.decode('utf-8').strip()
        error = stderr.decode('utf-8').strip()
        
        if return_code == 0:
            return {"success": True, "output": output if output else "Executed successfully."}
        else:
            return {"success": False, "output": error if error else f"Failed with code {return_code}."}
            
    except Exception as e:
        return {"success": False, "output": str(e)}

async def run_command(task_id: str, command: str):
    # Check if task was cancelled while pending in queue
    task = database.get_task(task_id)
    if not task or task["status"] == "Cancelled":
        print(f"[*] Skipping task {task_id[:8]} as it was Cancelled while pending.")
        return

    # Capture exact time the worker picked it up
    actual_start_time = datetime.now().isoformat()
    database.update_task_start_time(task_id, actual_start_time)
    
    try:
        # Spawn the detached task_runner.py process
        # We run it with start_new_session=True so it forms a new process group.
        # This keeps the task execution completely isolated from Pareo.
        cmd_args = [
            "python3", "task_runner.py",
            "--task-id", task_id,
            "--command", command
        ]
        
        process = await asyncio.create_subprocess_exec(
            *cmd_args,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            start_new_session=True
        )
        
        running_processes[task_id] = process
        
        # Read the stdout and stderr streams of the task_runner itself to print in server console/logs
        # task_runner.py writes the task output directly to database/log files.
        async def _log_runner_output(stream):
            while True:
                line = await stream.readline()
                if not line:
                    break
                decoded = line.decode('utf-8', errors='replace').strip()
                if decoded:
                    print(f"[Runner {task_id[:8]}] {decoded}")

        await asyncio.gather(
            _log_runner_output(process.stdout),
            _log_runner_output(process.stderr)
        )
        
        await process.wait()
            
    except Exception as e:
        end_time = datetime.now().isoformat()
        database.append_task_output(task_id, f"\nFailed to spawn task runner: {str(e)}")
        database.update_task_status(task_id, "Failed (Launcher Exception)", end_time)
    finally:
        running_processes.pop(task_id, None)

async def cancel_task(task_id: str) -> bool:
    """Cancels a task. If running, terminates the detached subprocess group. If pending, updates status to Cancelled."""
    task = database.get_task(task_id)
    if not task:
        raise ValueError("Task not found.")
        
    if task["status"] == "Running":
        pid = task.get("pid")
        if pid:
            try:
                import os
                import signal
                # Terminate the entire process group of the task_runner
                os.killpg(pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            except Exception as e:
                print(f"[!] Error terminating process group {pid} for task {task_id}: {str(e)}")
        
        # In case the runner did not update the DB yet (or was SIGKILLed)
        end_time = datetime.now().isoformat()
        database.update_task_status(task_id, "Cancelled", end_time)
        database.append_task_output(task_id, "\n[Task Cancelled by User]")
        return True
        
    elif task["status"] == "Pending":
        end_time = datetime.now().isoformat()
        database.update_task_status(task_id, "Cancelled", end_time)
        database.append_task_output(task_id, "\n[Task Cancelled by User while Pending]")
        return True
        
    raise ValueError("Only Pending or Running tasks can be cancelled.")

async def retry_task(task_id: str):
    """Validates and pushes a failed task back into the worker queue."""
    task = database.get_task(task_id)
    if not task:
        raise ValueError("Task not found.")
        
    # Allow retrying Failed, Cancelled, or Interrupted tasks
    if task['status'] in ['Completed', 'Pending', 'Running']:
        raise ValueError("Only failed, cancelled, or interrupted tasks can be retried.")
        
    new_start_time = datetime.now().isoformat()
    database.reset_task_for_retry(task_id, new_start_time)
    
    # Push retries to the correct queue
    q_name = task.get("queue_name")
    if not q_name:
        q_name = resolve_queue_from_command(task['command'])
        
    target_queue = task_queues.get(q_name, task_queues["default"])
    await target_queue.put((task_id, task['command']))
    return True

async def worker(queue_name: str, queue: asyncio.Queue):
    """A dedicated worker listening only to its specific queue."""
    print(f"[*] Started background worker for queue: {queue_name.upper()}")
    while True:
        task_id, command = await queue.get()
        print(f"[{queue_name.upper()} WORKER] Picked up task {task_id[:8]}")
        
        try:
            # Check if there is another task in this queue that is already 'Running'
            # (e.g. a task that survived reboot and is still running in the background)
            while True:
                running_tasks = []
                with database.get_conn() as conn:
                    cur = conn.execute(
                        "SELECT task_id, pid FROM tasks WHERE queue_name = ? AND status = 'Running' AND task_id != ?",
                        (queue_name, task_id)
                    )
                    running_tasks = [dict(row) for row in cur.fetchall()]
                
                still_active = False
                for rt in running_tasks:
                    pid = rt.get("pid")
                    if pid:
                        try:
                            import os
                            os.kill(pid, 0)
                            still_active = True
                            break
                        except (ProcessLookupError, PermissionError):
                            pass
                
                if not still_active:
                    break
                
                # If there's an active running task, wait 2 seconds before checking again
                await asyncio.sleep(2.0)

            # Execute the command
            await run_command(task_id, command)
            
        except Exception as e:
            # If a database lock or bizarre OS error bypasses run_command's internal safety net,
            # this catches it so the worker thread does NOT die.
            print(f"[{queue_name.upper()} WORKER FATAL ERROR] Task {task_id[:8]} caused a thread crash: {str(e)}")
            
            # Attempt a last-resort fallback to mark it as failed so it doesn't get stuck Running
            try:
                from datetime import datetime
                database.update_task_status(task_id, "Failed (Worker Exception)", datetime.now().isoformat())
            except Exception:
                pass 
                
        finally:
            # CRITICAL: Always mark the queue item as done, even if it exploded.
            # This ensures the queue never jams.
            queue.task_done()

# 2. Update start_workers to save the references
def start_workers():
    """Spawns an independent worker thread for each queue type and keeps them alive."""
    for q_name, q in task_queues.items():
        task = asyncio.create_task(worker(q_name, q))
        active_workers.append(task) # <--- This prevents Python from killing the thread
#!/usr/bin/env python3
import asyncio
import sys
import os
import argparse
from datetime import datetime
import signal
import database

# Global refs for signal handling
child_process = None
task_id = None
is_cancelled = False

def sigterm_handler(signum, frame):
    global is_cancelled
    is_cancelled = True
    sys.stdout.write(f"[*] Received SIGTERM/SIGINT signal for task {task_id}. Terminating subprocess...\n")
    sys.stdout.flush()
    if child_process:
        try:
            # Send SIGTERM to the process group of the child subprocess
            os.killpg(os.getpgid(child_process.pid), signal.SIGTERM)
        except ProcessLookupError:
            pass
        except Exception as e:
            sys.stderr.write(f"[!] Error killing process group: {e}\n")
            sys.stderr.flush()
            try:
                child_process.terminate()
            except Exception:
                pass

async def read_stream(stream, task_id, log_file):
    while True:
        chunk = await stream.read(1024)
        if not chunk:
            break
        decoded_chunk = chunk.decode('utf-8', errors='replace').replace('\r', '\n')
        if decoded_chunk:
            # Write to log file
            log_file.write(decoded_chunk)
            log_file.flush()
            # Write to database
            try:
                database.append_task_output(task_id, decoded_chunk)
            except Exception as e:
                sys.stderr.write(f"[!] DB Append Error: {e}\n")
                sys.stderr.flush()
            await asyncio.sleep(0.01)

async def main():
    global child_process, task_id, is_cancelled
    
    parser = argparse.ArgumentParser(description="Detached Pareo task runner")
    parser.add_argument("--task-id", required=True, help="UUID of the task")
    parser.add_argument("--command", required=True, help="Command shell string to execute")
    args = parser.parse_args()
    
    task_id = args.task_id
    command = args.command
    
    # Register signals
    signal.signal(signal.SIGTERM, sigterm_handler)
    signal.signal(signal.SIGINT, sigterm_handler)
    
    # Initialize DB (creates WAL mode and tables if needed)
    database.init_db()
    
    # Update status to Running and store PID
    my_pid = os.getpid()
    database.update_task_pid(task_id, my_pid)
    database.update_task_status(task_id, "Running")
    
    # Ensure logs folder exists
    log_dir = os.path.join(os.getcwd(), "logs", "tasks")
    os.makedirs(log_dir, exist_ok=True)
    log_file_path = os.path.join(log_dir, f"{task_id}.log")
    
    sys.stdout.write(f"[*] Task {task_id} runner starting. PID={my_pid}\n")
    sys.stdout.flush()
    
    return_code = -1
    
    with open(log_file_path, "w", encoding="utf-8") as log_file:
        try:
            # Start process in a new process group to allow group signaling (SIGTERM)
            child_process = await asyncio.create_subprocess_shell(
                command,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                preexec_fn=os.setsid # Starts a new process group for the child
            )
            
            # Read stdout and stderr concurrently
            await asyncio.gather(
                read_stream(child_process.stdout, task_id, log_file),
                read_stream(child_process.stderr, task_id, log_file)
            )
            
            # Wait for exit
            return_code = await child_process.wait()
            
        except Exception as e:
            error_msg = f"\nRunner Exception: {str(e)}\n"
            log_file.write(error_msg)
            log_file.flush()
            database.append_task_output(task_id, error_msg)
            return_code = -999
            
    end_time = datetime.now().isoformat()
    
    # Check if task was cancelled via signal
    if is_cancelled:
        database.update_task_status(task_id, "Cancelled", end_time)
        database.append_task_output(task_id, "\n[Task Cancelled by User]")
        sys.stdout.write(f"[*] Task {task_id} completed as Cancelled.\n")
    elif return_code == 0:
        database.update_task_status(task_id, "Completed", end_time)
        sys.stdout.write(f"[*] Task {task_id} completed successfully.\n")
    else:
        status_str = f"Failed (Code: {return_code})"
        database.update_task_status(task_id, status_str, end_time)
        sys.stdout.write(f"[*] Task {task_id} failed with code {return_code}.\n")
    sys.stdout.flush()

if __name__ == "__main__":
    asyncio.run(main())

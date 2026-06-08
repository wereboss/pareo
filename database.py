import sqlite3
from datetime import datetime

DB_FILE = "pareo.db"

def get_conn():
    """Returns a dictionary-like cursor connection."""
    # check_same_thread=False allows FastAPI/Asyncio to share the connection safely
    conn = sqlite3.connect(DB_FILE, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    """Creates the schema if it doesn't exist."""
    with get_conn() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS tasks (
                task_id TEXT PRIMARY KEY,
                command TEXT,
                status TEXT,
                output TEXT,
                start_time TEXT,
                end_time TEXT
            )
        """)
        conn.commit()

def insert_task(task_id: str, command: str, status: str, start_time: str):
    with get_conn() as conn:
        conn.execute(
            "INSERT INTO tasks (task_id, command, status, output, start_time, end_time) VALUES (?, ?, ?, ?, ?, ?)",
            (task_id, command, status, "", start_time, "")
        )
        conn.commit()

def update_task_status(task_id: str, status: str, end_time: str = ""):
    with get_conn() as conn:
        if end_time:
            conn.execute("UPDATE tasks SET status = ?, end_time = ? WHERE task_id = ?", (status, end_time, task_id))
        else:
            conn.execute("UPDATE tasks SET status = ? WHERE task_id = ?", (status, task_id))
        conn.commit()

def append_task_output(task_id: str, chunk: str):
    """Efficiently appends string chunks directly inside the database."""
    with get_conn() as conn:
        conn.execute("UPDATE tasks SET output = output || ? WHERE task_id = ?", (chunk, task_id))
        conn.commit()

def get_all_tasks():
    with get_conn() as conn:
        cur = conn.execute("SELECT * FROM tasks ORDER BY start_time DESC")
        return {row["task_id"]: dict(row) for row in cur.fetchall()}

def get_task(task_id: str):
    with get_conn() as conn:
        cur = conn.execute("SELECT * FROM tasks WHERE task_id = ?", (task_id,))
        row = cur.fetchone()
        return dict(row) if row else None

# --- RECOVERY LOGIC ---

def mark_running_as_failed():
    """Marks tasks that were interrupted by a server shutdown as Failed."""
    with get_conn() as conn:
        end_time = datetime.now().isoformat()
        conn.execute(
            "UPDATE tasks SET status = 'Failed (Interrupted)', end_time = ? WHERE status = 'Running'",
            (end_time,)
        )
        conn.commit()

def get_pending_tasks():
    """Retrieves all tasks that were queued but never started."""
    with get_conn() as conn:
        cur = conn.execute("SELECT task_id, command FROM tasks WHERE status = 'Pending' ORDER BY start_time ASC")
        return [{"task_id": row["task_id"], "command": row["command"]} for row in cur.fetchall()]
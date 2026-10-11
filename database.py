import sqlite3
import hashlib
import secrets
import hmac
import uuid
from datetime import datetime, timedelta
from pathlib import Path
from typing import Optional, Dict, Any, List

BASE_DIR = Path(__file__).resolve().parent
DB_FILE = BASE_DIR / "pareo.db"

def get_conn():
    """Returns a dictionary-like cursor connection configured with performance PRAGMAs."""
    # check_same_thread=False allows FastAPI/Asyncio to share the connection safely
    conn = sqlite3.connect(str(DB_FILE), check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode = WAL;")
    conn.execute("PRAGMA synchronous = NORMAL;")
    conn.execute("PRAGMA busy_timeout = 5000;")
    conn.execute("PRAGMA wal_autocheckpoint = 1000;")
    return conn

def init_db():
    """Creates the schema and performance indices if they don't exist."""
    with get_conn() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS tasks (
                task_id TEXT PRIMARY KEY,
                command TEXT,
                status TEXT,
                output TEXT,
                start_time TEXT,
                end_time TEXT,
                queue_name TEXT
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS library_cache (
                library_name TEXT,
                subpath TEXT,
                deep_scan INTEGER,
                cache_data TEXT,
                cached_at TEXT,
                PRIMARY KEY (library_name, subpath, deep_scan)
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS users (
                user_id TEXT PRIMARY KEY,
                email TEXT UNIQUE NOT NULL,
                password_hash TEXT NOT NULL,
                salt TEXT NOT NULL,
                role TEXT NOT NULL DEFAULT 'Viewer',
                created_at TEXT NOT NULL,
                last_login TEXT,
                is_active INTEGER NOT NULL DEFAULT 1
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS sessions (
                token TEXT PRIMARY KEY,
                user_id TEXT NOT NULL,
                created_at TEXT NOT NULL,
                expires_at TEXT NOT NULL,
                last_active TEXT NOT NULL,
                FOREIGN KEY(user_id) REFERENCES users(user_id) ON DELETE CASCADE
            )
        """)
        conn.commit()
        
        # Ensure queue_name column exists for older databases (migration fallback)
        try:
            conn.execute("ALTER TABLE tasks ADD COLUMN queue_name TEXT")
            conn.commit()
        except sqlite3.OperationalError:
            pass

        # Ensure pid column exists for detached process monitoring
        try:
            conn.execute("ALTER TABLE tasks ADD COLUMN pid INTEGER")
            conn.commit()
        except sqlite3.OperationalError:
            pass

        # Migrate NULL queue_names to their correct legacy mappings
        conn.execute("""
            UPDATE tasks
            SET queue_name = CASE
                WHEN command LIKE 'ffmpeg%' THEN 'media'
                WHEN command LIKE 'aria2c%' THEN 'network'
                WHEN command LIKE 'cp %' OR command LIKE 'mv %' OR command LIKE 'rm %' OR command LIKE 'tar %' OR command LIKE 'scp %' THEN 'fs'
                ELSE 'default'
            END
            WHERE queue_name IS NULL
        """)
        conn.commit()

        # B-Tree indices for status filtering, queue scheduling, and timeline pagination
        conn.execute("CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_tasks_queue_status ON tasks(queue_name, status);")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_tasks_start_time ON tasks(start_time DESC);")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token);")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);")
        conn.commit()

def vacuum_db():
    """Reclaims unallocated pages resulting from task output pruning."""
    with get_conn() as conn:
        conn.execute("VACUUM;")
        conn.commit()

def insert_task(task_id: str, command: str, status: str, start_time: str, queue_name: str = "default"):
    with get_conn() as conn:
        conn.execute(
            "INSERT INTO tasks (task_id, command, status, output, start_time, end_time, queue_name, pid) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)",
            (task_id, command, status, "", start_time, "", queue_name)
        )
        conn.commit()

def update_task_status(task_id: str, status: str, end_time: str = ""):
    with get_conn() as conn:
        if end_time:
            conn.execute("UPDATE tasks SET status = ?, end_time = ? WHERE task_id = ?", (status, end_time, task_id))
        else:
            conn.execute("UPDATE tasks SET status = ? WHERE task_id = ?", (status, task_id))
        conn.commit()

def update_task_pid(task_id: str, pid: int):
    with get_conn() as conn:
        conn.execute("UPDATE tasks SET pid = ? WHERE task_id = ?", (pid, task_id))
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

def get_tasks_paginated(limit: int = 15, offset: int = 0, queue: str = None, status: str = None, command: str = None):
    """Retrieves metadata of historical tasks excluding logs with pagination and optional filtering."""
    query = "SELECT task_id, command, status, start_time, end_time, queue_name FROM tasks"
    conditions = []
    params = []
    
    if queue:
        conditions.append("queue_name = ?")
        params.append(queue)
    if status:
        if status.lower() == 'failed':
            conditions.append("status LIKE 'Failed%'")
        elif status.lower() == 'incomplete':
            conditions.append("status IN ('Pending', 'Running')")
        else:
            conditions.append("status = ?")
            params.append(status)
    if command:
        conditions.append("command LIKE ?")
        params.append(f"%{command}%")
        
    if conditions:
        query += " WHERE " + " AND ".join(conditions)
        
    query += " ORDER BY start_time DESC LIMIT ? OFFSET ?"
    params.extend([limit, offset])
    
    with get_conn() as conn:
        cur = conn.execute(query, params)
        return {row["task_id"]: dict(row) for row in cur.fetchall()}

def get_task(task_id: str):
    with get_conn() as conn:
        cur = conn.execute("SELECT * FROM tasks WHERE task_id = ?", (task_id,))
        row = cur.fetchone()
        return dict(row) if row else None

def get_task_counts():
    """Returns exact counts of ongoing (Running) and pending tasks."""
    with get_conn() as conn:
        cur = conn.execute("""
            SELECT 
                SUM(CASE WHEN status = 'Running' THEN 1 ELSE 0 END) as ongoing,
                SUM(CASE WHEN status = 'Pending' THEN 1 ELSE 0 END) as pending
            FROM tasks
        """)
        row = cur.fetchone()
        return {
            "ongoing": row["ongoing"] if row["ongoing"] is not None else 0,
            "pending": row["pending"] if row["pending"] is not None else 0
        }

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
        cur = conn.execute("SELECT task_id, command, queue_name FROM tasks WHERE status = 'Pending' ORDER BY start_time ASC")
        return [
            {
                "task_id": row["task_id"], 
                "command": row["command"], 
                "queue_name": row["queue_name"]
            } for row in cur.fetchall()
        ]
    
def reset_task_for_retry(task_id: str, new_start_time: str):
    """Scrubs error output and resets a task to Pending."""
    with get_conn() as conn:
        conn.execute(
            "UPDATE tasks SET status = 'Pending', output = '', start_time = ?, end_time = '' WHERE task_id = ?",
            (new_start_time, task_id)
        )
        conn.commit()    

def update_task_start_time(task_id: str, start_time: str):
    """Updates the start time when a task officially moves out of the queue."""
    with get_conn() as conn:
        conn.execute("UPDATE tasks SET start_time = ? WHERE task_id = ?", (start_time, task_id))
        conn.commit()

def purge_tasks(age: str) -> int:
    """Purges historical tasks (excluding active Pending/Running ones) based on the age threshold."""
    from datetime import datetime, timedelta
    
    if age == 'all':
        query = "DELETE FROM tasks WHERE status NOT IN ('Pending', 'Running')"
        params = []
    else:
        now = datetime.now()
        if age == '1d':
            cutoff = now - timedelta(days=1)
        elif age == '1w':
            cutoff = now - timedelta(weeks=1)
        elif age == '2w':
            cutoff = now - timedelta(weeks=2)
        else:
            raise ValueError("Invalid age threshold")
            
        query = "DELETE FROM tasks WHERE status NOT IN ('Pending', 'Running') AND start_time < ?"
        params = [cutoff.isoformat()]
        
    with get_conn() as conn:
        res = conn.execute(query, params)
        conn.commit()
        return res.rowcount

def get_cached_library(library_name: str, subpath: str, deep_scan: bool) -> str:
    """Retrieves cached library data as JSON string if exists, otherwise None."""
    ds_val = 1 if deep_scan else 0
    with get_conn() as conn:
        cur = conn.execute(
            "SELECT cache_data FROM library_cache WHERE library_name = ? AND subpath = ? AND deep_scan = ?",
            (library_name, subpath, ds_val)
        )
        row = cur.fetchone()
        return row["cache_data"] if row else None

def set_cached_library(library_name: str, subpath: str, deep_scan: bool, cache_data: str):
    """Sets/updates cached library data as JSON string."""
    ds_val = 1 if deep_scan else 0
    cached_at = datetime.now().isoformat()
    with get_conn() as conn:
        conn.execute(
            """
            INSERT OR REPLACE INTO library_cache (library_name, subpath, deep_scan, cache_data, cached_at)
            VALUES (?, ?, ?, ?, ?)
            """,
            (library_name, subpath, ds_val, cache_data, cached_at)
        )
        conn.commit()

# --- AUTHENTICATION & USER MANAGEMENT (MVP 2) ---

def hash_password(password: str, salt: Optional[str] = None) -> tuple:
    """Hashes a password with PBKDF2-HMAC-SHA256 (100,000 iterations)."""
    if salt is None:
        salt_bytes = secrets.token_bytes(16)
        salt_hex = salt_bytes.hex()
    else:
        salt_hex = salt
        salt_bytes = bytes.fromhex(salt_hex)
    hash_bytes = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt_bytes, 100000)
    return hash_bytes.hex(), salt_hex

def verify_password(password: str, salt_hex: str, hash_hex: str) -> bool:
    """Verifies a password using constant-time comparison against PBKDF2-HMAC-SHA256."""
    computed_hash, _ = hash_password(password, salt=salt_hex)
    return hmac.compare_digest(computed_hash, hash_hex)

def create_user(email: str, password: str, role: str = "Viewer") -> dict:
    """Creates a new user record with salted PBKDF2 hash."""
    clean_email = email.strip().lower()
    hash_hex, salt_hex = hash_password(password)
    user_id = str(uuid.uuid4())
    now = datetime.utcnow().isoformat()
    with get_conn() as conn:
        conn.execute(
            """
            INSERT INTO users (user_id, email, password_hash, salt, role, created_at, is_active)
            VALUES (?, ?, ?, ?, ?, ?, 1)
            """,
            (user_id, clean_email, hash_hex, salt_hex, role, now)
        )
        conn.commit()
    return {
        "user_id": user_id,
        "email": clean_email,
        "role": role,
        "created_at": now,
        "last_login": None,
        "is_active": 1
    }

def get_user_by_email(email: str) -> Optional[dict]:
    """Retrieves user by case-insensitive email."""
    if not email:
        return None
    clean_email = email.strip().lower()
    try:
        with get_conn() as conn:
            cur = conn.execute("SELECT * FROM users WHERE lower(email) = ?", (clean_email,))
            row = cur.fetchone()
            return dict(row) if row else None
    except sqlite3.OperationalError:
        return None

def get_user_by_id(user_id: str) -> Optional[dict]:
    """Retrieves user by user_id."""
    if not user_id:
        return None
    try:
        with get_conn() as conn:
            cur = conn.execute("SELECT * FROM users WHERE user_id = ?", (user_id,))
            row = cur.fetchone()
            return dict(row) if row else None
    except sqlite3.OperationalError:
        return None

def count_users() -> int:
    """Returns the total number of registered users."""
    try:
        with get_conn() as conn:
            cur = conn.execute("SELECT COUNT(*) as count FROM users")
            row = cur.fetchone()
            return row["count"] if row else 0
    except sqlite3.OperationalError:
        try:
            init_db()
            with get_conn() as conn:
                cur = conn.execute("SELECT COUNT(*) as count FROM users")
                row = cur.fetchone()
                return row["count"] if row else 0
        except sqlite3.OperationalError:
            return 0

def update_user_last_login(user_id: str):
    """Updates the last_login timestamp for a user."""
    now = datetime.utcnow().isoformat()
    try:
        with get_conn() as conn:
            conn.execute("UPDATE users SET last_login = ? WHERE user_id = ?", (now, user_id))
            conn.commit()
    except sqlite3.OperationalError:
        pass

def list_users() -> List[dict]:
    """Lists all users without password hashes or salts."""
    try:
        with get_conn() as conn:
            cur = conn.execute("SELECT user_id, email, role, created_at, last_login, is_active FROM users ORDER BY created_at ASC")
            return [dict(row) for row in cur.fetchall()]
    except sqlite3.OperationalError:
        return []

# --- SESSION MANAGEMENT (MVP 2) ---

def create_session(user_id: str, ttl_hours: int = 48) -> dict:
    """Issues a cryptographically secure session token with TTL (default 48h)."""
    token = secrets.token_urlsafe(32)
    now = datetime.utcnow()
    created_at = now.isoformat()
    expires_at = (now + timedelta(hours=ttl_hours)).isoformat()
    last_active = created_at
    with get_conn() as conn:
        conn.execute(
            """
            INSERT INTO sessions (token, user_id, created_at, expires_at, last_active)
            VALUES (?, ?, ?, ?, ?)
            """,
            (token, user_id, created_at, expires_at, last_active)
        )
        conn.commit()
    return {
        "token": token,
        "user_id": user_id,
        "created_at": created_at,
        "expires_at": expires_at,
        "last_active": last_active
    }

def get_session(token: str) -> Optional[dict]:
    """Retrieves session if valid and not expired, updating last_active."""
    if not token:
        return None
    now = datetime.utcnow().isoformat()
    try:
        with get_conn() as conn:
            cur = conn.execute("SELECT * FROM sessions WHERE token = ?", (token,))
            row = cur.fetchone()
            if not row:
                return None
            session = dict(row)
            if session["expires_at"] < now:
                conn.execute("DELETE FROM sessions WHERE token = ?", (token,))
                conn.commit()
                return None
            conn.execute("UPDATE sessions SET last_active = ? WHERE token = ?", (now, token))
            conn.commit()
            session["last_active"] = now
            return session
    except sqlite3.OperationalError:
        return None

def delete_session(token: str) -> bool:
    """Revokes a session token."""
    if not token:
        return False
    try:
        with get_conn() as conn:
            cur = conn.execute("DELETE FROM sessions WHERE token = ?", (token,))
            conn.commit()
            return cur.rowcount > 0
    except sqlite3.OperationalError:
        return False

def cleanup_expired_sessions() -> int:
    """Removes all expired sessions."""
    now = datetime.utcnow().isoformat()
    try:
        with get_conn() as conn:
            cur = conn.execute("DELETE FROM sessions WHERE expires_at < ?", (now,))
            conn.commit()
            return cur.rowcount
    except sqlite3.OperationalError:
        return 0

# --- BATCH TASK OPERATIONS (MVP 2) ---

def batch_cancel_tasks(task_ids: List[str]) -> List[str]:
    """Marks pending/running tasks in the list as Cancelled."""
    if not task_ids:
        return []
    now = datetime.now().isoformat()
    cancelled = []
    with get_conn() as conn:
        for tid in task_ids:
            cur = conn.execute(
                "UPDATE tasks SET status = 'Cancelled', end_time = ? WHERE task_id = ? AND status IN ('Pending', 'Running')",
                (now, tid)
            )
            if cur.rowcount > 0:
                cancelled.append(tid)
        conn.commit()
    return cancelled

def batch_purge_tasks(task_ids: List[str]) -> List[str]:
    """Deletes finished, failed, or cancelled tasks."""
    if not task_ids:
        return []
    purged = []
    with get_conn() as conn:
        for tid in task_ids:
            cur = conn.execute(
                "DELETE FROM tasks WHERE task_id = ? AND status NOT IN ('Pending', 'Running')",
                (tid,)
            )
            if cur.rowcount > 0:
                purged.append(tid)
        conn.commit()
    return purged
# Pareo - Configuration-Driven Command Execution & Orchestration Engine

**Pareo** (Latin for *"I obey"* or *"I am obedient"*) is a lightweight, modular, and configuration-driven Single Page Application (SPA) utility designed to queue, execute, and monitor system-level commands and orchestrate tasks over a Local Area Network (LAN).

With a robust FastAPI backend, an asynchronous SQLite WAL state machine, and a responsive vanilla HTML/JS frontend, Pareo allows you to safely delegate heavy tasks (like media conversion and batch file transfers) to a dedicated home server or local machine without CPU/RAM overload or browser blocking.

---

## 🚀 Key Features

### 1. Multi-Queue Task Engine
Rather than running everything in a single queue, Pareo implements a concurrent **Multi-Queue Async Executor** (`executor.py`) with four dedicated channels:
*   🎥 **`media`**: Sequentially processes heavy video/audio rendering workloads (e.g., FFMPEG).
*   📁 **`fs`**: Manages file system operations like copying, moving, deleting, and compressing files.
*   🌐 **`network`**: Handles downloads and external data requests (e.g., Torrent Downloader via `aria2c`).
*   ⚙️ **`default`**: A fallback channel for generic operations and retried tasks.

Tasks within each queue run sequentially to protect hardware resources, while separate queues process tasks concurrently (e.g., a file compression job will not block a torrent download).

### 2. State & Recovery Machine
*   **SQLite Logging & State Database (`pareo.db`):** Task states, execution metrics, and real-time terminal stdout/stderr outputs are saved persistently in SQLite (optimized with WAL mode and indices).
*   **Orphan Recovery:** On server boot, any task left in a "Running" state (due to abrupt server termination or power outage) is inspected; active detached processes continue running, while interrupted tasks are marked as `Failed (Interrupted)` and unresolved `Pending` tasks are automatically restored and re-queued.
*   **Interactive Task Retry:** Failed or interrupted tasks can be retried directly from the UI, resetting their logs and queueing them back into the execution flow.

### 3. Real-Time Server-Sent Events (SSE) Bus & Telemetry Engine
*   **Zero HTTP Polling:** Pareo V2 replaces 1000ms polling loops with a persistent Server-Sent Events (SSE) stream (`GET /api/stream/events`).
*   **Push-Based Streaming:** Real-time task state transitions, incremental terminal stdout/stderr chunks, live queue depth counts, and continuous host telemetry metrics are pushed reactively from server memory to the browser.
*   **Host System & Queue Telemetry:** Continuous 2.0s background sampling of CPU load averages, cores, and %, memory allocation from `/proc/meminfo`, disk utilization across allowed root boundaries, and live worker slot saturation per queue channel.

### 4. Email Authentication, Sessions & Role-Based Access Control (RBAC)
*   **PBKDF2-HMAC-SHA256 Cryptography:** Secure password hashing with 100,000 iterations, 16-byte cryptographically secure salts, and constant-time verification (`hmac.compare_digest`).
*   **Hierarchical Roles (`Admin`, `Operator`, `Viewer`):**
    *   **`Admin`:** Complete system control, user provisioning, batch operations, daemon control, and server configuration.
    *   **`Operator`:** Task submission, batch queue execution, retry, cancel, and utility execution.
    *   **`Viewer`:** Read-only visibility over tasks, logs, telemetry, and processes without mutation privileges.
*   **Flexible Token Extraction:** Authenticates via `Authorization: Bearer <token>`, `X-Pareo-Auth` header, or `?token=` query parameter for SSE streams.
*   **Frictionless LAN Fallback:** If zero user accounts exist in the database, Pareo runs in zero-friction mode, allowing immediate out-of-the-box local operation without login barriers.

### 5. Interactive Batch Queue Management & Floating Action Dock
*   **Multi-Select Task Selection:** Bulk selection via desktop table header or mobile quick-select toolbar.
*   **Floating Action Dock:** Accessible thumb-zone floating dock (`.batch-action-dock`) with live selection counters and haptic feedback (`navigator.vibrate`).
*   **Batch Operations:** One-click batch cancel, batch retry, and batch purge over REST endpoints (`/api/tasks/batch/*`).

### 6. Cross-Platform Progressive Web App (PWA) & Mobile Ergonomics
*   **Installable App Shell:** Web App Manifest (`manifest.json`) and Service Worker (`sw.js`) supporting standalone display on iOS Safari and Android Chrome.
*   **Offline Mode:** Service worker app-shell caching with dynamic online/offline status banner.
*   **Mobile Ergonomics:** Strict adherence to minimum 44px touch targets, safe-area insets (`env(safe-area-inset-bottom)`), bottom-sheet modal dialogues with drag handles, and thumb-friendly navigation.

### 7. Bespoke Dual-Theme UI System
*   **"Sony's Wipeout":** Inspired by *The Designers Republic* (tDR) anti-gravity racing aesthetic. Features a sleek cockpit obsidian palette (`#07090e`), carbon surfaces, crisp technical typography, angled chamfered HUD geometry, and electric cyan (`#00f0ff`), neon orange (`#ff5500`), and acid yellow (`#eaff00`) telemetry accents.
*   **"Fallout game's Atompunk":** Inspired by RobCo Industries Pip-Boy 3000 CRT terminals. Features glowing phosphor green (`#1aff80`) on deep vacuum tube black/olive (`#050b07`), subtle horizontal CRT scanlines, ambient phosphor bloom glow, analog meters, and vintage monospace readouts.
*   **Responsive Layout:** Automatically transforms into a mobile card view (<640px) with thumb-zone bottom navigation and >=44px touch targets.

### 5. Interactive Utilities & Switchboard
*   **System Switchboard:** A physical-like grid of immediate execution buttons (e.g., check server uptime, check disk usage, start/stop a VPN). Supports:
    *   *Standard Execution:* Runs the shell command and displays the terminal output directly in an overlay modal.
    *   *Detached Execution:* Spawns an independent OS process (fire-and-forget) that runs in a new session without blocking the engine or logging outputs.
*   **Generic Task Cards:** Templated inputs defined in `config.json` that render customized forms in the UI. When submitted, they resolve inputs into template variables, compile the final command, and route them to their designated execution queue.

### 6. Interactive File Manager & Bookmarks
*   **Directory Browser:** A modal-based explorer that communicates with local/remote nodes.
*   **Bookmarks & Auto-complete:** Paths configured in `config.json` are exposed to the UI as suggestions to simplify path entry.
*   **Configurable Batch Actions:** Perform commands (Copy, Move, Compress, etc.) on multiple selected files. The interface dynamically reads `config.json` to show/hide destination inputs depending on the requirements of the selected action.

### 7. Local Process Monitor
*   **Independent Daemon Control:** Start, stop, or force-kill server processes configured in `config.json`. Spawns processes in a detached session (`start_new_session=True`) to run independently of Pareo.
*   **Port & Process Status:** Inspects listening sockets (`lsof` or `ss`) to verify status, adopt running PIDs, and retrieve details, ensuring the UI remains perfectly in sync without memory state dependency.
*   **Live Log Streaming:** Access and refresh live console tailing files directly from the UI logs modal overlay.

---

## 🏗️ System Architecture

Pareo relies on a strict separation of concerns to guarantee stability:

```mermaid
graph TD
    UI[static/ SPA Frontend] -->|SSE Stream & API| API[server.py FastAPI Layer]
    API -->|Validate & Load| CFG[config.json Configuration]
    API -->|Read/Write State| DB[(pareo.db SQLite Database WAL)]
    API -->|Build Commands| CB[command_builder.py]
    API -->|Submit Tasks| EX[executor.py Async Engine]
    EX -->|Broadcast Events| SSE[broadcaster.py SSE Hub]
    SSE -->|Push to Browser| UI
    EX -->|Writes Live Output| DB
    EX -->|Spawns Detached| OS[Linux Shell/OS Processes]
```

1.  **The Pipeline Schema (`config.json`):** The single source of truth defining execution profiles, file system actions, quick-access bookmarks, remote servers, switchboard triggers, and generic card templates.
2.  **The Database (`database.py`):** Wraps SQLite queries to insert tasks, append logs in chunks, and manage task recovery on startup.
3.  **The Command Builder (`command_builder.py`):** Interpolates parameters into CLI command templates and injects credentials for remote operations (e.g. SCP).
4.  **The Engine (`executor.py`):** Spawns `asyncio` workers, routes task requests, manages concurrent queue pipelines, and streams raw outputs.
5.  **The Event Broadcaster (`broadcaster.py`):** Thread-safe async SSE hub broadcasting real-time task lifecycle updates and streaming logs.
6.  **The API Layer (`server.py`):** Binds endpoints, coordinates non-blocking commands, lists filesystem contents, and serves assets.
7.  **The Frontend SPA (`static/`):** A responsive, multi-theme interface featuring live task lists, custom status badges, an interactive file explorer, and a settings utility grid.

---

## 📂 Project Structure

```text
pareo/
├── run.py               # Production startup script (Uvicorn manager)
├── server.py            # FastAPI router, non-blocking handlers, and endpoints
├── executor.py          # Multitasking queues, subprocess workers, and stream piping
├── database.py          # SQLite database interface & state recovery logic
├── command_builder.py   # CLI template compiler (FFMPEG & FS commands)
├── config.json          # Global layout structure, profiles, and remote credentials
├── pareo.db             # Active SQLite database file (WAL mode)
└── static/              # Frontend Single Page Application
    ├── index.html       # SPA markup, mobile navigation, and layout containers
    ├── app.js           # Client state, SSE EventSource listener, dynamic cards, modals
    └── style.css        # Wipeout HUD and Fallout Atompunk CSS design system
```

---

## 🔌 API Reference

### Real-Time Streaming & Telemetry
*   `GET /api/stream/events` - SSE endpoint streaming `connected`, `task_counts`, `task_update`, `task_output`, and `telemetry` events.
*   `GET /api/telemetry` - Returns current host CPU, RAM, disk, and queue saturation metrics.

### Authentication & Access Control (MVP 2)
*   `GET /api/auth/status` - Checks initialization status and registered user count.
*   `POST /api/auth/setup-admin` - Initializes the root administrator account (one-time setup).
*   `POST /api/auth/register` - Registers a new user account (`Admin`, `Operator`, `Viewer`). Requires Admin role.
*   `POST /api/auth/login` - Authenticates credentials and issues an active session token.
*   `POST /api/auth/logout` - Revokes current session token.
*   `GET /api/auth/me` - Retrieves authenticated user profile and assigned role.
*   `GET /api/auth/verify` - Confirms token validity or verifies frictionless LAN mode.

### Batch Queue Operations (MVP 2)
*   `POST /api/tasks/batch/cancel` - Cancels multiple pending/running tasks simultaneously.
*   `POST /api/tasks/batch/retry` - Resets and re-queues multiple failed or cancelled tasks.
*   `POST /api/tasks/batch/purge` - Purges specified tasks from history.

### Configuration & Utilities
*   `GET /api/config/ffmpeg` - Retrieves media conversion profiles.
*   `GET /api/config/fs` - Retrieves local and remote file system action templates.
*   `GET /api/config/bookmarks` - Serves folder shortcuts for autocomplete fields.
*   `GET /api/config/remotes` - Serves remote server profiles (SSH details and bookmarks).
*   `GET /api/config/switchboard` - Retrieves grouped switchboard button configs.
*   `GET /api/config/generic_cards` - Serves customized execution template cards.
*   `GET /api/config/processes` - Retrieves local process monitoring configurations.

### Process Monitoring
*   `GET /api/processes/status` - Bulk retrieves statuses (Running/Stopped, PID, Port) of all configured local processes.
*   `POST /api/processes/start` - Starts a process group in a detached environment.
*   `POST /api/processes/stop` - Terminates (SIGTERM) or kills (SIGKILL) a process group.
*   `GET /api/processes/logs?name=<name>&lines=<N>` - Returns the latest `<N>` log lines for a specific process.

### Task Management
*   `GET /api/tasks?limit=<N>&offset=<M>` - Retrieves task metadata records from SQLite with pagination (excluding logs).
*   `GET /api/tasks/{task_id}` - Retrieves full info and output logs for a specific task.
*   `POST /api/tasks/{task_id}/retry` - Resets a failed task and re-submits it to the `default` queue.
*   `POST /api/tasks/{task_id}/cancel` - Cancels a running task (`SIGTERM` sent to process group).

### Execution Endpoints
*   `POST /api/execute/ls` - Helper to immediately queue `ls -ltr` on the `default` queue.
*   `POST /api/execute/ffmpeg` - Queues video/audio conversions (routed to `media` queue). Supports single file and batch wildcard processing.
*   `POST /api/execute/fs` - Queues batch file management actions (routed to `fs` queue).
*   `POST /api/execute/switchboard` - Triggers immediate/detached terminal actions (e.g., VPN toggles).
*   `POST /api/execute/generic` - Compiles custom card inputs and submits to the card's specified queue type.

### File Explorer
*   `GET /api/fs/list?target_path=<path>` - Lists files and subdirectories at `<path>` (folders sorted first).

---

## ⚙️ Prerequisites

*   Python 3.8+
*   Linux Host Machine (or compatible environment with bash)
*   `ffmpeg` installed on the host (for media conversion features)
*   Additional utilities (`aria2c` for torrent downloads, `expressvpn` for VPN buttons, etc., as configured in `config.json`)

---

## 🛠️ Installation & Usage

1.  **Clone the Repository:**
    ```bash
    git clone https://github.com/yourusername/pareo.git
    cd pareo
    ```

2.  **Set Up Local Virtual Environment (Recommended):**
    Create and activate a local virtual environment:
    ```bash
    python3 -m venv venv
    
    # For Bash/Zsh:
    source venv/bin/activate
    
    # For Fish:
    source venv/bin/activate.fish
    ```
    Install the dependencies from the requirements file:
    ```bash
    pip install -r requirements.txt
    ```

3.  **Adjust Configurations:**
    Edit [config.json](file:///workspace/config.json) to reflect your system directories, remote server logins, custom shell scripts, and FFMPEG needs.

4.  **Start the Engine:**
    Run the shell bootstrap script:
    ```bash
    ./run.sh
    ```
    This automatically checks for virtual environments and launches the engine on **port 9046** with a single Uvicorn worker to preserve `asyncio.Queue` state in a single memory space.

5.  **Access the Dashboard:**
    Open your web browser and navigate to:
    ```text
    http://<YOUR_HOST_IP>:9046/
    ```
    *(In MVP 1, local access is completely frictionless with no authentication required. In MVP 2, once an administrator account is initialized via the UI or `POST /api/auth/setup-admin`, operations enforce role-based authentication).*

# Pareo - Command Execution Engine

**Pareo** (Latin for *"I obey"* or *"I am obedient"*) is a lightweight, modular Single Page Application (SPA) utility designed to execute, monitor, and track Linux commands over a Local Area Network (LAN).

## 🚀 Features (MVP)
- **Asynchronous Execution:** Leverages Python's `asyncio` and FastAPI's `BackgroundTasks` to run OS-level commands without blocking the web server.
- **Transparent Monitoring:** Real-time visibility into ongoing and completed tasks.
- **Optimistic UI:** Instant visual feedback in the frontend while the backend dispatches commands.
- **Zero-Dependency Frontend:** Built entirely with Vanilla HTML5, CSS3, and JavaScript.

## 🏗️ Architecture
Pareo is built on a strict separation of concerns to ensure stability and modularity:
1. **The Engine (`executor.py`):** Spawns background processes, captures `stdout`/`stderr`, and maintains an in-memory state dictionary.
2. **The API (`server.py`):** A FastAPI layer that exposes endpoints to trigger commands and poll statuses.
3. **The SPA (`static/`):** A responsive, polling-based UI that interacts with the API via the `fetch` API.

## 📂 Folder Structure
```text
pareo/
│
├── executor.py          # The core engine: handles async subprocesses and state
├── server.py            # The API layer: FastAPI endpoints and routing
├── requirements.txt     # Python dependencies (fastapi, uvicorn)
│
└── static/              # The Frontend SPA layer
    ├── index.html       # The main UI (Utilities and Ongoing Tasks views)
    ├── app.js           # Vanilla JS for DOM manipulation and API polling
    └── style.css        # Clean, minimal styling for the interface

## ⚙️ Prerequisites

* Python 3.7+
* Linux Host Machine

## 🛠️ Installation & Usage

1. **Install Dependencies:**
```bash
pip install fastapi uvicorn

```


*(Note: Add these to a `requirements.txt` file for easy setup.)*
2. **Start the Server (LAN Mode):**
Run the following command from the root `pareo` directory to bind the server to your local network on port 9025:
```bash
uvicorn server:app --host 0.0.0.0 --port 9025 --reload

```


3. **Access the Utility:**
Open a web browser on any device connected to the same network and navigate to:
```text
http://<YOUR_LINUX_MACHINE_IP>:9025/

```


*(Ensure port 9025 is allowed through your host machine's firewall).*

## 🔌 API Endpoints (MVP)

* `POST /api/execute/{command}`: Dispatches a new command to the execution engine. Returns a unique `task_id` immediately.
* `GET /api/tasks`: Retrieves the current state (Pending, Running, Completed, Failed), output, and return codes of all historical and running tasks.

---

*Developed with a disciplined, incremental approach to ensure core stability before scaling.*

```

```
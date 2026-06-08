# Pareo - Configuration-Driven Execution Engine

**Pareo** (Latin for *"I obey"* or *"I am obedient"*) is a lightweight, modular Single Page Application (SPA) utility designed to execute, queue, and track OS-level commands over a Local Area Network (LAN). 

Originally built as a simple execution script, Pareo has evolved into a highly robust, configuration-driven automation pipeline. It currently features a heavy-duty media processing engine (FFMPEG) and a dynamic, batch-processing File Management system.

## 🚀 Key Features

### Core Engine
- **Task Queuing Engine:** Utilizes an `asyncio.Queue` background worker to process resource-intensive tasks sequentially, protecting the host machine from CPU/RAM overload.
- **Real-Time Log Streaming:** Captures raw byte-chunks to render terminal carriage returns perfectly. The UI uses a targeted, high-speed asynchronous polling loop to stream live progress exclusively for running tasks.
- **Dynamic SPA UI:** A vanilla HTML/JS frontend that shape-shifts its input fields, dropdowns, modals, and validation logic entirely based on the configuration schema it receives from the API.

### Media Processing (FFMPEG)
- **Configuration-Driven Pipeline:** Execution profiles, operational modes (Single vs. Batch), flags, and extension constraints are strictly defined in `config.json`. 
- **Wildcard Batch Processing:** Point Pareo at a directory pattern (e.g., `/media/*.mkv`) and it will automatically resolve the wildcard, generating and queuing individual tasks for the entire batch.

### File Operations Engine
- **Interactive File Explorer:** A dynamic, floating UI modal that allows users to natively browse the host machine's directory structure via a secure JSON API.
- **Configurable Batch Actions:** Select multiple files or folders and execute system-level operations (Copy, Move, Delete, Compress, etc.).
- **Self-Validating UI:** The action bar reads `config.json` to determine if a specific file operation requires a destination path (e.g., Copy) or not (e.g., Delete), dynamically revealing input fields and protecting against malformed commands.

## 🏗️ Architecture
Pareo is built on a strict separation of concerns to ensure stability, modularity, and safe execution:
1. **The Pipeline Schema (`config.json`):** The single source of truth defining execution profiles, file actions, and operational boundaries.
2. **The Command Builder (`command_builder.py`):** Securely constructs CLI commands using the configuration boundaries and safely injects variables (like `{source}` and `{dest}`).
3. **The Engine (`executor.py`):** Manages the `asyncio` worker loop, task queues, and real-time subprocess output streaming.
4. **The API (`server.py`):** A FastAPI layer that serves schemas, explores directories, validates requests against the config, and routes tasks to the engine.
5. **The SPA (`static/`):** A responsive, state-managed UI featuring dynamic layouts, floating overlays, and targeted DOM updates to prevent layout thrashing.

## 📂 Folder Structure
```text
pareo/
│
├── config.json          # Pipeline schema (FFMPEG profiles & FS actions)
├── command_builder.py   # Constructs secure commands based on config
├── executor.py          # The core engine: handles async queues and stream reading
├── server.py            # The API layer: FastAPI endpoints and validation logic
├── requirements.txt     # Python dependencies (fastapi, uvicorn, pydantic)
│
└── static/              # The Frontend SPA layer
    ├── index.html       # The main UI (Execution forms, Task views, Explorer Modal)
    ├── app.js           # Vanilla JS for state management and API interactions
    └── style.css        # Clean, minimal styling with terminal-block layouts

```

## 🔌 API Endpoints

### Configuration & Tasks

* `GET /api/tasks`: Retrieves the global state of all historical and pending tasks.
* `GET /api/tasks/{task_id}`: Retrieves high-speed, real-time data for a single specific task.

### FFMPEG Engine

* `GET /api/config/ffmpeg`: Serves the complete media pipeline schema to the frontend.
* `POST /api/execute/ffmpeg`: A unified execution endpoint that validates requests, unpacks batch wildcards, and pushes tasks into the queue.

### File Operations Engine

* `GET /api/config/fs`: Serves the File Operations configuration schema.
* `GET /api/fs/list`: Returns a structured JSON array of directories and files for the target path.
* `POST /api/execute/fs`: Validates and executes a batch of file system operations based on the configuration template.

## ⚙️ Prerequisites

* Python 3.7+
* Linux Host Machine
* FFMPEG installed on the host (for media processing features)

## 🛠️ Installation & Usage

1. **Install Dependencies:**
```bash
pip install fastapi uvicorn pydantic

```

2. **Configure Profiles:**
Modify `config.json` to define your specific FFMPEG flags and your desired File System commands (e.g., adding `tar` or `rsync` macros).
3. **Start the Server (LAN Mode):**
Run the following command from the root `pareo` directory to bind the server to your local network on port 9025:
```bash
uvicorn server:app --host 0.0.0.0 --port 9025

```

4. **Access the Utility:**
Open a web browser on any device connected to the same network and navigate to:
```text
http://<YOUR_LINUX_MACHINE_IP>:9025/

```

*Developed with a disciplined, incremental approach to ensure core stability before scaling.*

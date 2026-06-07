# Pareo - Configuration-Driven Execution Engine

**Pareo** (Latin for *"I obey"* or *"I am obedient"*) is a lightweight, modular Single Page Application (SPA) utility designed to execute, queue, and track OS-level commands over a Local Area Network (LAN). 

Originally built as a simple execution script, Pareo has evolved into a robust, configuration-driven pipeline engine, currently optimized for heavy-duty media processing via FFMPEG.

## 🚀 Key Features
- **Task Queuing Engine:** Utilizes an `asyncio.Queue` background worker to process resource-intensive tasks sequentially, protecting the host machine from CPU/RAM overload.
- **Configuration-Driven Pipeline:** Execution profiles, operational modes (Single vs. Batch), flags, and extension constraints are strictly defined in `config.json`. The backend and UI dynamically adapt to these rules.
- **Wildcard Batch Processing:** Point Pareo at a directory pattern (e.g., `/media/*.mkv`) and it will automatically resolve the wildcard, generating and queuing individual tasks for the entire batch.
- **Real-Time Log Streaming:** Captures raw byte-chunks to render FFMPEG's carriage returns perfectly. The UI uses a targeted, high-speed (1-second) asynchronous polling loop to stream live progress exclusively for running tasks.
- **Dynamic SPA UI:** A vanilla HTML/JS frontend that shape-shifts its input fields, dropdowns, and validation logic based on the configuration schema it receives from the API.

## 🏗️ Architecture
Pareo is built on a strict separation of concerns to ensure stability, modularity, and safe execution:
1. **The Pipeline Schema (`config.json`):** The single source of truth defining execution profiles and boundaries.
2. **The Command Builder (`command_builder.py`):** Securely constructs CLI commands using the configuration boundaries.
3. **The Engine (`executor.py`):** Manages the `asyncio` worker loop, task queues, and real-time subprocess output streaming.
4. **The API (`server.py`):** A FastAPI layer that serves the configuration schema, unrolls wildcards, validates requests against the config, and routes tasks to the engine.
5. **The SPA (`static/`):** A responsive, state-managed UI featuring dynamic layouts and targeted DOM updates to prevent layout thrashing during log scrolling.

## 📂 Folder Structure
```text
pareo/
│
├── config.json          # Pipeline schema (profiles, modes, allowed extensions)
├── command_builder.py   # Constructs secure commands based on config
├── executor.py          # The core engine: handles async queues and stream reading
├── server.py            # The API layer: FastAPI endpoints and validation logic
├── requirements.txt     # Python dependencies (fastapi, uvicorn, pydantic)
│
└── static/              # The Frontend SPA layer
    ├── index.html       # The main UI (Dynamic execution forms and Task views)
    ├── app.js           # Vanilla JS for state management and API interactions
    └── style.css        # Clean, minimal styling with terminal-block layouts

```

## 🔌 API Endpoints

* `GET /api/config/ffmpeg`: Serves the complete pipeline schema to the frontend.
* `POST /api/execute/ffmpeg`: A unified execution endpoint. Validates requests against the config, unpacks batch wildcards, and pushes tasks into the queue.
* `GET /api/tasks`: Retrieves the global state of all historical and pending tasks.
* `GET /api/tasks/{task_id}`: Retrieves high-speed, real-time data for a single specific task.

## ⚙️ Prerequisites

* Python 3.7+
* Linux Host Machine
* FFMPEG installed on the host

## 🛠️ Installation & Usage

1. **Install Dependencies:**
```bash
pip install fastapi uvicorn pydantic

```


2. **Configure Profiles:**
Modify `config.json` to define your specific execution flags, allowed modes (`single`, `batch`), and allowed output extensions.
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



---

*Developed with a disciplined, incremental approach to ensure core stability before scaling.*

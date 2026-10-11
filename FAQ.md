# Pareo V2 - Frequently Asked Questions & Operational Runbook

## General Architecture

### Q1: What is Pareo and how does it differ from traditional task runners like Celery or RQ?
**Pareo** is an asynchronous, configuration-driven command orchestration and system execution engine specifically designed for local area network (LAN) infrastructure and home server environments. Unlike Celery or RQ:
- **Zero-Agent Remote Execution:** Pareo operates without installing remote worker daemons or broker software on target satellite machines (e.g. macOS Mini storage servers). It connects strictly via OpenSSH, SCP, and dynamically pushed Python scripts.
- **Detached POSIX Process Groups:** Subprocesses run in detached process groups (`preexec_fn=os.setsid`), isolating long-running encoding or transfer jobs from server restarts and web worker crashes.
- **Zero-Hydration Vanilla Frontend:** The frontend is a fast Single Page Application built with vanilla HTML5, CSS3, and modern ES6+, eliminating build tooling, NPM dependencies, and bundle bloat.

### Q2: Why is Pareo V2 replacing HTTP polling with Server-Sent Events (SSE)?
In Pareo V1, each active running task triggered a 1000ms HTTP GET polling loop in the browser (`/api/tasks/{task_id}`). In addition, process statuses and task counts polled every 5000ms. With 5–10 concurrent jobs, the browser sent dozens of redundant HTTP requests every second, causing repeated SQLite disk reads, JSON re-serialization of multi-megabyte log chunks, and potential network congestion on Wi-Fi LANs.
**Pareo V2's SSE Bus (`GET /api/stream/events`)** establishes a persistent, unidirectional HTTP stream. Output chunks, task status transitions, and ticker counts are pushed reactively from server memory directly to the browser as they occur, reducing HTTP traffic by >95% and eliminating database query churn during streaming.

### Q3: Why is SQLite WAL mode used, and how is it tuned in V2?
Pareo uses SQLite for all persistent states, task history, and library sync caches. In V1, high-concurrency writes during output appending risked database locks. V2 configures:
- `PRAGMA journal_mode = WAL;` (allows concurrent readers and writers without blocking).
- `PRAGMA synchronous = NORMAL;` (maintains database safety while drastically reducing `fsync` syscall overhead).
- `PRAGMA busy_timeout = 5000;` (automatically retries locked transactions up to 5 seconds before raising an error).
- `PRAGMA wal_autocheckpoint = 1000;` (prevents WAL journal file bloat).
- Explicit B-Tree indices on `status`, `queue_name`, and `start_time` to ensure `O(log N)` query speed even with tens of thousands of historical tasks.

---

## Security & Authentication Roadmap

### Q4: What is the authentication architecture in Pareo V2?
Pareo V2 provides enterprise-grade, lightweight authentication and Role-Based Access Control (RBAC):
- **Salted Password Hashing:** User passwords are encrypted using PBKDF2-HMAC-SHA256 with 100,000 iterations and 16-byte cryptographically secure random salts. Verification employs constant-time comparison (`hmac.compare_digest`) to prevent timing side-channel attacks.
- **Session Tokens:** Successful login issues a 32-byte URL-safe session token stored in SQLite (`sessions` table) with configurable TTL (default 48 hours).
- **Flexible Token Extraction:** Endpoints accept tokens via standard `Authorization: Bearer <token>`, custom `X-Pareo-Auth` headers, or query parameter (`?token=`) for EventSource SSE streams.
- **Hierarchical RBAC Roles:**
  - **`Admin`:** Complete administrative authority, user provisioning (`POST /api/auth/register`), batch actions, daemon lifecycle, and system configuration.
  - **`Operator`:** Operational execution, task retries, task cancellation, batch queue manipulation, and utility access.
  - **`Viewer`:** Read-only access to queues, logs, processes, and system telemetry. Mutation attempts are blocked with HTTP 403 Forbidden.
- **Frictionless LAN Fallback:** If zero user accounts exist in the database (initial boot), Pareo operates in frictionless LAN mode, granting full operational access without login prompts.

### Q5: How does Pareo prevent directory traversal attacks?
All filesystem endpoints and command generators validate target paths against configured `allowed_roots` using canonical path resolution (`pathlib.Path.resolve()`) and lexical boundary checking (`os.path.commonpath([root, path]) == root`). Any path attempting to escape via `..` or symbolic link trickery is rejected with HTTP 403. Furthermore, path strings are validated against control characters and length constraints before triggering filesystem syscalls.

---

## UX & Bespoke Themes

### Q6: What are the two bespoke themes featured in Pareo V2?
Pareo V2 replaces generic color themes with two signature, highly immersive aesthetic styles:
1. **"Sony's Wipeout" (`data-theme="wipeout"`):**
   - **Inspiration:** *The Designers Republic* (tDR) iconic graphic design for anti-gravity racing leagues.
   - **Visual Identity:** Sleek anti-gravity racing cockpit HUD, hyper-modern dark obsidian backdrop (`#07090e`), carbon composite surfaces, crisp technical typography (`"Chakra Petch"`, `"Rajdhani"`), chamfered geometric badges, and high-voltage telemetry accents in electric cyan (`#00f0ff`), neon afterburner orange (`#ff5500`), and acid yellow (`#eaff00`).
2. **"Fallout game's Atompunk" (`data-theme="fallout-pipboy"`):**
   - **Inspiration:** RobCo Industries Pip-Boy 3000 Mark IV & retro-futuristic CRT terminals from the *Fallout* universe.
   - **Visual Identity:** Cathode-ray tube phosphor green (`#1aff80`) on deep vacuum tube black/olive (`#050b07`), subtle horizontal CRT scanlines, ambient phosphor bloom glow, analog meters and needle gauges, retro monospace readouts (`"Share Tech Mono"`), and vintage curved bezel framing.

---

## Operational Runbook & Troubleshooting

### T1: How do I recover from an abrupt server crash or reboot?
Pareo handles server reboot gracefully through its automated startup recovery logic (`executor.recover_tasks()`):
- On startup, any task marked as `Running` in SQLite is checked against active OS processes via `os.kill(pid, 0)`.
- If the detached process is still alive in the background (since it was spawned in an independent session group), Pareo lets it finish.
- If the process terminated while the server was down, it is marked `Failed (Interrupted)`.
- All `Pending` tasks that were queued prior to shutdown are automatically restored to their respective FIFO queues in chronological order.

### T2: Why would a task fail to spawn or stay pending?
1. **Queue Concurrency Limit Reached:** Check `config.json` concurrency limits under `queue_settings.concurrency`. By default, `media` allows 1 task, `fs` allows 2, `network` allows 2, and `default` allows 1. Pending tasks will wait until an active worker slot opens.
2. **Orphaned Process Holding Concurrency Slot:** If a task process died without releasing its socket or PID, verify using `ps aux | grep task_runner` and cancel the stuck task via the UI or `POST /api/tasks/{task_id}/cancel`.
3. **Missing System Binaries:** Ensure `ffmpeg`, `ffprobe`, `rsync`, and `ssh` are installed and available in the system `PATH`.

### T3: How do I test the backend and endpoints?
Run pytest in the workspace root:
```bash
pytest -v
```
You can also run smoke tests on individual modules:
```bash
python3 -c "import database; database.init_db(); print('DB Initialized successfully')"
```

---

## Multi-MVP Phased Roadmap Scope

### MVP 1 (Released & Baselined - v2.0.0-mvp1): Foundation, Async Core, Real-Time SSE Engine & Dual Bespoke Themes
- Default binding to 0.0.0.0:9046.
- Frictionless local network access (zero auth barrier).
- Non-blocking asynchronous execution across all endpoints (`run_async_subprocess` / `asyncio.create_subprocess_exec`).
- Database performance tuning (SQLite indices on status/queue/start_time, WAL autocheckpoint).
- Real-time Server-Sent Events (SSE) bus (`GET /api/stream/events`).
- Responsive dual-theme UI featuring "Sony's Wipeout" and "Fallout Atompunk", with mobile card conversion and bottom navigation.
- 44/44 automated tests passing.

### MVP 2 (Released & Baselined - v2.0.0-mvp2): Email Authentication, User Roles, System Telemetry, Batch Controls & Cross-Platform PWA
- Email-based registration, login, session token store, and Role-Based Access Control (`Admin`, `Operator`, `Viewer`).
- Host system telemetry engine (`GET /api/telemetry` & SSE feed: CPU, RAM, disk usage across allowed roots, worker slots).
- Queue health and worker slot saturation gauges.
- Interactive batch queue management (batch cancel, retry, purge) with bottom action dock.
- Task duration analytics and failure breakdown.
- Truly responsive Progressive Web App (PWA) for iOS and Android: Web App Manifest, Service Worker offline caching, safe-area insets (`env(safe-area-inset-*)`), and native install prompt.
- 59/59 automated tests passing.

---

### Q7: How will Progressive Web App (PWA) mode work on iOS and Android in MVP 2?
Pareo V2 in MVP 2 is engineered as a full-fidelity Progressive Web App:
- **On iOS (Safari / WebKit):**
  - Tap the **Share** button and select **"Add to Home Screen"**.
  - Operates in standalone mode without browser URL address bars.
  - Automatically respects iPhone notches, Dynamic Islands, and the bottom home indicator swipe bar via CSS `env(safe-area-inset-top)` and `env(safe-area-inset-bottom)`.
  - Disables rubber-band overscroll collision with terminal logs via `overscroll-behavior-y: contain`.
- **On Android (Chrome):**
  - Tap the in-app **"Install App"** prompt or browser menu **"Install application"**.
  - Maskable adaptive icons adapt to round, squircle, or teardrop launcher grid styles.
  - Supports system navigation gesture insets, translucent system bars, and theme-colored splash screens matching Sony's Wipeout or Fallout Atompunk palettes.
  - Native touch responsiveness (`touch-action: manipulation`) eliminates the 300ms mobile tap delay.

### MVP 3: Virtualized Streaming Terminal & Resilient Process Supervisor
- Virtualized high-performance log terminal handling 100,000+ lines without DOM lag.
- In-terminal regex search, keyword highlighting, log level filtering, and auto-scroll lock.
- Process supervisor enhancements: crash restart policies, backoff delay, port eviction, and SSE live log tailing.

### MVP 4: Resilient Remote Library Synchronization & Declarative DAG Pipelines
- Non-blocking SSH remote library tree scanner with streaming progress.
- Visual sync diff matrix (bidirectional comparison, delta views, conflict markers).
- Declarative multi-stage DAG task pipeline engine (Ingest -> Transcode -> Transfer -> Verify -> Clean).

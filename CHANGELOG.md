# Changelog

All notable changes to the **Pareo Command Engine** project are documented in this file.

---

## [1.3.0] - 2026-07-06
### Added
- **Master Password Security:** Stateless instance lock screen prompting for a master password. If not configured, prompts the user to set a password on first launch.
- **Session Expiration:** Automatic session validation tracking. Authentication tokens expire and clear from browser memory after 2 days of inactivity, prompting for re-authentication.

### Changed
- **Server-side Hashing:** Shifted SHA-256 password hashing from browser to server-side using Python's standard `hashlib`. This resolves browser-enforced security blocks on `crypto.subtle` when accessing Pareo over non-secure LAN connections (HTTP).
- **DOM Initialization Ordering:** Shifted script loading to the bottom of the document and wrapped engine boot scripts in `DOMContentLoaded` listeners to prevent race conditions during modal rendering.
- **Robust Network Interception:** Updated global `window.fetch` wrapper to safely handle plain objects, `Headers` instances, and array inputs without throwing exceptions on third-party browser extensions.

---

## [1.2.0] - 2026-06-25
### Added
- **Directory Path Traversal Restriction:** Strict validation of filesystem actions against configurable lists of permitted root directories (`allowed_roots` locally and remotely) defined in `config.json`.
- **Lexical Path Normalization:** Resolved local symbolic links and canonical paths before execution using `os.path.commonpath` to eliminate bypass vectors.
- **Header Task Count Ticker:** Self-updating status ticker in the top navigation bar indicating count of ongoing and pending queue tasks.
- **Dynamic Poll Interval:** Implemented variable ticker refresh timing: updates every 5 seconds when pending tasks are present, falling back to 1 minute when the queue is clear.

---

## [1.1.0] - 2026-06-20
### Added
- **Parallel Workers Execution:** Parallel scheduler utilizing concurrency settings per queue (`media`, `network`, `fs`, `default`) inside the SQLite runner.
- **Batch Torrent Downloader:** Textarea inputs parsing for Torrent downloader cards, separating multiline inputs and queueing downloads in batches of 5 concurrent jobs.
- **Ubuntu Systemd Service:** Native system-wide service template (`pareo.service`) to run Pareo securely on boot as a background service.
- **macOS PATH Normalization:** Automatic environment prefix injection to SSH tasks to ensure Homebrew executables are found on remote macOS fish shells.

---

## [1.0.0] - 2026-06-10
### Added
- **Task Queue Engine:** Asynchronous task queue runner with queue persistence (SQLite backend) and support for status filtering, task retrying, and graceful process cancellation using process groups.
- **File Explorer Dashboard:** File manager supporting local and remote directory navigation, file sorting, renaming, and batch actions (Copy, Move, Delete, Compress, Remote Copy/Move).
- **Switchboard Utility Console:** Executable card interface displaying configured CLI utilities grouped by categories in horizontal rows.
- **Process Dashboard:** Status monitor and process manager allowing starting, stopping, and viewing logs of sibling engine instances (Numera, Stelata, Papyro).
- **Lifespan Context Management:** Safe backend shutdown handling to terminate background processes and clean ports cleanly.

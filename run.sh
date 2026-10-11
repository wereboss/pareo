#!/bin/sh

# Pareo Launcher
# Compatible with Sh, Bash, Zsh, and Fish
# Default service port: 9046 (Override with PORT environment variable)

# Resolve the root directory of this script to run correctly from anywhere
ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Define the best Python executable
PYTHON_EXEC="python3"

if [ -d "$ROOT_DIR/venv" ]; then
    echo "[*] Found local virtual environment (venv)"
    PYTHON_EXEC="$ROOT_DIR/venv/bin/python3"
elif [ -d "$ROOT_DIR/.venv" ]; then
    echo "[*] Found local virtual environment (.venv)"
    PYTHON_EXEC="$ROOT_DIR/.venv/bin/python3"
fi

# Verify Python is available
if ! command -v "$PYTHON_EXEC" >/dev/null 2>&1; then
    echo "[!] Error: Python 3 could not be found ($PYTHON_EXEC)"
    echo "Please ensure Python 3 is installed."
    exit 1
fi

export PORT="${PORT:-9046}"
echo "[*] Starting Pareo Engine on port $PORT from $ROOT_DIR..."
# Exec replaces the shell process with python
exec "$PYTHON_EXEC" "$ROOT_DIR/run.py"

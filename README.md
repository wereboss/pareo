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
import os
import uvicorn

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 9046))
    print(f"[*] Booting Pareo Engine on 0.0.0.0:{port} (Production Mode)...")
    
    uvicorn.run(
        "server:app", 
        host="0.0.0.0", 
        port=port, 
        workers=1,     # Keeps our asyncio queues in a single memory space
        reload=False   # Saves CPU/RAM by disabling the file watcher
    )

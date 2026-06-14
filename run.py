import uvicorn

if __name__ == "__main__":
    print("[*] Booting Pareo Engine (Production Mode)...")
    
    uvicorn.run(
        "server:app", 
        host="0.0.0.0", 
        port=9025, 
        workers=1,     # Keeps our asyncio queues in a single memory space
        reload=False   # Saves CPU/RAM by disabling the file watcher
    )
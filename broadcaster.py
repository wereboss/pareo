import asyncio
import json
from typing import Set

class Broadcaster:
    """Thread-safe and async-safe SSE broadcaster bus."""
    def __init__(self):
        self._subscribers: Set[asyncio.Queue] = set()
        self._lock = asyncio.Lock()

    async def subscribe(self) -> asyncio.Queue:
        """Registers a new client subscriber queue."""
        queue: asyncio.Queue = asyncio.Queue(maxsize=200)
        async with self._lock:
            self._subscribers.add(queue)
        return queue

    async def unsubscribe(self, queue: asyncio.Queue):
        """Removes a client subscriber queue cleanly."""
        async with self._lock:
            self._subscribers.discard(queue)

    def _publish_event(self, event_type: str, data: dict):
        """Dispatches an SSE formatted payload to all active subscriber queues."""
        payload = f"event: {event_type}\ndata: {json.dumps(data)}\n\n"
        dead_queues = []
        for q in list(self._subscribers):
            try:
                q.put_nowait(payload)
            except asyncio.QueueFull:
                try:
                    # Drop oldest message to prevent client stalling
                    q.get_nowait()
                    q.put_nowait(payload)
                except Exception:
                    dead_queues.append(q)
            except Exception:
                dead_queues.append(q)
                
        for q in dead_queues:
            self._subscribers.discard(q)

    def broadcast_task_update(self, task_id: str, status: str, queue_name: str = "default", start_time: str = ""):
        self._publish_event("task_update", {
            "task_id": task_id,
            "status": status,
            "queue_name": queue_name,
            "start_time": start_time
        })

    def broadcast_task_output(self, task_id: str, chunk: str):
        self._publish_event("task_output", {
            "task_id": task_id,
            "chunk": chunk
        })

    def broadcast_task_counts(self, ongoing: int, pending: int):
        self._publish_event("task_counts", {
            "ongoing": ongoing,
            "pending": pending
        })

# Global singleton broadcaster instance
broadcaster = Broadcaster()

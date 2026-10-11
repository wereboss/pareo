import asyncio
import json
import pytest
from broadcaster import Broadcaster, broadcaster

def test_broadcaster_subscribe_unsubscribe():
    async def run():
        b = Broadcaster()
        queue = await b.subscribe()
        assert queue in b._subscribers
        assert len(b._subscribers) == 1
        
        await b.unsubscribe(queue)
        assert queue not in b._subscribers
        assert len(b._subscribers) == 0
    asyncio.run(run())

def test_broadcast_task_update():
    async def run():
        b = Broadcaster()
        queue = await b.subscribe()
        
        b.broadcast_task_update("task-001", "Running", "media", "2026-10-11T10:00:00")
        
        msg = await asyncio.wait_for(queue.get(), timeout=1.0)
        assert msg.startswith("event: task_update\n")
        data_str = msg.split("data: ")[1].strip()
        data = json.loads(data_str)
        assert data["task_id"] == "task-001"
        assert data["status"] == "Running"
        assert data["queue_name"] == "media"
        assert data["start_time"] == "2026-10-11T10:00:00"
    asyncio.run(run())

def test_broadcast_task_output():
    async def run():
        b = Broadcaster()
        queue = await b.subscribe()
        
        b.broadcast_task_output("task-002", "frame=100 fps=30.0")
        
        msg = await asyncio.wait_for(queue.get(), timeout=1.0)
        assert msg.startswith("event: task_output\n")
        data_str = msg.split("data: ")[1].strip()
        data = json.loads(data_str)
        assert data["task_id"] == "task-002"
        assert data["chunk"] == "frame=100 fps=30.0"
    asyncio.run(run())

def test_broadcast_task_counts():
    async def run():
        b = Broadcaster()
        queue = await b.subscribe()
        
        b.broadcast_task_counts(ongoing=3, pending=7)
        
        msg = await asyncio.wait_for(queue.get(), timeout=1.0)
        assert msg.startswith("event: task_counts\n")
        data_str = msg.split("data: ")[1].strip()
        data = json.loads(data_str)
        assert data["ongoing"] == 3
        assert data["pending"] == 7
    asyncio.run(run())

def test_broadcaster_multiple_subscribers():
    async def run():
        b = Broadcaster()
        q1 = await b.subscribe()
        q2 = await b.subscribe()
        
        b.broadcast_task_counts(ongoing=1, pending=0)
        
        msg1 = await asyncio.wait_for(q1.get(), timeout=1.0)
        msg2 = await asyncio.wait_for(q2.get(), timeout=1.0)
        
        assert "event: task_counts\n" in msg1
        assert "event: task_counts\n" in msg2
    asyncio.run(run())

def test_broadcaster_queue_full_drops_oldest():
    async def run():
        b = Broadcaster()
        queue = await b.subscribe()
        # Fill queue to max capacity
        for i in range(200):
            b.broadcast_task_output("task-full", f"line {i}")
        
        assert queue.full()
        
        # Broadcast one more; should not raise QueueFull error and should drop oldest
        b.broadcast_task_output("task-full", "line 200")
        assert queue.full()
        
        first = await queue.get()
        # Oldest was line 0, dropped, so first is line 1
        assert "line 1" in first
    asyncio.run(run())

def test_singleton_instance():
    assert isinstance(broadcaster, Broadcaster)

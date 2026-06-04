// NEW: Track which tasks have an active, high-speed targeted poll running
const activePolls = new Set();

// Handle Navigation Toggling
function switchTab(event, tabId) {
    document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
    
    document.getElementById(tabId).classList.add('active');
    event.currentTarget.classList.add('active');
}

// Shows a temporary success message next to the button
function showNotification(elementId) {
    const el = document.getElementById(elementId);
    el.style.opacity = '1';
    setTimeout(() => { el.style.opacity = '0'; }, 2000);
}

// Trigger Backend Command
async function executeCommand(cmd) {
    try {
        await fetch(`/api/execute/${cmd}`, { method: 'POST' });
        showNotification('ls-notify');
        fetchTasks(); // Force immediate background refresh
    } catch (error) {
        console.error("Execution failed:", error);
        alert("Failed to connect to the Pareo engine.");
    }
}

// Fetch and Render Tasks
async function fetchTasks() {
    try {
        const response = await fetch('/api/tasks');
        const tasks = await response.json();
        renderTasks(tasks);
    } catch (error) {
        console.error("Failed to fetch tasks:", error);
    }
}


// Updated Render Tasks
function renderTasks(tasks) {
    const tbody = document.querySelector('#tasks-table tbody');
    const taskList = Object.values(tasks).sort((a, b) => new Date(b.start_time) - new Date(a.start_time));

    taskList.forEach(task => {
        let tr = document.getElementById(`row-${task.task_id}`);
        
        let displayData = '';
        if (task.status === 'Failed' && !task.output) displayData = task.error || 'Execution failed.';
        else if (task.output) displayData = task.output; 
        else displayData = '...';

        if (!tr) {
            tr = document.createElement('tr');
            tr.id = `row-${task.task_id}`;
            tr.innerHTML = `
                <td><small>${task.task_id.split('-')[0]}</small></td>
                <td><code>${task.command}</code></td>
                <td><span class="status-badge badge"></span></td>
                <td><pre class="log-output"></pre></td>
            `;
            if (tbody.firstElementChild && !tbody.firstElementChild.id) {
                tbody.firstElementChild.remove();
            }
            tbody.appendChild(tr);
        }

        const badge = tr.querySelector('.status-badge');
        const preElement = tr.querySelector('.log-output');

        badge.className = `status-badge badge ${task.status.toLowerCase()}`;
        badge.textContent = task.status;

        if (preElement.textContent !== displayData) {
            preElement.textContent = displayData;
            if (task.status === 'Running') {
                setTimeout(() => { preElement.scrollTop = preElement.scrollHeight; }, 0);
            }
        }

        // NEW: If the task is running and we aren't already actively polling it, start the targeted poll
        if (task.status === 'Running' && !activePolls.has(task.task_id)) {
            activePolls.add(task.task_id);
            pollSpecificTask(task.task_id);
        }
    });
}

// UPDATE: Trigger FFMPEG Command
async function executeFfmpeg() {
    const inputPath = document.getElementById('ffmpeg-input').value.trim();
    const outputPath = document.getElementById('ffmpeg-output').value.trim();
    // Grab the selected profile
    const profile = document.getElementById('ffmpeg-profile').value; 

    if (!inputPath || !outputPath) {
        alert("Please provide both an input and output path.");
        return;
    }

    try {
        await fetch('/api/execute/ffmpeg', { 
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            // Add the profile to the JSON payload
            body: JSON.stringify({ 
                input_path: inputPath, 
                output_path: outputPath,
                profile: profile
            })
        });
        
        document.getElementById('ffmpeg-input').value = '';
        document.getElementById('ffmpeg-output').value = '';
        
        showNotification('ffmpeg-notify');
        fetchTasks(); 
        
    } catch (error) {
        console.error("Execution failed:", error);
        alert("Failed to queue FFMPEG task.");
    }
}

// NEW FUNCTION: Fetch and populate FFMPEG profiles
async function fetchProfiles() {
    try {
        const response = await fetch('/api/config/ffmpeg');
        const data = await response.json();
        
        const select = document.getElementById('ffmpeg-profile');
        select.innerHTML = ''; // Clear loading text
        
        data.profiles.forEach(profileName => {
            const option = document.createElement('option');
            option.value = profileName;
            option.textContent = profileName;
            select.appendChild(option);
        });
    } catch (error) {
        console.error("Failed to load profiles:", error);
        document.getElementById('ffmpeg-profile').innerHTML = '<option value="Default">Default</option>';
    }
}

// NEW FUNCTION: High-speed asynchronous targeted row update
async function pollSpecificTask(taskId) {
    const row = document.getElementById(`row-${taskId}`);
    if (!row) return;

    try {
        // Fetch only this specific task
        const response = await fetch(`/api/tasks/${taskId}`);
        const task = await response.json();
        
        if (task.error) return;

        const badge = row.querySelector('.status-badge');
        const preElement = row.querySelector('.log-output');

        // Update the badge
        badge.className = `status-badge badge ${task.status.toLowerCase()}`;
        badge.textContent = task.status;

        // Update the log output and handle auto-scroll
        if (preElement.textContent !== task.output) {
            preElement.textContent = task.output || '...';
            if (task.status === 'Running') {
                setTimeout(() => { preElement.scrollTop = preElement.scrollHeight; }, 0);
            }
        }

        // If it's still running, check again in 1 second
        if (task.status === 'Running') {
            setTimeout(() => pollSpecificTask(taskId), 1000);
        } else {
            // Once finished, remove from tracking and do one final global sync
            activePolls.delete(taskId);
            fetchTasks(); 
        }

    } catch (error) {
        console.error(`Failed to poll task ${taskId}:`, error);
    }
}


// Start the polling loop (every 2 seconds)
setInterval(fetchTasks, 150000);
fetchTasks(); // Initial fetch on load

// ADD THIS at the very bottom of app.js (below fetchTasks())
fetchProfiles();
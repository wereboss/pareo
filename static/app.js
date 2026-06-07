// NEW: Track which tasks have an active, high-speed targeted poll running
const activePolls = new Set();
// NEW: Global state to hold the pipeline configuration
let ffmpegConfig = {};

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

// UPDATED: Execute based on the unified API contract
async function executeFfmpeg() {
    const inputTarget = document.getElementById('ffmpeg-input').value.trim();
    const outputTarget = document.getElementById('ffmpeg-output').value.trim();
    const profile = document.getElementById('ffmpeg-profile').value; 
    const mode = document.getElementById('ffmpeg-mode').value;
    // Fallback to .mp4 if the dropdown is somehow empty
    const ext = document.getElementById('ffmpeg-ext').value || '.mp4'; 

    if (!inputTarget || !outputTarget) {
        alert("Please provide both input and output destinations.");
        return;
    }

    try {
        await fetch('/api/execute/ffmpeg', { 
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                input_target: inputTarget, 
                output_target: outputTarget,
                profile: profile,
                mode: mode,
                output_extension: ext
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
        
        ffmpegConfig = data.profiles; // Store the full config object
        
        const select = document.getElementById('ffmpeg-profile');
        select.innerHTML = ''; 
        
        Object.keys(ffmpegConfig).forEach(profileName => {
            const option = document.createElement('option');
            option.value = profileName;
            option.textContent = profileName;
            select.appendChild(option);
        });
        
        onProfileChange(); // Force the UI to shape itself to the first profile
    } catch (error) {
        console.error("Failed to load profiles:", error);
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

// NEW: Handle Profile Selection
function onProfileChange() {
    const profileName = document.getElementById('ffmpeg-profile').value;
    const profileData = ffmpegConfig[profileName];
    if (!profileData) return;

    const modeSelect = document.getElementById('ffmpeg-mode');
    modeSelect.innerHTML = ''; 

    // Only populate modes explicitly permitted by the config
    profileData.modes.forEach(mode => {
        const option = document.createElement('option');
        option.value = mode;
        option.textContent = mode === 'single' ? 'Single File' : 'Batch (Wildcard)';
        modeSelect.appendChild(option);
    });

    updateFfmpegUI(); // Update text labels based on the active mode
}

// NEW: Update text labels and extension constraints
function updateFfmpegUI() {
    const mode = document.getElementById('ffmpeg-mode').value;
    const profileName = document.getElementById('ffmpeg-profile').value;
    const profileData = ffmpegConfig[profileName];
    
    const lblInput = document.getElementById('lbl-ffmpeg-input');
    const inputField = document.getElementById('ffmpeg-input');
    const lblOutput = document.getElementById('lbl-ffmpeg-output');
    const outputField = document.getElementById('ffmpeg-output');
    const extContainer = document.getElementById('batch-ext-container');
    const extSelect = document.getElementById('ffmpeg-ext');

    if (mode === 'batch') {
        lblInput.textContent = "Input Pattern (Wildcard)";
        inputField.placeholder = "/source/media/*.mkv";
        lblOutput.textContent = "Output Directory";
        outputField.placeholder = "/dest/media/";
        
        // Restrict extensions to those defined in config
        extSelect.innerHTML = '';
        if (profileData && profileData.allowed_extensions) {
            profileData.allowed_extensions.forEach(ext => {
                const opt = document.createElement('option');
                opt.value = ext;
                opt.textContent = ext;
                extSelect.appendChild(opt);
            });
        }
        extContainer.style.display = "block";
    } else {
        lblInput.textContent = "Input Path";
        inputField.placeholder = "/path/to/input.mp4";
        lblOutput.textContent = "Output Path";
        outputField.placeholder = "/path/to/output.mkv";
        extContainer.style.display = "none";
    }
}


// Start the polling loop (every 2 seconds)
setInterval(fetchTasks, 150000);
fetchTasks(); // Initial fetch on load

// ADD THIS at the very bottom of app.js (below fetchTasks())
fetchProfiles();
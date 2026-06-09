// NEW: Track which tasks have an active, high-speed targeted poll running
const activePolls = new Set();
// NEW: Global state to hold the pipeline configuration
let ffmpegConfig = {};

// NEW: Helper function to make ISO timestamps human-readable (e.g., Jun 08, 14:30:00)
function formatTime(isoString) {
    if (!isoString) return '--';
    const d = new Date(isoString);
    return d.toLocaleString(undefined, { 
        month: 'short', day: '2-digit', 
        hour: '2-digit', minute: '2-digit', second: '2-digit', 
        hour12: false 
    });
}

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


function renderTasks(tasks) {
    const tbody = document.querySelector('#tasks-table tbody');
    // Ensure chronological sorting by start_time (newest first)
    const taskList = Object.values(tasks).sort((a, b) => new Date(b.start_time) - new Date(a.start_time));

    taskList.forEach(task => {
        let tr = document.getElementById(`row-${task.task_id}`);
        
        let displayData = '';
        if (task.status.includes('Failed') && !task.output) displayData = task.error || 'Execution failed.';
        else if (task.output) displayData = task.output; 
        else displayData = '...';

        const timeHtml = `
            <div><strong>S:</strong> ${formatTime(task.start_time)}</div>
            <div><strong>E:</strong> ${formatTime(task.end_time)}</div>
        `;

        if (!tr) {
            tr = document.createElement('tr');
            tr.id = `row-${task.task_id}`;
            tr.innerHTML = `
                <td><small>${task.task_id.split('-')[0]}</small></td>
                <td class="task-timeline">${timeHtml}</td>
                <td><code>${task.command}</code></td>
                <td><span class="status-badge badge"></span></td>
                <td><pre class="log-output"></pre></td>
            `;
            // Add new rows to the top of the table
            if (tbody.firstElementChild && !tbody.firstElementChild.id) {
                tbody.firstElementChild.remove();
            }
            tbody.appendChild(tr);
        }

        const badge = tr.querySelector('.status-badge');
        const preElement = tr.querySelector('.log-output');

// Update badge dynamically (Handles "Failed (Interrupted)" etc)
        const badgeClass = task.status.split(' ')[0].toLowerCase(); 
        
        let badgeHtml = task.status;
        // Inject the Retry button strictly for failed tasks
        if (task.status.includes('Failed')) {
            badgeHtml += ` <button class="retry-btn" onclick="retryTask('${task.task_id}')" title="Retry Task">↻</button>`;
        }
        
        badge.className = `status-badge badge ${badgeClass}`;
        badge.innerHTML = badgeHtml; // Use innerHTML instead of textContent so the button renders

        // Update output dynamically
        if (preElement.textContent !== displayData) {
            preElement.textContent = displayData;
            if (task.status === 'Running') {
                setTimeout(() => { preElement.scrollTop = preElement.scrollHeight; }, 0);
            }
        }

        if (task.status === 'Running' && !activePolls.has(task.task_id)) {
            activePolls.add(task.task_id);
            pollSpecificTask(task.task_id);
        }
    });
}

// NEW: Global state for File Operations Config
let fsConfig = {};

// Fetch FS Config on load
async function fetchFsConfig() {
    try {
        const response = await fetch('/api/config/fs');
        const data = await response.json();
        fsConfig = data.actions || {};
        
        const select = document.getElementById('fs-action-select');
        Object.keys(fsConfig).forEach(actionName => {
            const opt = document.createElement('option');
            opt.value = actionName;
            opt.textContent = actionName;
            select.appendChild(opt);
        });
    } catch (error) {
        console.error("Failed to load FS config:", error);
    }
}

// -----------------------------------------------------
// FILE EXPLORER MODAL LOGIC
// -----------------------------------------------------

async function openExplorer() {
    const targetPath = document.getElementById('fs-explore-path').value.trim() || '/';
    const modal = document.getElementById('explorer-modal');
    const title = document.getElementById('explorer-title');
    const list = document.getElementById('explorer-list');

    modal.style.display = 'flex'; // Show modal
    title.textContent = `Browsing: ${targetPath}`;
    list.innerHTML = '<div style="padding: 20px; text-align: center; color: #666;">Loading...</div>';

    try {
        const response = await fetch(`/api/fs/list?target_path=${encodeURIComponent(targetPath)}`);
        const data = await response.json();

        if (response.ok) {
            renderExplorerList(data.items);
        } else {
            list.innerHTML = `<div style="padding: 20px; color: #e74c3c;">Error: ${data.detail || 'Could not load directory'}</div>`;
        }
    } catch (error) {
        list.innerHTML = `<div style="padding: 20px; color: #e74c3c;">Connection Error.</div>`;
    }
}

function closeExplorer() {
    document.getElementById('explorer-modal').style.display = 'none';
    // Reset inputs
    document.getElementById('fs-action-select').value = '';
    onFsActionChange(); 
}

function renderExplorerList(items) {
    const list = document.getElementById('explorer-list');
    list.innerHTML = ''; // Clear loading

    if (items.length === 0) {
        list.innerHTML = '<div style="padding: 20px; text-align: center; color: #666;">Directory is empty.</div>';
        return;
    }

    items.forEach(item => {
        const div = document.createElement('div');
        div.className = 'file-item';
        
        const icon = item.is_dir ? '📁' : '📄';
        const sizeStr = item.is_dir ? '' : `(${(item.size / 1024 / 1024).toFixed(2)} MB)`;

        div.innerHTML = `
            <input type="checkbox" class="fs-checkbox" value="${item.path}">
            <span class="file-icon">${icon}</span>
            <span class="file-name">${item.name}</span>
            <span class="file-size">${sizeStr}</span>
        `;
        list.appendChild(div);
    });
}

// Dynamically show/hide destination input based on Config
function onFsActionChange() {
    const action = document.getElementById('fs-action-select').value;
    const destInput = document.getElementById('fs-dest-path');
    
    if (action && fsConfig[action] && fsConfig[action].requires_destination) {
        destInput.style.display = 'block';
    } else {
        destInput.style.display = 'none';
        destInput.value = ''; // clear it so it doesn't accidentally send
    }
}

async function executeFsBatch() {
    const action = document.getElementById('fs-action-select').value;
    const destInput = document.getElementById('fs-dest-path').value.trim();
    
    // Get all checked boxes
    const checkboxes = document.querySelectorAll('.fs-checkbox:checked');
    const sourcePaths = Array.from(checkboxes).map(cb => cb.value);

    if (sourcePaths.length === 0) {
        alert("Please select at least one file or folder.");
        return;
    }
    if (!action) {
        alert("Please select an action to perform.");
        return;
    }
    if (fsConfig[action].requires_destination && !destInput) {
        alert(`The action '${action}' requires a destination path.`);
        return;
    }

    try {
        await fetch('/api/execute/fs', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                action: action,
                source_paths: sourcePaths,
                destination_path: destInput
            })
        });

        closeExplorer();
        showNotification('fs-notify');
        fetchTasks(); // Immediately update the UI queue

    } catch (error) {
        console.error("Execution failed:", error);
        alert("Failed to queue file operations.");
    }
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

async function pollSpecificTask(taskId) {
    const row = document.getElementById(`row-${taskId}`);
    if (!row) return;

    try {
        const response = await fetch(`/api/tasks/${taskId}`);
        const task = await response.json();
        
        if (task.error) return;

        const badge = row.querySelector('.status-badge');
        const preElement = row.querySelector('.log-output');
        const timeline = row.querySelector('.task-timeline');

        const badgeClass = task.status.split(' ')[0].toLowerCase();
        badge.className = `status-badge badge ${badgeClass}`;
        badge.textContent = task.status;

        // NEW: Update the timeline (grabs the end_time the moment it finishes)
        timeline.innerHTML = `
            <div><strong>S:</strong> ${formatTime(task.start_time)}</div>
            <div><strong>E:</strong> ${formatTime(task.end_time)}</div>
        `;

        if (preElement.textContent !== task.output) {
            preElement.textContent = task.output || '...';
            if (task.status === 'Running') {
                setTimeout(() => { preElement.scrollTop = preElement.scrollHeight; }, 0);
            }
        }

        if (task.status === 'Running') {
            setTimeout(() => pollSpecificTask(taskId), 1000);
        } else {
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

// NEW: Trigger the retry API and force a UI refresh
async function retryTask(taskId) {
    try {
        const response = await fetch(`/api/tasks/${taskId}/retry`, { method: 'POST' });
        if (!response.ok) {
            const data = await response.json();
            alert(`Error: ${data.detail}`);
            return;
        }
        fetchTasks(); // Instantly refresh the UI to show it as Pending
    } catch (error) {
        console.error("Retry failed:", error);
    }
}

// NEW: Fetch and populate the global bookmarks datalist
async function fetchBookmarks() {
    try {
        const response = await fetch('/api/config/bookmarks');
        const bookmarks = await response.json();
        
        const datalist = document.getElementById('bookmarks-list');
        datalist.innerHTML = ''; 
        
        Object.entries(bookmarks).forEach(([name, path]) => {
            const option = document.createElement('option');
            option.value = path;
            // The browser will show the name alongside the path in the dropdown
            option.textContent = name; 
            datalist.appendChild(option);
        });
    } catch (error) {
        console.error("Failed to load bookmarks:", error);
    }
}

fetchTasks(); // Initial fetch on load

// ADD THIS at the very bottom of app.js (below fetchTasks())
fetchProfiles();
fetchFsConfig(); // NEW: Load FS Schema
fetchBookmarks(); // NEW: Load the global path shortcuts

// Start the polling loop (every 2 seconds)
setInterval(fetchTasks, 150000);
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
// UPDATED: Bulletproof Tab Switcher
function switchTab(tabId) {
    // 1. Remove 'active' class from ALL navigation buttons
    document.querySelectorAll('.nav-btn').forEach(btn => {
        btn.classList.remove('active');
    });

    // 2. Hide ALL content wrappers
    const tabTasks = document.getElementById('tab-tasks');
    const tabUtils = document.getElementById('tab-utilities');
    if (tabTasks) tabTasks.style.display = 'none';
    if (tabUtils) tabUtils.style.display = 'none';

    // 3. Highlight the clicked button
    const activeBtn = document.getElementById(`btn-${tabId}`);
    if (activeBtn) activeBtn.classList.add('active');

    // 4. Show the targeted content wrapper
    const activeContent = document.getElementById(`tab-${tabId}`);
    if (activeContent) activeContent.style.display = 'block';
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

// NEW: Helper function to safely update the badge DOM only when needed
function updateTaskBadge(badgeElement, task) {
    // Only update the DOM if the status has actually changed
    if (badgeElement.dataset.status !== task.status) {
        let badgeContent = `<span title="${task.status}" style="cursor: help;">${getStatusIcon(task.status)}</span>`;
        
        // Inject the retry button if it failed
        if (task.status.includes('Failed')) {
            badgeContent += `<button class="retry-btn" onclick="retryTask('${task.task_id}')" title="Retry Task">↻</button>`;
        }
        
        // Use Flexbox to force them to sit perfectly side-by-side
        badgeElement.innerHTML = `<div style="display: flex; align-items: center; justify-content: center; gap: 8px;">${badgeContent}</div>`;
        badgeElement.dataset.status = task.status; // Save the state
    }
}

// UPDATED: Map text status to static icons or the CSS spinner
function getStatusIcon(status) {
    if (status.includes('Pending')) return '⏳';
    if (status.includes('Running')) return '<div class="css-spinner"></div>';
    if (status.includes('Completed')) return '✅';
    if (status.includes('Failed')) return '❌';
    return '⏺';
}

// UPDATED: Enforce strict DOM order and render icons
function renderTasks(tasks) {
    const tbody = document.querySelector('#tasks-table tbody');
    
    // Sort chronologically (newest first)
    const taskList = Object.values(tasks).sort((a, b) => new Date(b.start_time) - new Date(a.start_time));

    // Clear "No tasks found" placeholder if it exists
    if (tbody.firstElementChild && !tbody.firstElementChild.id) {
        tbody.firstElementChild.remove();
    }

    taskList.forEach((task, index) => {
        let tr = document.getElementById(`row-${task.task_id}`);
        
        let displayData = '';
        if (task.status.includes('Failed') && !task.output) displayData = task.error || 'Execution failed.';
        else if (task.output) displayData = task.output; 
        else displayData = '...';

        // NEW: Build the Combined Meta Column
        const shortId = task.task_id.split('-')[0];
        const detailsHtml = `
            <div style="font-weight: bold; color: var(--cyan); margin-bottom: 8px;">ID: ${shortId}</div>
            <div class="task-timeline" style="font-size: 0.8em; color: var(--base01); line-height: 1.4;">
                <div><strong style="color: var(--base0);">Started:</strong><br>${formatTime(task.start_time)}</div>
                <div style="margin-top: 5px;"><strong style="color: var(--base0);">Ended:</strong><br>${formatTime(task.end_time)}</div>
            </div>
        `;

        if (!tr) {
            tr = document.createElement('tr');
            tr.id = `row-${task.task_id}`;
            // UPDATED: 4-Column Layout matching index.html, with the output-cell class for the CSS height fix
            tr.innerHTML = `
                <td style="vertical-align: top;">${detailsHtml}</td>
                <td style="vertical-align: top;"><pre style="margin:0; white-space: pre-wrap; word-wrap: break-word;"><code>${task.command}</code></pre></td>
                <td style="vertical-align: top; text-align: center;"><div class="status-badge"></div></td>
                <td class="output-cell" style="vertical-align: top;"><pre class="log-output"></pre></td>
            `;
        }

        // CRITICAL: Enforce exact DOM order without removing/re-adding nodes 
        // (This prevents the scrollbar inside <pre> from jumping)
        if (tbody.children[index] !== tr) {
            tbody.insertBefore(tr, tbody.children[index]);
        }

        const badge = tr.querySelector('.status-badge');
        const preElement = tr.querySelector('.log-output');

        // NEW: Call the helper function
        updateTaskBadge(badge, task);

        // Update output dynamically
        if (preElement.textContent !== displayData) {
            preElement.textContent = displayData;
            if (task.status === 'Running') {
                // Keep scroll anchored to bottom
                setTimeout(() => { preElement.scrollTop = preElement.scrollHeight; }, 0);
            }
        }

        // Trigger high-speed poller if running
        if (task.status === 'Running' && !activePolls.has(task.task_id)) {
            activePolls.add(task.task_id);
            pollSpecificTask(task.task_id);
        }
    });
}

// NEW: Global state for Remote Servers
let remotesConfig = {};

async function fetchRemotesConfig() {
    try {
        const response = await fetch('/api/config/remotes');
        remotesConfig = await response.json();
        
        const serverSelect = document.getElementById('fs-remote-server');
        
        Object.keys(remotesConfig).forEach(serverName => {
            const opt = document.createElement('option');
            opt.value = serverName;
            opt.textContent = serverName;
            serverSelect.appendChild(opt);
        });
    } catch (error) {
        console.error("Failed to load remote servers config:", error);
    }
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

// UPDATED: Dynamically shape-shift the UI and swap datalists
function onFsActionChange() {
    const action = document.getElementById('fs-action-select').value;
    const destInput = document.getElementById('fs-dest-path');
    const remoteSelect = document.getElementById('fs-remote-server');
    
    if (!action || !fsConfig[action]) {
        destInput.style.display = 'none';
        remoteSelect.style.display = 'none';
        return;
    }

    const isRemote = fsConfig[action].requires_remote;
    const requiresDest = fsConfig[action].requires_destination;

    if (isRemote) {
        remoteSelect.style.display = 'block';
        destInput.style.display = 'block';
        destInput.setAttribute('list', 'remote-bookmarks-list'); // Swap to remote bookmarks
        destInput.placeholder = "Remote Target Path...";
        onRemoteServerChange(); // Trigger populate for the first item
    } else if (requiresDest) {
        remoteSelect.style.display = 'none';
        remoteSelect.value = ''; 
        destInput.style.display = 'block';
        destInput.setAttribute('list', 'bookmarks-list'); // Swap back to local bookmarks
        destInput.placeholder = "Destination Path (e.g. /dest/)";
    } else {
        remoteSelect.style.display = 'none';
        destInput.style.display = 'none';
        destInput.value = '';
    }
}

// NEW: Context-aware datalist population
function onRemoteServerChange() {
    const serverName = document.getElementById('fs-remote-server').value;
    const datalist = document.getElementById('remote-bookmarks-list');
    datalist.innerHTML = ''; // Clear previous bookmarks

    if (serverName && remotesConfig[serverName] && remotesConfig[serverName].bookmarks) {
        const bookmarks = remotesConfig[serverName].bookmarks;
        Object.entries(bookmarks).forEach(([name, path]) => {
            const option = document.createElement('option');
            option.value = path;
            option.textContent = name;
            datalist.appendChild(option);
        });
    }
}

async function executeFsBatch() {
    const action = document.getElementById('fs-action-select').value;
    const destInput = document.getElementById('fs-dest-path').value.trim();
    const remoteServer = document.getElementById('fs-remote-server').value; // NEW
    
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
    // NEW: Validation
    if (fsConfig[action].requires_remote && !remoteServer) {
        alert(`The action '${action}' requires a target Remote Server.`);
        return;
    }

    try {
        await fetch('/api/execute/fs', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                action: action,
                source_paths: sourcePaths,
                destination_path: destInput,
                remote_server: remoteServer // NEW
            })
        });

        closeExplorer();
        showNotification('fs-notify');
        fetchTasks(); 

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

// NEW: Switchboard Generation
async function fetchSwitchboardConfig() {
    try {
        const response = await fetch('/api/config/switchboard');
        const config = await response.json();
        const container = document.getElementById('switchboard-container');
        container.innerHTML = '';

        Object.entries(config).forEach(([categoryName, buttons]) => {
            // Create Category Wrapper
            const catDiv = document.createElement('div');
            catDiv.className = 'switchboard-category';
            catDiv.innerHTML = `<h5>${categoryName}</h5>`;
            
            // Create Grid for Buttons
            const gridDiv = document.createElement('div');
            gridDiv.className = 'switchboard-grid';

            Object.keys(buttons).forEach(btnName => {
                const btn = document.createElement('button');
                btn.className = 'btn-switch';
                btn.textContent = btnName;
                // Pass 'this' so the function knows exactly which button to animate
                btn.onclick = function() { fireSwitchboard(categoryName, btnName, this); };
                gridDiv.appendChild(btn);
            });

            catDiv.appendChild(gridDiv);
            container.appendChild(catDiv);
        });
    } catch (error) {
        console.error("Failed to load Switchboard config:", error);
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

        // NEW: Call the helper function
        updateTaskBadge(badge, task);

        // NEW: Update the timeline with Solarized formatting
        if (timeline) {
            timeline.innerHTML = `
                <div><strong style="color: var(--base0);">Started:</strong><br>${formatTime(task.start_time)}</div>
                <div style="margin-top: 5px;"><strong style="color: var(--base0);">Ended:</strong><br>${formatTime(task.end_time)}</div>
            `;
        }

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

async function fetchGenericCards() {
    try {
        const response = await fetch('/api/config/generic_cards');
        const cards = await response.json();
        const container = document.getElementById('generic-cards-container');
        container.innerHTML = '';

        Object.entries(cards).forEach(([cardName, config]) => {
            const cardDiv = document.createElement('div');
            cardDiv.className = 'card';
            
            // Remove spaces for clean HTML IDs
            const safeName = cardName.replace(/\s+/g, '');
            let html = `<h4>${cardName}</h4><form id="form-${safeName}">`;

            // Dynamically generate inputs based on schema
            config.inputs.forEach(input => {
                html += `<div class="input-group" style="margin-bottom: 10px;">`;
                html += `<label style="display: block; margin-bottom: 5px; font-weight: bold; font-size: 0.85em;">${input.label}</label>`;
                
                // If it is a directory type, reuse our existing fs-bookmarks datalist!
                if (input.type === 'directory') {
                    html += `<input type="text" id="${safeName}-${input.id}" name="${input.id}" list="bookmarks-list" autocomplete="off" placeholder="Double-click to view bookmarks..." style="width: 100%; padding: 8px; border: 1px solid var(--border); border-radius: 4px; box-sizing: border-box;" required>`;
                } else {
                    html += `<input type="text" id="${safeName}-${input.id}" name="${input.id}" style="width: 100%; padding: 8px; border: 1px solid var(--border); border-radius: 4px; box-sizing: border-box;" required>`;
                }
                html += `</div>`;
            });

            html += `<button type="submit" class="btn-primary" style="margin-top: 10px; width: 100%; padding: 10px; background: #2ecc71; color: white; border: none; border-radius: 4px; cursor: pointer; font-weight: bold;">Queue Task</button>`;
            html += `</form>`;
            
            cardDiv.innerHTML = html;
            container.appendChild(cardDiv);

            // Attach Submission Event Listener
            const formElement = cardDiv.querySelector('form');
            formElement.onsubmit = function(e) {
                e.preventDefault();
                fireGenericTask(cardName, safeName, formElement, config.inputs);
            };
        });
    } catch (error) {
        console.error("Failed to load Generic Cards:", error);
    }
}

// NEW: Switchboard Execution
async function fireSwitchboard(category, btnName, btnElement) {
    // 1. Lock the button and show spinner
    const originalText = btnElement.textContent;
    btnElement.disabled = true;
    btnElement.innerHTML = `<div class="css-spinner"></div>`;

    try {
        const response = await fetch('/api/execute/switchboard', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ category: category, button_name: btnName })
        });

        const data = await response.json();

        // 2. Handle Success or Failure UI
        if (response.ok) {
            btnElement.classList.add('success');
            btnElement.innerHTML = `✅`;
            
            // NEW: Populate and open the Result Modal
            document.getElementById('sb-modal-title').textContent = `${btnName} Result`;
            document.getElementById('sb-modal-output').textContent = data.message;
            document.getElementById('switchboard-modal').style.display = 'flex';
            
        } else {
            btnElement.classList.add('error');
            btnElement.innerHTML = `❌`;
            console.error(`[Switchboard Error]: ${data.detail}`);
            alert(`Error: ${data.detail}`);
        }
    } catch (error) {
        btnElement.classList.add('error');
        btnElement.innerHTML = `❌`;
        console.error("Switchboard execution failed:", error);
    } finally {
        // 3. Revert back to normal state after 2 seconds
        setTimeout(() => {
            btnElement.classList.remove('success', 'error');
            btnElement.innerHTML = originalText;
            btnElement.disabled = false;
        }, 2000);
    }
}

// NEW: Execute Generic Task
async function fireGenericTask(cardName, safeName, formElement, schemaInputs) {
    const submitBtn = formElement.querySelector('button');
    const originalText = submitBtn.textContent;
    submitBtn.disabled = true;
    submitBtn.innerHTML = '<div class="css-spinner" style="border-top-color: #fff;"></div>'; 

    // Gather inputs into a dictionary
    const inputsData = {};
    schemaInputs.forEach(input => {
        const field = document.getElementById(`${safeName}-${input.id}`);
        inputsData[input.id] = field.value;
    });

    try {
        const response = await fetch('/api/execute/generic', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                card_name: cardName,
                inputs: inputsData
            })
        });

        const data = await response.json();

        if (response.ok) {
            submitBtn.style.background = '#27ae60';
            submitBtn.textContent = `Queued (ID: ${data.task_id.split('-')[0]})`;
            formElement.reset(); 
            
            // Force the task list to update immediately and switch tabs
            fetchTasks();
            setTimeout(() => switchTab('tasks'), 600); 
        } else {
            alert(`Error: ${data.detail}`);
            submitBtn.style.background = '#e74c3c';
            submitBtn.textContent = 'Failed';
        }
    } catch (error) {
        console.error("Generic execution failed:", error);
        submitBtn.style.background = '#e74c3c';
        submitBtn.textContent = 'Error';
    } finally {
        setTimeout(() => {
            submitBtn.disabled = false;
            submitBtn.style.background = '#2ecc71';
            submitBtn.textContent = originalText;
        }, 3000);
    }
}

// NEW: Close the Switchboard Result Modal
function closeSwitchboardModal() {
    document.getElementById('switchboard-modal').style.display = 'none';
}

fetchTasks(); // Initial fetch on load

// ADD THIS at the very bottom of app.js (below fetchTasks())
fetchProfiles();
fetchFsConfig(); // NEW: Load FS Schema
fetchBookmarks(); // NEW: Load the global path shortcuts
fetchRemotesConfig(); // NEW: Load remote servers
fetchSwitchboardConfig();
fetchGenericCards();
switchTab('tasks'); // NEW: Force the UI to sync and show tasks on load
// Start the polling loop (every 2 seconds)
setInterval(fetchTasks, 150000);
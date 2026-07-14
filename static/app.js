// Helper to retrieve the auth token, clearing it if it exceeds 2 days (session age)
function getAuthToken() {
    const token = localStorage.getItem('pareo_auth_token');
    const timestamp = localStorage.getItem('pareo_auth_timestamp');
    if (!token) return null;
    
    if (timestamp) {
        const ageMs = Date.now() - parseInt(timestamp, 10);
        const twoDaysMs = 2 * 24 * 60 * 60 * 1000;
        if (ageMs > twoDaysMs) {
            console.log("[Pareo Auth] Session expired (older than 2 days). Clearing token.");
            localStorage.removeItem('pareo_auth_token');
            localStorage.removeItem('pareo_auth_timestamp');
            return null;
        }
    } else {
        // If there's a token but no timestamp (e.g. from prior setup), set it now
        localStorage.setItem('pareo_auth_timestamp', Date.now().toString());
    }
    return token;
}

// Global fetch override for transparent auth handling
const originalFetch = window.fetch;
window.fetch = async function (url, options) {
    const token = getAuthToken();
    
    if (token) {
        let opt = options || {};
        if (opt.headers instanceof Headers) {
            opt.headers.set('X-Pareo-Auth', token);
        } else if (Array.isArray(opt.headers)) {
            opt.headers.push(['X-Pareo-Auth', token]);
        } else {
            opt.headers = opt.headers || {};
            opt.headers['X-Pareo-Auth'] = token;
        }
        options = opt;
    }
    
    const response = await originalFetch(url, options);
    if (response.status === 401) {
        showAuthOverlay('login');
    }
    return response;
};

// NEW: Track which tasks have an active, high-speed targeted poll running
const activePolls = new Set();
// NEW: Global state to hold the pipeline configuration
let ffmpegConfig = {};

// NEW: Global loading progress bar control
function showLoading(percent = 30) {
    const bar = document.getElementById('global-loading-bar');
    if (!bar) return;
    bar.style.opacity = '1';
    bar.style.width = percent + '%';
}

function hideLoading() {
    const bar = document.getElementById('global-loading-bar');
    if (!bar) return;
    bar.style.width = '100%';
    setTimeout(() => {
        bar.style.opacity = '0';
        setTimeout(() => {
            bar.style.width = '0%';
        }, 300);
    }, 200);
}

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
let processPollInterval = null;

function switchTab(tabId) {
    // 1. Remove 'active' class from ALL navigation buttons
    document.querySelectorAll('.nav-btn').forEach(btn => {
        btn.classList.remove('active');
    });

    // 2. Hide ALL content wrappers
    const tabTasks = document.getElementById('tab-tasks');
    const tabUtils = document.getElementById('tab-utilities');
    const tabLibs = document.getElementById('tab-libraries');
    if (tabTasks) tabTasks.style.display = 'none';
    if (tabUtils) tabUtils.style.display = 'none';
    if (tabLibs) tabLibs.style.display = 'none';

    // 3. Highlight the clicked button
    const activeBtn = document.getElementById(`btn-${tabId}`);
    if (activeBtn) activeBtn.classList.add('active');

    // 4. Show the targeted content wrapper
    const activeContent = document.getElementById(`tab-${tabId}`);
    if (activeContent) activeContent.style.display = 'block';

    // Monitor processes dynamically when in Utilities tab
    if (tabId === 'utilities') {
        fetchProcessStatuses();
        if (!processPollInterval) {
            processPollInterval = setInterval(fetchProcessStatuses, 5000);
        }
    } else {
        if (processPollInterval) {
            clearInterval(processPollInterval);
            processPollInterval = null;
        }
    }
    
    if (tabId === 'libraries') {
        fetchLibrariesList();
    }
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

// NEW: Global state for tasks pagination
let loadedTasks = {};
let tasksOffset = 0;
const tasksLimit = 15;
let hasMoreTasks = true;

// Fetch and Render Tasks with Pagination and Filters
async function fetchTasks(offset = 0) {
    showLoading(40);
    try {
        const queueVal = document.getElementById('filter-queue')?.value || '';
        const statusVal = document.getElementById('filter-status')?.value || '';
        const commandVal = document.getElementById('filter-command')?.value || '';
        
        let url = `/api/tasks?limit=${tasksLimit}&offset=${offset}`;
        if (queueVal) url += `&queue=${encodeURIComponent(queueVal)}`;
        if (statusVal) url += `&status=${encodeURIComponent(statusVal)}`;
        if (commandVal) url += `&command=${encodeURIComponent(commandVal)}`;
        
        const response = await fetch(url);
        const newTasks = await response.json();
        const newTasksCount = Object.keys(newTasks).length;
        
        if (offset === 0) {
            // Keep first page logs if they were lazy-loaded
            const preservedLogs = {};
            Object.keys(loadedTasks).forEach(tid => {
                if (loadedTasks[tid].output) {
                    preservedLogs[tid] = loadedTasks[tid].output;
                }
            });
            
            loadedTasks = newTasks;
            
            Object.keys(loadedTasks).forEach(tid => {
                if (preservedLogs[tid]) {
                    loadedTasks[tid].output = preservedLogs[tid];
                }
            });
            
            tasksOffset = 0;
        } else {
            // Append next page
            Object.assign(loadedTasks, newTasks);
            tasksOffset = offset;
        }
        
        hasMoreTasks = newTasksCount === tasksLimit;
        renderTasks(loadedTasks);
        updateTaskTicker();
        
        const loadMoreContainer = document.getElementById('tasks-load-more-container');
        if (loadMoreContainer) {
            loadMoreContainer.style.display = hasMoreTasks ? 'block' : 'none';
        }
    } catch (error) {
        console.error("Failed to fetch tasks:", error);
    } finally {
        hideLoading();
    }
}

async function loadMoreTasks() {
    const nextOffset = tasksOffset + tasksLimit;
    const btn = document.getElementById('btn-load-more-tasks');
    if (btn) {
        btn.disabled = true;
        btn.textContent = "Loading...";
    }
    await fetchTasks(nextOffset);
    if (btn) {
        btn.disabled = false;
        btn.textContent = "Load More Tasks";
    }
}

async function lazyLoadTaskOutput(taskId, btn) {
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = `<div class="css-spinner" style="border-top-color: var(--cyan); width: 12px; height: 12px; display: inline-block; margin-right: 5px;"></div> Loading...`;
    }
    try {
        const response = await fetch(`/api/tasks/${taskId}`);
        const task = await response.json();
        if (task && !task.error) {
            if (loadedTasks[taskId]) {
                loadedTasks[taskId].output = task.output;
            }
            const row = document.getElementById(`row-${taskId}`);
            const preElement = row?.querySelector('.log-output');
            if (preElement) {
                preElement.textContent = task.output || '(No log output)';
            }
        }
    } catch (error) {
        console.error("Failed to lazy load task output:", error);
        if (btn) {
            btn.disabled = false;
            btn.textContent = "📄 Retry Loading";
        }
    }
}

// NEW: Helper function to safely update the badge DOM only when needed
function updateTaskBadge(badgeElement, task) {
    // Only update the DOM if the status has actually changed
    if (badgeElement.dataset.status !== task.status) {
        let badgeContent = `<span title="${task.status}" style="cursor: help;">${getStatusIcon(task.status)}</span>`;
        
        // Inject the cancel button if pending or running
        if (task.status === 'Running' || task.status === 'Pending') {
            badgeContent += `<button class="cancel-btn" onclick="cancelTask('${task.task_id}')" title="Cancel Task">🛑</button>`;
        }
        
        // Inject the retry button if failed, interrupted, or cancelled
        if (task.status.includes('Failed') || task.status.includes('Interrupted') || task.status === 'Cancelled') {
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
    if (status.includes('Cancelled')) return '🚫';
    return '⏺';
}

// UPDATED: Enforce strict DOM order, prune removed tasks, and support empty placeholders
function renderTasks(tasks) {
    const tbody = document.querySelector('#tasks-table tbody');
    
    // Sort chronologically (newest first)
    const taskList = Object.values(tasks).sort((a, b) => new Date(b.start_time) - new Date(a.start_time));

    // Clear "No tasks found" placeholder if it exists
    if (tbody.firstElementChild && !tbody.firstElementChild.id) {
        tbody.firstElementChild.remove();
    }

    if (taskList.length === 0) {
        tbody.innerHTML = `<tr><td colspan="4" style="text-align: center; color: var(--base01); padding: 30px;">No tasks found matching the selected filters.</td></tr>`;
        return;
    }

    taskList.forEach((task, index) => {
        let tr = document.getElementById(`row-${task.task_id}`);
        
        let displayData = '';
        if (task.status.includes('Failed') && !task.output) displayData = task.error || 'Execution failed.';
        else if (task.output) displayData = task.output; 
        else displayData = '...';

        // NEW: Build the Combined Meta Column
        const shortId = task.task_id.split('-')[0];
        let queueBadge = '';
        if (task.queue_name) {
            queueBadge = `<div style="margin-top: 5px;"><strong style="color: var(--base0);">Queue:</strong> <span style="color: var(--cyan); text-transform: uppercase; font-size: 0.9em; font-weight: bold;">${task.queue_name}</span></div>`;
        }

        const detailsHtml = `
            <div style="font-weight: bold; color: var(--cyan); margin-bottom: 8px;">ID: ${shortId}</div>
            <div class="task-timeline" style="font-size: 0.8em; color: var(--base01); line-height: 1.4;">
                <div><strong style="color: var(--base0);">Started:</strong><br>${formatTime(task.start_time)}</div>
                <div style="margin-top: 5px;"><strong style="color: var(--base0);">Ended:</strong><br>${formatTime(task.end_time)}</div>
                ${queueBadge}
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
        } else {
            // Update details block dynamically in case of status/queue changes
            const detailsCell = tr.firstElementChild;
            if (detailsCell) {
                detailsCell.innerHTML = detailsHtml;
            }
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

        // Update output dynamically (lazy loading for completed/failed tasks)
        if (task.status !== 'Running' && !task.output) {
            if (!preElement.querySelector('.btn-lazy-load')) {
                preElement.innerHTML = `<button class="btn btn-sm btn-lazy-load" onclick="lazyLoadTaskOutput('${task.task_id}', this)" style="background: var(--base02); color: var(--cyan); border: 1px solid var(--base01); padding: 4px 10px; font-size: 0.85em; cursor: pointer; border-radius: 4px; display: inline-flex; align-items: center; gap: 6px;">📄 View Logs</button>`;
            }
        } else {
            if (preElement.textContent !== displayData || preElement.querySelector('.btn-lazy-load')) {
                preElement.textContent = displayData;
                if (task.status === 'Running') {
                    // Keep scroll anchored to bottom
                    setTimeout(() => { preElement.scrollTop = preElement.scrollHeight; }, 0);
                }
            }
        }

        // Trigger high-speed poller if running
        if (task.status === 'Running' && !activePolls.has(task.task_id)) {
            activePolls.add(task.task_id);
            pollSpecificTask(task.task_id);
        }
    });

    // Remove extra rows in the DOM that are no longer in the current page/filter list
    while (tbody.children.length > taskList.length) {
        tbody.lastElementChild.remove();
    }
}

// NEW: Global state for Remote Servers
let remotesConfig = {};

async function fetchRemotesConfig() {
    try {
        const response = await fetch('/api/config/remotes');
        remotesConfig = await response.json();
        
        const serverSelect = document.getElementById('fs-remote-server');
        const exploreSelect = document.getElementById('fs-explore-server');
        
        Object.keys(remotesConfig).forEach(serverName => {
            const opt = document.createElement('option');
            opt.value = serverName;
            opt.textContent = serverName;
            serverSelect.appendChild(opt);
            
            if (exploreSelect) {
                const optExp = document.createElement('option');
                optExp.value = serverName;
                optExp.textContent = serverName;
                exploreSelect.appendChild(optExp);
            }
        });
    } catch (error) {
        console.error("Failed to load remote servers config:", error);
    }
}

async function onExploreServerChange() {
    const serverName = document.getElementById('fs-explore-server').value;
    const pathInput = document.getElementById('fs-explore-path');
    
    // Clear and reload datalist options based on selected host (Local vs Remote)
    const datalist = document.getElementById('bookmarks-list');
    datalist.innerHTML = '';
    
    if (serverName) {
        // Load Remote Bookmarks
        const serverConfig = remotesConfig[serverName];
        if (serverConfig && serverConfig.bookmarks) {
            const bookmarks = serverConfig.bookmarks;
            Object.entries(bookmarks).forEach(([name, path]) => {
                const opt = document.createElement('option');
                opt.value = path;
                opt.textContent = name;
                datalist.appendChild(opt);
            });
            // Set default value to first bookmark path or "/"
            const firstPath = Object.values(bookmarks)[0] || '/';
            pathInput.value = firstPath;
        } else {
            pathInput.value = '/';
        }
    } else {
        // Load Local Bookmarks
        await fetchBookmarks();
        pathInput.value = '/';
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
    const remoteServer = document.getElementById('fs-explore-server').value;
    const targetPath = document.getElementById('fs-explore-path').value.trim() || '/';
    const modal = document.getElementById('explorer-modal');
    const title = document.getElementById('explorer-title');
    const list = document.getElementById('explorer-list');

    modal.style.display = 'flex'; // Show modal
    title.textContent = `Browsing ${remoteServer ? remoteServer : 'Local'}: ${targetPath}`;
    list.innerHTML = '<div style="padding: 20px; text-align: center; color: #666;">Loading...</div>';

    try {
        const response = await fetch(`/api/fs/list?target_path=${encodeURIComponent(targetPath)}&remote_server=${encodeURIComponent(remoteServer)}`);
        const data = await response.json();

        if (response.ok) {
            document.getElementById('fs-explore-path').value = data.target_path;
            title.textContent = `Browsing ${remoteServer ? remoteServer : 'Local'}: ${data.target_path}`;
            renderExplorerList(data.items, data.parent_path);
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

function browseToFolder(path) {
    document.getElementById('fs-explore-path').value = path;
    openExplorer();
}

function renderExplorerList(items, parentPath) {
    const list = document.getElementById('explorer-list');
    list.innerHTML = ''; // Clear loading

    // Prepend parent directory navigation row
    if (parentPath) {
        const pDiv = document.createElement('div');
        pDiv.className = 'file-item parent-dir-item';
        pDiv.style.cursor = 'pointer';
        pDiv.onclick = () => browseToFolder(parentPath);
        
        pDiv.innerHTML = `
            <input type="checkbox" class="fs-checkbox" style="visibility: hidden; margin-right: 15px;">
            <span class="file-icon">📁</span>
            <span class="file-name" style="font-weight: bold; color: var(--cyan);">.. (Parent Directory)</span>
            <span class="file-size"></span>
            <div class="file-actions" style="display: flex; gap: 8px;">
                <button class="action-icon-btn" title="Go Up" style="pointer-events: none;">📂</button>
            </div>
        `;
        list.appendChild(pDiv);
    }

    if (items.length === 0 && !parentPath) {
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
            <span class="file-size" style="margin-right: 15px; color: var(--base01);">${sizeStr}</span>
        `;
        
        // Actions Container
        const actionsDiv = document.createElement('div');
        actionsDiv.className = 'file-actions';
        actionsDiv.style.display = 'flex';
        actionsDiv.style.gap = '8px';

        // Add Browse button for directories
        if (item.is_dir) {
            const browseBtn = document.createElement('button');
            browseBtn.className = 'action-icon-btn';
            browseBtn.innerHTML = '📂';
            browseBtn.title = 'Browse Directory';
            browseBtn.onclick = (e) => {
                e.stopPropagation();
                browseToFolder(item.path);
            };
            actionsDiv.appendChild(browseBtn);
        }

        // Add Rename button
        const renameBtn = document.createElement('button');
        renameBtn.className = 'action-icon-btn';
        renameBtn.innerHTML = '✏️';
        renameBtn.title = 'Rename';
        renameBtn.onclick = (e) => {
            e.stopPropagation();
            renameExplorerItem(item.path, item.name);
        };
        actionsDiv.appendChild(renameBtn);

        div.appendChild(actionsDiv);
        list.appendChild(div);
    });
}

async function renameExplorerItem(path, oldName) {
    const newName = prompt(`Enter new name for "${oldName}":`, oldName);
    if (!newName || newName.trim() === "" || newName === oldName) {
        return;
    }
    
    const remoteServer = document.getElementById('fs-explore-server').value;
    try {
        const response = await fetch('/api/fs/rename', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                source_path: path,
                new_name: newName.trim(),
                remote_server: remoteServer
            })
        });
        
        const data = await response.json();
        if (response.ok) {
            openExplorer(); // Refresh directory listing
        } else {
            alert(`Error: ${data.detail}`);
        }
    } catch (error) {
        console.error("Rename failed:", error);
        alert("Failed to connect to the Pareo engine.");
    }
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
    const sourceServer = document.getElementById('fs-explore-server').value; // NEW
    
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
                remote_server: remoteServer, // NEW: Target server for local-to-remote
                source_server: sourceServer   // NEW: Source server of selected files
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

// NEW: Trigger the cancel API and force a UI refresh
async function cancelTask(taskId) {
    if (!confirm("Are you sure you want to cancel this task?")) {
        return;
    }
    try {
        const response = await fetch(`/api/tasks/${taskId}/cancel`, { method: 'POST' });
        if (!response.ok) {
            const data = await response.json();
            alert(`Error: ${data.detail}`);
            return;
        }
        fetchTasks(); // Instantly refresh the UI
    } catch (error) {
        console.error("Cancel failed:", error);
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
                } else if (input.type === 'textarea') {
                    html += `<textarea id="${safeName}-${input.id}" name="${input.id}" rows="4" placeholder="Paste links here..." style="width: 100%; padding: 8px; border: 1px solid var(--border); border-radius: 4px; box-sizing: border-box;" required></textarea>`;
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
            if (data.task_id) {
                submitBtn.textContent = `Queued (ID: ${data.task_id.split('-')[0]})`;
            } else {
                submitBtn.textContent = `Queued (${data.queued_count || 'Multi'} Tasks)`;
            }
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

// NEW: Filter Handlers for Tasks Queue
let filterDebounceTimeout = null;

function applyFilters() {
    loadedTasks = {}; // Clear loaded cache
    fetchTasks(0);    // Start fetch from offset 0
}

function applyFiltersWithDebounce() {
    if (filterDebounceTimeout) {
        clearTimeout(filterDebounceTimeout);
    }
    filterDebounceTimeout = setTimeout(() => {
        applyFilters();
    }, 300); // 300ms debounce
}

function clearFilters() {
    const queueFilter = document.getElementById('filter-queue');
    const statusFilter = document.getElementById('filter-status');
    const commandFilter = document.getElementById('filter-command');
    
    if (queueFilter) queueFilter.value = '';
    if (statusFilter) statusFilter.value = '';
    if (commandFilter) commandFilter.value = '';
    
    applyFilters();
}

async function purgeTasks() {
    const ageSelect = document.getElementById('purge-age');
    if (!ageSelect) return;
    const age = ageSelect.value;
    
    let confirmationMsg = `Are you sure you want to purge tasks older than ${ageSelect.options[ageSelect.selectedIndex].text}?`;
    if (age === 'all') {
        confirmationMsg = "Are you sure you want to purge the ENTIRE tasks queue history? (This will NOT affect active Pending or Running tasks)";
    }
    
    if (!confirm(confirmationMsg)) {
        return;
    }
    
    try {
        const response = await fetch(`/api/tasks/purge?age=${age}`, { method: 'POST' });
        const data = await response.json();
        if (response.ok) {
            alert(data.message);
            applyFilters(); // Instantly refresh the tasks list
        } else {
            alert(`Error: ${data.detail}`);
        }
    } catch (error) {
        console.error("Purge failed:", error);
        alert("Failed to connect to the Pareo engine.");
    }
}

// --- TASK TICKER LOGIC ---
let tickerTimeout = null;

async function updateTaskTicker() {
    try {
        const response = await fetch('/api/tasks/counts');
        if (!response.ok) return;
        const data = await response.json();
        
        const tickerBadge = document.getElementById('task-ticker');
        const tickerDot = document.getElementById('ticker-dot');
        const tickerText = document.getElementById('ticker-text');
        
        if (!tickerBadge || !tickerText) return;
        
        const ongoing = data.ongoing || 0;
        const pending = data.pending || 0;
        
        tickerText.textContent = `Ongoing: ${ongoing} | Pending: ${pending}`;
        
        if (ongoing > 0 || pending > 0) {
            tickerBadge.classList.add('active');
            if (tickerDot) {
                tickerDot.className = 'ticker-dot active';
            }
        } else {
            tickerBadge.classList.remove('active');
            if (tickerDot) {
                tickerDot.className = 'ticker-dot idle';
            }
        }
        
        // Exact requirement: 5s refresh when there are pending tasks, 1min (60s) refresh when there are no pending tasks.
        const nextInterval = pending > 0 ? 5000 : 60000;
        
        if (tickerTimeout) clearTimeout(tickerTimeout);
        tickerTimeout = setTimeout(updateTaskTicker, nextInterval);
        
    } catch (error) {
        console.error("Failed to update task ticker:", error);
        if (tickerTimeout) clearTimeout(tickerTimeout);
        tickerTimeout = setTimeout(updateTaskTicker, 15000);
    }
}

let currentAuthMode = 'login'; // 'login' or 'setup'

function showAuthOverlay(mode) {
    console.log("[Pareo Auth] showAuthOverlay called with mode:", mode);
    currentAuthMode = mode;
    const overlay = document.getElementById('auth-overlay');
    const title = document.getElementById('auth-title');
    const desc = document.getElementById('auth-desc');
    const errorMsg = document.getElementById('auth-error');
    const passInput = document.getElementById('auth-password');
    
    console.log("[Pareo Auth] DOM Elements: overlay=", overlay, "title=", title, "desc=", desc, "errorMsg=", errorMsg, "passInput=", passInput);
    if (!overlay) {
        console.error("[Pareo Auth] CRITICAL: auth-overlay element not found in DOM!");
        return;
    }
    
    errorMsg.style.display = 'none';
    passInput.value = '';
    
    if (mode === 'setup') {
        title.textContent = "Secure Your Instance";
        desc.textContent = "Set a Master Password to lock down the Pareo engine.";
        passInput.placeholder = "Enter new master password";
    } else {
        title.textContent = "Authentication Required";
        desc.textContent = "Enter your master password to access Pareo.";
        passInput.placeholder = "Password";
    }
    
    overlay.style.display = 'flex';
    passInput.focus();
}

async function handleAuthSubmit(event) {
    event.preventDefault();
    const password = document.getElementById('auth-password').value;
    const errorMsg = document.getElementById('auth-error');
    
    if (!password) return;
    
    try {
        if (currentAuthMode === 'setup') {
            const res = await originalFetch('/api/auth/setup', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ password: password })
            });
            const data = await res.json();
            if (res.ok && data.token) {
                localStorage.setItem('pareo_auth_token', data.token);
                localStorage.setItem('pareo_auth_timestamp', Date.now().toString());
                document.getElementById('auth-overlay').style.display = 'none';
                initApp();
            } else {
                errorMsg.textContent = data.detail || "Setup failed.";
                errorMsg.style.display = 'block';
            }
        } else {
            const res = await originalFetch('/api/auth/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ password: password })
            });
            const data = await res.json();
            if (res.ok && data.token) {
                localStorage.setItem('pareo_auth_token', data.token);
                localStorage.setItem('pareo_auth_timestamp', Date.now().toString());
                document.getElementById('auth-overlay').style.display = 'none';
                initApp();
            } else {
                errorMsg.textContent = data.detail || "Incorrect password.";
                errorMsg.style.display = 'block';
            }
        }
    } catch (e) {
        errorMsg.textContent = "Network error. Try again.";
        errorMsg.style.display = 'block';
    }
}

function logout() {
    localStorage.removeItem('pareo_auth_token');
    localStorage.removeItem('pareo_auth_timestamp');
    window.location.reload();
}

async function initApp() {
    console.log("[Pareo Auth] initApp() verifying session state...");
    try {
        const response = await fetch('/api/auth/verify');
        const data = await response.json();
        console.log("[Pareo Auth] /api/auth/verify response data:", data);
        const lockBtn = document.getElementById('btn-lock');
        
        if (data.status === 'setup_needed') {
            console.log("[Pareo Auth] Routing user to master password setup overlay.");
            if (lockBtn) lockBtn.style.display = 'none';
            showAuthOverlay('setup');
            return;
        } else if (data.status === 'unauthorized') {
            console.log("[Pareo Auth] Routing user to login overlay.");
            if (lockBtn) lockBtn.style.display = 'none';
            showAuthOverlay('login');
            return;
        }
        
        console.log("[Pareo Auth] Client authorized. Displaying lock button.");
        if (lockBtn) lockBtn.style.display = 'inline-flex';
        
    } catch (error) {
        console.error("[Pareo Auth] Verify check failed:", error);
    }
    
    console.log("[Pareo Auth] Session verified/bypassed. Loading page cards and queues...");
    // Auth is verified or disabled, load the app
    fetchTasks(0);
    updateTaskTicker();
    fetchProfiles();
    fetchFsConfig();
    fetchBookmarks();
    fetchRemotesConfig();
    fetchSwitchboardConfig();
    fetchGenericCards();
    fetchProcessConfig();
    switchTab('tasks');
}

window.addEventListener('DOMContentLoaded', () => {
    initApp();
});

// Start the polling loop (every 2.5 minutes)
setInterval(() => {
    const authOverlay = document.getElementById('auth-overlay');
    if (!authOverlay || authOverlay.style.display === 'none') {
        fetchTasks(0);
    }
}, 150000);

// --- PROCESS MONITORING LOGIC ---
let processConfig = {};
let activeLogProcess = null;
let logRefreshInterval = null;

async function fetchProcessConfig() {
    try {
        const response = await fetch('/api/config/processes');
        processConfig = await response.json();
        renderProcessListPlaceholder();
        
        // Only fetch statuses on load if we are on the utilities tab
        const activeTabBtn = document.querySelector('.nav-btn.active');
        if (activeTabBtn && activeTabBtn.id === 'btn-utilities') {
            fetchProcessStatuses();
        }
    } catch (error) {
        console.error("Failed to fetch process configuration:", error);
    }
}

function renderProcessListPlaceholder() {
    const container = document.getElementById('process-list');
    if (!container) return;
    
    if (Object.keys(processConfig).length === 0) {
        container.innerHTML = `<p style="color: #999; font-style: italic; font-size: 0.9em;">No processes configured in config.json.</p>`;
        return;
    }
    
    let html = '';
    for (const [name, info] of Object.entries(processConfig)) {
        const safeName = name.replace(/[^a-zA-Z0-9]/g, '-');
        html += `
            <div class="process-card" id="proc-card-${safeName}" style="border: 1px solid var(--base01) !important; padding: 12px; border-radius: 6px; display: flex; flex-direction: column; gap: 8px; background: var(--base03) !important; color: var(--base0) !important;">
                <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 10px;">
                    <div>
                        <strong style="font-size: 1.05em; color: var(--cyan);">${name}</strong>
                        <span style="font-size: 0.85em; color: var(--base00); margin-left: 8px;">(Port: ${info.port})</span>
                    </div>
                    <span class="process-status-badge badge" id="proc-badge-${safeName}" style="background: var(--base01); color: var(--base3); border-radius: 12px; padding: 3px 8px; font-size: 0.8em; font-weight: bold;">Checking...</span>
                </div>
                
                <div style="font-size: 0.85em; background: var(--base02) !important; padding: 6px 10px; border-radius: 4px; font-family: monospace; border-left: 3px solid var(--cyan); overflow-x: auto; white-space: nowrap; margin: 4px 0; color: var(--cyan) !important;">
                    <code>${info.command}</code>
                </div>
                
                <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 10px; margin-top: 4px;">
                    <div style="display: flex; gap: 6px;">
                        <button class="btn btn-sm proc-start-btn" onclick="startProcess('${name}')" style="background: #27ae60; color: white; border: none; padding: 4px 10px; border-radius: 4px; cursor: pointer; font-size: 0.85em;" disabled>Start</button>
                        <button class="btn btn-sm proc-stop-btn" onclick="stopProcess('${name}', false)" style="background: #f39c12; color: white; border: none; padding: 4px 10px; border-radius: 4px; cursor: pointer; font-size: 0.85em;" disabled>Stop</button>
                        <button class="btn btn-sm proc-kill-btn" onclick="stopProcess('${name}', true)" style="background: #e74c3c; color: white; border: none; padding: 4px 10px; border-radius: 4px; cursor: pointer; font-size: 0.85em;" disabled>Force Kill</button>
                    </div>
                    ${info.log_file ? `<button class="btn btn-sm" onclick="openProcessLogsModal('${name}')" style="background: var(--base02); color: var(--cyan); border: 1px solid var(--base01); padding: 4px 10px; border-radius: 4px; cursor: pointer; font-size: 0.85em;">View Logs</button>` : ''}
                </div>
            </div>
        `;
    }
    container.innerHTML = html;
}

async function fetchProcessStatuses() {
    if (Object.keys(processConfig).length === 0) return;
    try {
        const response = await fetch('/api/processes/status');
        if (!response.ok) return;
        const statuses = await response.json();
        
        for (const [name, statusInfo] of Object.entries(statuses)) {
            const safeName = name.replace(/[^a-zA-Z0-9]/g, '-');
            const badge = document.getElementById(`proc-badge-${safeName}`);
            const card = document.getElementById(`proc-card-${safeName}`);
            const startBtn = card?.querySelector('.proc-start-btn');
            const stopBtn = card?.querySelector('.proc-stop-btn');
            const killBtn = card?.querySelector('.proc-kill-btn');
            
            if (!badge) continue;
            
            if (statusInfo.status === 'Running') {
                const pidStr = statusInfo.pid ? ` (PID: ${statusInfo.pid})` : '';
                badge.textContent = `Running${pidStr}`;
                badge.style.background = '#2ecc71'; // Green
                badge.style.color = '#fff';
                
                if (startBtn) startBtn.disabled = true;
                if (stopBtn) stopBtn.disabled = false;
                if (killBtn) killBtn.disabled = false;
            } else {
                badge.textContent = 'Stopped';
                badge.style.background = '#95a5a6'; // Gray
                badge.style.color = '#fff';
                
                if (startBtn) startBtn.disabled = false;
                if (stopBtn) stopBtn.disabled = true;
                if (killBtn) killBtn.disabled = true;
            }
        }
    } catch (error) {
        console.error("Failed to fetch process statuses:", error);
    }
}

async function startProcess(name) {
    const safeName = name.replace(/[^a-zA-Z0-9]/g, '-');
    const badge = document.getElementById(`proc-badge-${safeName}`);
    if (badge) {
        badge.textContent = 'Starting...';
        badge.style.background = '#3498db';
        badge.style.color = '#fff';
    }
    
    try {
        const response = await fetch('/api/processes/start', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name })
        });
        const data = await response.json();
        if (response.ok) {
            setTimeout(fetchProcessStatuses, 1000); // Small delay to let it bind port
        } else {
            alert(`Error starting process: ${data.detail}`);
            fetchProcessStatuses();
        }
    } catch (error) {
        console.error("Failed to start process:", error);
        fetchProcessStatuses();
    }
}

async function stopProcess(name, force = false) {
    const safeName = name.replace(/[^a-zA-Z0-9]/g, '-');
    const badge = document.getElementById(`proc-badge-${safeName}`);
    if (badge) {
        badge.textContent = force ? 'Killing...' : 'Stopping...';
        badge.style.background = '#e74c3c';
        badge.style.color = '#fff';
    }
    
    try {
        const response = await fetch('/api/processes/stop', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, force })
        });
        const data = await response.json();
        if (response.ok) {
            setTimeout(fetchProcessStatuses, 1000); // Give it a short delay to terminate
        } else {
            alert(`Error stopping process: ${data.detail}`);
            fetchProcessStatuses();
        }
    } catch (error) {
        console.error("Failed to stop process:", error);
        fetchProcessStatuses();
    }
}

async function openProcessLogsModal(name) {
    activeLogProcess = name;
    document.getElementById('process-logs-title').textContent = `Logs: ${name}`;
    document.getElementById('process-logs-modal').style.display = 'flex';
    
    const refreshBtn = document.getElementById('process-logs-refresh-btn');
    refreshBtn.onclick = () => loadProcessLogs(name);
    
    loadProcessLogs(name);
    
    // Auto-refresh logs every 2 seconds while modal is open
    if (logRefreshInterval) clearInterval(logRefreshInterval);
    logRefreshInterval = setInterval(() => loadProcessLogs(name), 2000);
}

async function loadProcessLogs(name) {
    const pre = document.getElementById('process-logs-output');
    if (!pre) return;
    
    try {
        const response = await fetch(`/api/processes/logs?name=${encodeURIComponent(name)}&lines=150`);
        if (!response.ok) {
            const err = await response.json();
            pre.textContent = `Error loading logs: ${err.detail}`;
            return;
        }
        const data = await response.json();
        
        // Save scroll position
        const isScrolledToBottom = pre.scrollHeight - pre.clientHeight <= pre.scrollTop + 50;
        
        pre.textContent = data.logs || '(Empty logs)';
        
        // Keep scrolled to bottom if it was already at the bottom
        if (isScrolledToBottom) {
            pre.scrollTop = pre.scrollHeight;
        }
    } catch (error) {
        console.error("Failed to load logs:", error);
        pre.textContent = `Network error loading logs: ${error.message}`;
    }
}

function closeProcessLogsModal() {
    document.getElementById('process-logs-modal').style.display = 'none';
    activeLogProcess = null;
    if (logRefreshInterval) {
        clearInterval(logRefreshInterval);
        logRefreshInterval = null;
    }
}

// --- FOLDER LIBRARIES FRONTEND ---
let currentLibraryName = "";
let currentLibrarySubpath = "";
let currentLibraryItems = [];
let currentLibraryIsCached = false;
let currentLibrarySourceBase = "";
let currentLibrarySourceServer = "";
let currentLibraryBackupBase = "";
let currentLibraryBackupServer = "";

async function fetchLibrariesList() {
    showLoading(40);
    try {
        const response = await fetch('/api/libraries');
        if (!response.ok) {
            console.error("Failed to load libraries config");
            return;
        }
        const libraries = await response.json();
        renderLibrariesGrid(libraries);
    } catch (error) {
        console.error("Error fetching libraries list:", error);
    } finally {
        hideLoading();
    }
}

function renderLibrariesGrid(libraries) {
    const grid = document.getElementById('libraries-grid');
    if (!grid) return;
    grid.innerHTML = '';

    const keys = Object.keys(libraries);
    if (keys.length === 0) {
        grid.innerHTML = '<div style="color: var(--base1); grid-column: 1/-1; text-align: center; padding: 20px;">No folder libraries configured in config.json.</div>';
        return;
    }

    keys.forEach(name => {
        const lib = libraries[name];
        const card = document.createElement('div');
        card.className = 'library-card';
        card.style.cssText = `
            background: var(--base02);
            border: 1px solid var(--base01);
            border-radius: 8px;
            padding: 20px;
            cursor: pointer;
            transition: all 0.2s ease;
        `;
        card.addEventListener('mouseenter', () => {
            card.style.borderColor = 'var(--cyan)';
            card.style.transform = 'translateY(-2px)';
        });
        card.addEventListener('mouseleave', () => {
            card.style.borderColor = 'var(--base01)';
            card.style.transform = 'translateY(0)';
        });
        card.onclick = () => openLibrary(name);

        card.innerHTML = `
            <h4 style="margin: 0 0 15px 0; color: var(--cyan); display: flex; align-items: center; gap: 8px;">
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>
                ${name}
            </h4>
            <div style="font-size: 0.85em; display: flex; flex-direction: column; gap: 8px; color: var(--base0);">
                <div>
                    <strong style="color: var(--base1);">Source:</strong>
                    <span style="font-family: monospace; display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-top: 2px;">
                        [${lib.source.server}] ${lib.source.path}
                    </span>
                </div>
                <div>
                    <strong style="color: var(--base1);">Backup:</strong>
                    <span style="font-family: monospace; display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-top: 2px;">
                        [${lib.backup.server}] ${lib.backup.path}
                    </span>
                </div>
            </div>
        `;
        grid.appendChild(card);
    });
}

function showLibrariesList() {
    document.getElementById('libraries-list-container').style.display = 'block';
    document.getElementById('library-detail-container').style.display = 'none';
    currentLibraryName = "";
    currentLibrarySubpath = "";
    currentLibraryItems = [];
}

async function openLibrary(name, subpath = "", deepScan = false) {
    currentLibraryName = name;
    currentLibrarySubpath = subpath;
    
    document.getElementById('libraries-list-container').style.display = 'none';
    const detailContainer = document.getElementById('library-detail-container');
    detailContainer.style.display = 'block';
    
    document.getElementById('library-detail-title').textContent = `${name}`;
    document.getElementById('library-search').value = "";
    document.getElementById('library-status-filter').value = "all";
    
    // Toggle deep scan styling
    const scanBtn = document.getElementById('btn-library-deep-scan');
    if (deepScan) {
        scanBtn.textContent = "Exit Deep Scan";
        scanBtn.style.background = "var(--red)";
        scanBtn.style.color = "#fff";
        scanBtn.onclick = () => openLibrary(name, subpath, false);
    } else {
        scanBtn.textContent = "Deep Sync Scan";
        scanBtn.style.background = "var(--yellow)";
        scanBtn.style.color = "var(--base03)";
        scanBtn.onclick = () => openLibrary(name, subpath, true);
    }

    renderLibraryBreadcrumbs();
    await fetchLibraryItems(deepScan);
}

function renderLibraryBreadcrumbs() {
    const container = document.getElementById('library-breadcrumbs');
    if (!container) return;
    container.innerHTML = '';

    const rootLink = document.createElement('span');
    rootLink.textContent = 'Root';
    rootLink.style.cssText = 'cursor: pointer; color: var(--cyan); font-weight: bold;';
    rootLink.onclick = () => openLibrary(currentLibraryName, "");
    container.appendChild(rootLink);

    if (currentLibrarySubpath) {
        const parts = currentLibrarySubpath.split('/');
        let pathAccumulator = "";
        parts.forEach((part, index) => {
            if (!part) return;
            pathAccumulator += (index === 0 ? '' : '/') + part;
            
            const divider = document.createElement('span');
            divider.textContent = ' / ';
            divider.style.color = 'var(--base01)';
            container.appendChild(divider);

            const segmentLink = document.createElement('span');
            segmentLink.textContent = part;
            segmentLink.style.cssText = 'cursor: pointer; color: var(--cyan);';
            const targetPath = pathAccumulator;
            segmentLink.onclick = () => openLibrary(currentLibraryName, targetPath);
            container.appendChild(segmentLink);
        });
    }
}

async function fetchLibraryItems(deepScan = false) {
    showLoading(50);
    const tbody = document.getElementById('library-items-table-body');
    if (tbody) {
        tbody.innerHTML = `
            <tr>
                <td colspan="5" style="text-align: center; padding: 40px;">
                    <div class="spinner"></div>
                    <div style="color: var(--base1); font-weight: bold; font-size: 0.95em; margin-top: 10px;">Scanning folders and aligning metadata...</div>
                </td>
            </tr>
        `;
    }
    
    try {
        const url = `/api/libraries/browse?library_name=${encodeURIComponent(currentLibraryName)}&subpath=${encodeURIComponent(currentLibrarySubpath)}&deep_scan=${deepScan}`;
        const response = await fetch(url);
        if (!response.ok) {
            const err = await response.json();
            alert(`Browse failed: ${err.detail}`);
            tbody.innerHTML = `<tr><td colspan="5" style="text-align: center; color: var(--red); padding: 20px;">Error: ${err.detail}</td></tr>`;
            return;
        }
        const data = await response.json();
        
        currentLibrarySourceBase = data.source_base || "";
        currentLibrarySourceServer = data.source_server || "";
        currentLibraryBackupBase = data.backup_base || "";
        currentLibraryBackupServer = data.backup_server || "";
        
        currentLibraryItems = data.items || [];
        currentLibraryIsCached = !!data.cached;
        
        const cachedIndicator = document.getElementById('library-cached-indicator');
        if (cachedIndicator) {
            cachedIndicator.style.display = currentLibraryIsCached ? 'inline-block' : 'none';
        }
        
        renderLibraryItems(currentLibraryItems);
        
        // If results are cached, lazy-load fresh data in the background
        if (currentLibraryIsCached) {
            const freshUrl = url + "&nocache=true";
            fetch(freshUrl)
                .then(async (res) => {
                    if (res.ok) {
                        const freshData = await res.json();
                        if (currentLibraryName === freshData.library_name && currentLibrarySubpath === freshData.subpath) {
                            currentLibraryIsCached = false;
                            if (cachedIndicator) {
                                cachedIndicator.style.display = 'none';
                            }
                            currentLibraryItems = freshData.items || [];
                            renderLibraryItems(currentLibraryItems);
                        }
                    }
                })
                .catch(err => console.error("Error loading fresh library items:", err));
        }
    } catch (error) {
        console.error("Error loading library items:", error);
    } finally {
        hideLoading();
    }
}

function formatSize(size) {
    if (size === null || size === undefined) return '-';
    return (size / 1024 / 1024).toFixed(2) + " MB";
}

function renderLibraryItems(items) {
    const tbody = document.getElementById('library-items-table-body');
    if (!tbody) return;
    tbody.innerHTML = '';

    if (items.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" style="text-align: center; padding: 20px; color: var(--base1);">No discrepancies found (All identical).</td></tr>';
        return;
    }

    // Lazy / progressive rendering via requestAnimationFrame to keep DOM responsive
    const chunkSize = 45;
    let index = 0;

    function renderNextChunk() {
        const chunk = items.slice(index, index + chunkSize);
        chunk.forEach(item => {
            const tr = createLibraryRow(item);
            tbody.appendChild(tr);
        });
        index += chunkSize;
        if (index < items.length) {
            requestAnimationFrame(renderNextChunk);
        }
    }

    renderNextChunk();
}

function createLibraryRow(item) {
    const tr = document.createElement('tr');
    tr.style.borderBottom = '1px solid var(--base02)';
    
    // Icon and Name
    const nameCell = document.createElement('td');
    nameCell.style.padding = '10px';
    nameCell.style.verticalAlign = 'middle';
    
    const isDir = item.is_dir;
    const iconHtml = isDir 
        ? `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color: var(--blue); vertical-align: middle; margin-right: 8px;"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>`
        : `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color: var(--base1); vertical-align: middle; margin-right: 8px;"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg>`;
        
    const nameSpan = document.createElement('span');
    nameSpan.innerHTML = iconHtml + (isDir ? `<span style="font-weight: bold; color: var(--cyan); cursor: pointer;">${item.name}</span>` : item.name);
    if (currentLibraryIsCached) {
        nameSpan.style.opacity = '0.55';
        nameSpan.title = 'Showing cached results, loading latest in background...';
    }
    
    if (isDir) {
        nameSpan.onclick = () => {
            const nextSubpath = currentLibrarySubpath 
                ? `${currentLibrarySubpath}/${item.relative_path}`
                : item.relative_path;
            openLibrary(currentLibraryName, nextSubpath);
        };
    }
    nameCell.appendChild(nameSpan);
    tr.appendChild(nameCell);

    // Status Badge
    const statusCell = document.createElement('td');
    statusCell.style.padding = '10px';
    statusCell.style.verticalAlign = 'middle';
    
    let statusBadge = "";
    if (item.status === 'synced') {
        statusBadge = '<span style="background: #25d36633; color: #25d366; padding: 3px 8px; border-radius: 12px; font-size: 0.82em; font-weight: bold;">Synced</span>';
    } else if (item.status === 'full_sync') {
        statusBadge = '<span style="background: rgba(38, 139, 210, 0.15); color: #268bd2; padding: 3px 8px; border-radius: 12px; font-size: 0.82em; font-weight: bold;">Full-sync</span>';
    } else if (item.status === 'partial_sync') {
        statusBadge = '<span style="background: rgba(211, 54, 130, 0.15); color: #d33682; padding: 3px 8px; border-radius: 12px; font-size: 0.82em; font-weight: bold;">Partial-sync</span>';
    } else if (item.status === 'only_source') {
        statusBadge = '<span style="background: #3498db33; color: #3498db; padding: 3px 8px; border-radius: 12px; font-size: 0.82em; font-weight: bold;">Only in Source</span>';
    } else if (item.status === 'only_backup') {
        statusBadge = '<span style="background: #e67e2233; color: #e67e22; padding: 3px 8px; border-radius: 12px; font-size: 0.82em; font-weight: bold;">Only in Backup</span>';
    } else if (item.status === 'pending_sync') {
        statusBadge = '<span style="background: #f1c40f33; color: #f1c40f; padding: 3px 8px; border-radius: 12px; font-size: 0.82em; font-weight: bold;">Pending Sync</span>';
    }
    statusCell.innerHTML = statusBadge;
    tr.appendChild(statusCell);

    // Sizes
    const srcSizeCell = document.createElement('td');
    srcSizeCell.style.padding = '10px';
    srcSizeCell.style.verticalAlign = 'middle';
    srcSizeCell.textContent = item.source_exists && !isDir ? formatSize(item.source_size) : '-';
    tr.appendChild(srcSizeCell);

    const bkSizeCell = document.createElement('td');
    bkSizeCell.style.padding = '10px';
    bkSizeCell.style.verticalAlign = 'middle';
    bkSizeCell.textContent = item.backup_exists && !isDir ? formatSize(item.backup_size) : '-';
    tr.appendChild(bkSizeCell);

    // Actions
    const actionsCell = document.createElement('td');
    actionsCell.style.padding = '10px';
    actionsCell.style.textAlign = 'right';
    actionsCell.style.verticalAlign = 'middle';
    actionsCell.style.whiteSpace = 'nowrap';
    
    let actionButtons = '';
    
    // Backup Action
    if (item.status === 'only_source' || item.status === 'pending_sync') {
        actionButtons += `
            <button class="action-icon-btn" onclick="syncItem('${item.relative_path.replace(/'/g, "\\'")}', 'backup')" title="Back Up to Backup Location" style="color: var(--orange); margin-left: 6px;">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.2 15a4.8 4.8 0 0 1-9.6 0"></path><path d="M12 3v12"></path><polyline points="8 7 12 3 16 7"></polyline></svg>
            </button>
        `;
    }
    
    // Download/Restore Action
    if (item.status === 'only_backup' || item.status === 'pending_sync') {
        actionButtons += `
            <button class="action-icon-btn" onclick="syncItem('${item.relative_path.replace(/'/g, "\\'")}', 'restore')" title="Download to Source Location" style="color: var(--cyan); margin-left: 6px;">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.2 15a4.8 4.8 0 0 1-9.6 0"></path><path d="M12 15V3"></path><polyline points="16 11 12 15 8 11"></polyline></svg>
            </button>
        `;
    }
    
    // Bidirectional Sync Action (Only for partial-sync folders)
    if (item.status === 'partial_sync') {
        actionButtons += `
            <button class="action-icon-btn" onclick="syncItem('${item.relative_path.replace(/'/g, "\\'")}', 'both')" title="Bidirectional Sync (Make Identical)" style="color: #d33682; margin-left: 6px;">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"></polyline><polyline points="1 20 1 14 7 14"></polyline><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path></svg>
            </button>
        `;
    }
    
    // Info / Media Analysis Action
    if (!isDir) {
        actionButtons += `
            <button class="action-icon-btn" onclick="showMediaInfo('${item.relative_path.replace(/'/g, "\\'")}')" title="View Media Info & Conversion" style="color: var(--blue); margin-left: 6px;">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>
            </button>
        `;
    }
    
    // Rename Action
    actionButtons += `
        <button class="action-icon-btn" onclick="renameLibraryItem('${item.relative_path.replace(/'/g, "\\'")}', ${item.source_exists}, ${item.backup_exists}, '${item.name.replace(/'/g, "\\'")}')" title="Rename File/Folder" style="color: var(--yellow); margin-left: 6px;">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4z"></path></svg>
        </button>
    `;
    
    // Delete Actions
    if (item.source_exists) {
        actionButtons += `
            <button class="action-icon-btn" onclick="deleteLibraryItem('${item.relative_path.replace(/'/g, "\\'")}', 'source', '${item.name.replace(/'/g, "\\'")}')" title="Delete from Source" style="color: var(--cyan); margin-left: 6px;">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="filter: drop-shadow(0px 0px 1px var(--red));"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg>
            </button>
        `;
    }
    if (item.backup_exists) {
        actionButtons += `
            <button class="action-icon-btn" onclick="deleteLibraryItem('${item.relative_path.replace(/'/g, "\\'")}', 'backup', '${item.name.replace(/'/g, "\\'")}')" title="Delete from Backup" style="color: var(--orange); margin-left: 6px;">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="filter: drop-shadow(0px 0px 1px var(--red));"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg>
            </button>
        `;
    }
    
    actionsCell.innerHTML = actionButtons;
    tr.appendChild(actionsCell);
    
    return tr;
}

async function renameLibraryItem(relativePath, sourceExists, backupExists, currentName) {
    const newName = prompt(`Enter new name for "${currentName}":`, currentName);
    if (!newName || newName === currentName) return;
    
    const fullRelativePath = currentLibrarySubpath 
        ? `${currentLibrarySubpath}/${relativePath}` 
        : relativePath;
        
    showLoading(30);
    try {
        const promises = [];
        if (sourceExists) {
            const srcPath = `${currentLibrarySourceBase}/${fullRelativePath}`;
            promises.push(fetch('/api/fs/rename', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    source_path: srcPath,
                    new_name: newName,
                    remote_server: currentLibrarySourceServer === 'local' ? '' : currentLibrarySourceServer
                })
            }));
        }
        if (backupExists) {
            const bkPath = `${currentLibraryBackupBase}/${fullRelativePath}`;
            promises.push(fetch('/api/fs/rename', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    source_path: bkPath,
                    new_name: newName,
                    remote_server: currentLibraryBackupServer === 'local' ? '' : currentLibraryBackupServer
                })
            }));
        }
        
        const responses = await Promise.all(promises);
        let success = true;
        for (let res of responses) {
            if (!res.ok) {
                success = false;
                const err = await res.json();
                alert(`Rename failed: ${err.detail}`);
            }
        }
        if (success) {
            showTemporarySyncToast("Renamed successfully.");
            fetchLibraryItems(document.getElementById('btn-library-deep-scan').textContent === "Exit Deep Scan");
        }
    } catch (e) {
        console.error("Rename failed:", e);
    } finally {
        hideLoading();
    }
}

async function deleteLibraryItem(relativePath, target, currentName) {
    if (!confirm(`Are you sure you want to delete "${currentName}" from the ${target}?`)) return;
    
    const fullRelativePath = currentLibrarySubpath 
        ? `${currentLibrarySubpath}/${relativePath}` 
        : relativePath;
        
    showLoading(30);
    try {
        let path = "";
        let server = "";
        if (target === 'source') {
            path = `${currentLibrarySourceBase}/${fullRelativePath}`;
            server = currentLibrarySourceServer === 'local' ? '' : currentLibrarySourceServer;
        } else {
            path = `${currentLibraryBackupBase}/${fullRelativePath}`;
            server = currentLibraryBackupServer === 'local' ? '' : currentLibraryBackupServer;
        }
        
        const response = await fetch('/api/execute/fs', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                action: 'Delete',
                source_paths: [path],
                destination_path: '',
                source_server: server
            })
        });
        
        if (response.ok) {
            showTemporarySyncToast(`Deletion task queued for ${target}.`);
            updateTaskTicker();
            setTimeout(() => {
                fetchLibraryItems(document.getElementById('btn-library-deep-scan').textContent === "Exit Deep Scan");
            }, 1000);
        } else {
            const err = await response.json();
            alert(`Deletion failed: ${err.detail}`);
        }
    } catch (e) {
        console.error("Deletion failed:", e);
    } finally {
        hideLoading();
    }
}

function filterLibraryItems() {
    const query = document.getElementById('library-search').value.toLowerCase().trim();
    const statusVal = document.getElementById('library-status-filter').value;
    
    let filtered = currentLibraryItems;
    
    if (statusVal !== 'all') {
        filtered = filtered.filter(item => item.status === statusVal);
    }
    
    if (query) {
        filtered = filtered.filter(item => 
            item.name.toLowerCase().includes(query) || 
            item.relative_path.toLowerCase().includes(query)
        );
    }
    
    renderLibraryItems(filtered);
}

async function syncItem(relativePath, direction) {
    const fullRelativePath = currentLibrarySubpath 
        ? `${currentLibrarySubpath}/${relativePath}` 
        : relativePath;
        
    showLoading(30);
    try {
        const response = await fetch('/api/libraries/sync', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                library_name: currentLibraryName,
                relative_path: fullRelativePath,
                direction: direction
            })
        });
        
        if (response.ok) {
            updateTaskTicker();
            const actionText = direction === 'backup' ? 'Backup copy' : 'Restore download';
            showTemporarySyncToast(`${actionText} task queued successfully in Queue runner.`);
        } else {
            const err = await response.json();
            alert(`Sync failed: ${err.detail}`);
        }
    } catch (error) {
        console.error("Error executing sync task:", error);
    } finally {
        hideLoading();
    }
}

function showTemporarySyncToast(message) {
    const toast = document.createElement('div');
    toast.style.cssText = `
        position: fixed;
        bottom: 20px;
        right: 20px;
        background: #25d366;
        color: #fff;
        padding: 12px 24px;
        border-radius: 4px;
        box-shadow: 0 4px 12px rgba(0,0,0,0.15);
        z-index: 100000;
        font-weight: bold;
        font-size: 0.9em;
        opacity: 0;
        transition: opacity 0.3s ease;
    `;
    toast.textContent = message;
    document.body.appendChild(toast);
    
    setTimeout(() => {
        toast.style.opacity = '1';
    }, 50);

    setTimeout(() => {
        toast.style.opacity = '0';
        setTimeout(() => {
            document.body.removeChild(toast);
        }, 300);
    }, 4000);
}

async function showMediaInfo(relativePath) {
    const fullRelativePath = currentLibrarySubpath 
        ? `${currentLibrarySubpath}/${relativePath}` 
        : relativePath;
        
    showLoading();
    try {
        const response = await fetch('/api/libraries/media-info', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Pareo-Auth': localStorage.getItem('pareo_auth_token') || ''
            },
            body: JSON.stringify({
                library_name: currentLibraryName,
                relative_path: fullRelativePath
            })
        });
        
        if (!response.ok) {
            let errorMsg = response.statusText || 'Internal Server Error';
            try {
                const err = await response.json();
                if (err && err.detail) {
                    errorMsg = err.detail;
                }
            } catch (jsonErr) {
                try {
                    errorMsg = await response.text();
                } catch (textErr) {}
            }
            console.error("Failed to fetch media details:", errorMsg);
            alert(`Failed to fetch media details: ${errorMsg}`);
            return;
        }
        
        const details = await response.json();
        
        // Populate Title
        document.getElementById('media-info-title').textContent = `Media Info: ${details.filename}`;
        
        // Populate Stream Information
        const detailsDiv = document.getElementById('media-info-details');
        detailsDiv.innerHTML = `
            <div><strong>Format:</strong> ${details.format}</div>
            <div><strong>Duration:</strong> ${details.duration}</div>
            <div><strong>Size:</strong> ${details.size}</div>
            <div><strong>Bitrate:</strong> ${details.bitrate}</div>
        `;
        
        if (details.video && details.video.length > 0) {
            details.video.forEach((v, index) => {
                detailsDiv.innerHTML += `
                    <div style="grid-column: 1 / -1; margin-top: 5px; color: #16a085; border-top: 1px solid #e9ecef; padding-top: 5px;">
                        <strong>Video Stream #${index + 1}:</strong> ${v.codec} | ${v.resolution} | ${v.fps} fps
                    </div>
                `;
            });
        }
        
        if (details.audio && details.audio.length > 0) {
            details.audio.forEach((a, index) => {
                detailsDiv.innerHTML += `
                    <div style="grid-column: 1 / -1; color: #d35400;">
                        <strong>Audio Stream #${index + 1}:</strong> ${a.codec} | ${a.channels} ch | Lang: ${a.language}
                    </div>
                `;
            });
        }
        
        if (details.subtitle && details.subtitle.length > 0) {
            detailsDiv.innerHTML += `
                <div style="grid-column: 1 / -1; color: #7f8c8d; font-size: 0.95em;">
                    <strong>Subtitles:</strong> ${details.subtitle.map(s => `${s.codec.toUpperCase()} (${s.language})`).join(', ')}
                </div>
            `;
        }
        
        // Populate Conversion Profiles
        const configResponse = await fetch('/api/config/ffmpeg', {
            headers: {
                'X-Pareo-Auth': localStorage.getItem('pareo_auth_token') || ''
            }
        });
        
        const config = await configResponse.json();
        const profiles = config.profiles || {};
        
        const profilesDiv = document.getElementById('media-conversion-profiles');
        profilesDiv.innerHTML = '';
        
        const fileExt = '.' + details.filename.split('.').pop().toLowerCase();
        
        let hasProfiles = false;
        
        for (const [name, p] of Object.entries(profiles)) {
            const allowed = p.allowed_extensions || [];
            const isAllowed = allowed.length === 0 || allowed.includes(fileExt) || 
                              (name.toLowerCase().includes('subtitle') && (fileExt === '.mkv' || fileExt === '.mp4')) ||
                              (name.toLowerCase().includes('audio') && (fileExt === '.mkv' || fileExt === '.mp4' || fileExt === '.avi'));
                              
            if (isAllowed) {
                hasProfiles = true;
                const profileCard = document.createElement('div');
                profileCard.style.cssText = `
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    background: #f8f9fa;
                    padding: 12px 15px;
                    border-radius: 4px;
                    border: 1px solid #e9ecef;
                    font-size: 0.9em;
                `;
                
                profileCard.innerHTML = `
                    <div style="flex-grow: 1; padding-right: 15px;">
                        <div style="font-weight: bold; color: #2c3e50;">${name}</div>
                        <div style="color: #666; font-size: 0.85em; font-family: monospace; word-break: break-all; margin-top: 3px;">${p.flags}</div>
                    </div>
                    <button class="btn btn-sm" onclick="startMediaConversion('${fullRelativePath.replace(/'/g, "\\'")}', '${name.replace(/'/g, "\\'")}')" style="background: #2980b9; color: #fff; border: none; font-weight: bold; padding: 6px 12px; cursor: pointer; border-radius: 4px; white-space: nowrap;">Convert</button>
                `;
                profilesDiv.appendChild(profileCard);
            }
        }
        
        if (!hasProfiles) {
            profilesDiv.innerHTML = '<div style="color: #666; font-style: italic; font-size: 0.9em;">No matching conversion profiles available for this file type.</div>';
        }
        
        document.getElementById('media-info-modal').style.display = 'flex';
        
    } catch (error) {
        console.error("Error showing media info:", error);
    } finally {
        hideLoading();
    }
}

function closeMediaInfoModal() {
    document.getElementById('media-info-modal').style.display = 'none';
}

async function startMediaConversion(relativePath, profileName) {
    closeMediaInfoModal();
    showLoading();
    try {
        const response = await fetch('/api/libraries/media-convert', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Pareo-Auth': localStorage.getItem('pareo_auth_token') || ''
            },
            body: JSON.stringify({
                library_name: currentLibraryName,
                relative_path: relativePath,
                profile_name: profileName
            })
        });
        
        if (!response.ok) {
            const err = await response.json();
            alert(`Failed to start media conversion: ${err.detail}`);
            return;
        }
        
        const result = await response.json();
        showTemporarySyncToast("Media conversion pipeline successfully started!");
        
    } catch (error) {
        console.error("Error starting media conversion:", error);
    } finally {
        hideLoading();
    }
}
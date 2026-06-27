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
    if (tabTasks) tabTasks.style.display = 'none';
    if (tabUtils) tabUtils.style.display = 'none';

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

fetchTasks(0); // Initial fetch on load
updateTaskTicker(); // Initial ticker update

// ADD THIS at the very bottom of app.js (below fetchTasks())
fetchProfiles();
fetchFsConfig(); // NEW: Load FS Schema
fetchBookmarks(); // NEW: Load the global path shortcuts
fetchRemotesConfig(); // NEW: Load remote servers
fetchSwitchboardConfig();
fetchGenericCards();
fetchProcessConfig(); // NEW: Load local process monitors config
switchTab('tasks'); // NEW: Force the UI to sync and show tasks on load
// Start the polling loop (every 2.5 minutes)
setInterval(() => fetchTasks(0), 150000);

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
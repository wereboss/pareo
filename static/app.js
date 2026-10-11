/**
 * Pareo V2 - Modernized Asynchronous Command & Orchestration Engine
 * Frontend Single Page Application (SPA)
 * 
 * Features:
 * - Frictionless No-Auth Mode (LAN access)
 * - Native Server-Sent Events (SSE) Bus (/api/stream/events)
 * - Dual Bespoke Signature Themes: Sony's Wipeout HUD & Fallout Atompunk Pip-Boy
 * - Responsive Layout: Mobile task cards (<640px) & Desktop data grid
 * - Smart Terminal Auto-Scroll Interlock
 * - Accessible Non-Blocking Toast Notification Stack
 */

// Global State
let loadedTasks = {};
let tasksOffset = 0;
const tasksLimit = 15;
let hasMoreTasks = true;
let ffmpegConfig = {};
let fsConfig = {};
let remotesConfig = {};
let processConfig = {};
let activeLogProcess = null;
let logRefreshInterval = null;
let processPollInterval = null;
let filterDebounceTimeout = null;

// Library state
let currentLibraryName = "";
let currentLibrarySubpath = "";
let currentLibraryItems = [];
let currentLibraryIsCached = false;
let currentLibrarySourceBase = "";
let currentLibrarySourceServer = "";
let currentLibraryBackupBase = "";
let currentLibraryBackupServer = "";

// Global Auth & Token Management (MVP 2)
let currentUser = null; // { user_id, email, role, token }

function getAuthToken() {
    return localStorage.getItem('pareo_auth_token') || '';
}

function setAuthToken(token) {
    if (token) {
        localStorage.setItem('pareo_auth_token', token);
    } else {
        localStorage.removeItem('pareo_auth_token');
    }
}

// Global transparent fetch interceptor ensuring Bearer token is attached
const originalFetch = window.fetch;
window.fetch = async function(resource, init = {}) {
    init.headers = init.headers || {};
    const token = getAuthToken();
    if (token) {
        if (init.headers instanceof Headers) {
            if (!init.headers.has('Authorization')) init.headers.set('Authorization', `Bearer ${token}`);
        } else if (Array.isArray(init.headers)) {
            init.headers.push(['Authorization', `Bearer ${token}`]);
        } else {
            if (!init.headers['Authorization']) init.headers['Authorization'] = `Bearer ${token}`;
        }
    }
    const response = await originalFetch(resource, init);
    const urlStr = typeof resource === 'string' ? resource : (resource.url || '');
    if (response.status === 401 && !urlStr.includes('/api/auth/status') && !urlStr.includes('/api/auth/login') && !urlStr.includes('/api/auth/setup-admin')) {
        currentUser = null;
        updateUserUI();
        openAuthModal('login');
    }
    return response;
};

// Batch Task Selection State (MVP 2)
const selectedTaskIds = new Set();

// Haptic Feedback Integration
function triggerHaptic(duration = 15) {
    if ('vibrate' in navigator) {
        try { navigator.vibrate(duration); } catch (e) {}
    }
}

// PWA Installation & Service Worker Integration
let deferredInstallPrompt = null;
function initPWA() {
    if ('serviceWorker' in navigator) {
        window.addEventListener('load', () => {
            navigator.serviceWorker.register('/static/sw.js').catch(err => {
                console.warn('[PWA] Service worker registration failed:', err);
            });
        });
    }

    window.addEventListener('online', () => {
        const banner = document.getElementById('offline-banner');
        if (banner) banner.style.display = 'none';
        showToast('Network restored - Reconnected', 'success');
    });

    window.addEventListener('offline', () => {
        const banner = document.getElementById('offline-banner');
        if (banner) banner.style.display = 'block';
        showToast('Network disconnected - Offline mode', 'warning');
    });

    window.addEventListener('beforeinstallprompt', (e) => {
        e.preventDefault();
        deferredInstallPrompt = e;
        const btn = document.getElementById('btn-install-app');
        if (btn) btn.style.display = 'inline-flex';
    });
}

function promptInstallPwa() {
    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    deferredInstallPrompt.userChoice.then((choiceResult) => {
        if (choiceResult.outcome === 'accepted') {
            showToast('App installed successfully!', 'success');
        }
        deferredInstallPrompt = null;
        const btn = document.getElementById('btn-install-app');
        if (btn) btn.style.display = 'none';
    });
}

// Auto-Scroll Interlock State Map: taskId -> { locked: boolean, userScrolled: boolean }
const terminalScrollState = new Map();

function getScrollState(taskId) {
    if (!terminalScrollState.has(taskId)) {
        terminalScrollState.set(taskId, { locked: true, userScrolled: false });
    }
    return terminalScrollState.get(taskId);
}

function handleUserTerminalScroll(taskId) {
    const el = document.getElementById(`terminal-card-${taskId}`) || document.getElementById(`terminal-${taskId}`);
    if (!el) return;
    const state = getScrollState(taskId);
    
    // Check if scrolled near the bottom (within 24px)
    const isAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    
    if (!isAtBottom) {
        state.locked = false;
        state.userScrolled = true;
        updateScrollButtonState(taskId, false);
    } else {
        state.locked = true;
        state.userScrolled = false;
        updateScrollButtonState(taskId, true);
    }
}

function toggleScrollLock(taskId, btn) {
    const state = getScrollState(taskId);
    state.locked = !state.locked;
    updateScrollButtonState(taskId, state.locked);
    if (state.locked) {
        const el = document.getElementById(`terminal-card-${taskId}`) || document.getElementById(`terminal-${taskId}`);
        if (el) el.scrollTop = el.scrollHeight;
    }
}

function updateScrollButtonState(taskId, locked) {
    const btns = document.querySelectorAll(`[onclick*="toggleScrollLock('${taskId}'"]`);
    btns.forEach(btn => {
        if (locked) {
            btn.classList.add('btn-lock-active');
            btn.textContent = '🔒 LOCK SCROLL';
        } else {
            btn.classList.remove('btn-lock-active');
            btn.textContent = '🔓 SCROLL PAUSED';
        }
    });
}

function escapeHtml(str) {
    if (!str) return '';
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function formatTime(isoString) {
    if (!isoString) return '--';
    const d = new Date(isoString);
    return d.toLocaleString(undefined, { 
        month: 'short', day: '2-digit', 
        hour: '2-digit', minute: '2-digit', second: '2-digit', 
        hour12: false 
    });
}

// --------------------------------------------------------------------------
// BESPOKE DUAL-THEME ENGINE
// --------------------------------------------------------------------------
function initTheme() {
    const saved = localStorage.getItem('pareo_theme') || 'wipeout';
    setTheme(saved, false);
}

function setTheme(theme, notify = true) {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('pareo_theme', theme);
    
    const label = document.getElementById('theme-label');
    const icon = document.getElementById('theme-icon');
    if (theme === 'fallout-pipboy') {
        if (label) label.textContent = 'ATOMPUNK';
        if (icon) icon.textContent = '☢';
    } else {
        if (label) label.textContent = 'WIPEOUT';
        if (icon) icon.textContent = '⚡';
    }
    
    if (notify) {
        showToast(`Theme switched to ${theme === 'fallout-pipboy' ? "Fallout Atompunk Pip-Boy 3000" : "Sony's Wipeout HUD"}`, 'info', 2500);
    }
}

function toggleTheme() {
    const current = document.documentElement.getAttribute('data-theme') || 'wipeout';
    const next = current === 'wipeout' ? 'fallout-pipboy' : 'wipeout';
    setTheme(next, true);
}

// --------------------------------------------------------------------------
// NON-BLOCKING TOAST NOTIFICATION STACK
// --------------------------------------------------------------------------
function showToast(message, type = 'info', durationMs = 4000) {
    const container = document.getElementById('toast-container');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.setAttribute('role', 'status');

    const icons = {
        success: '✓',
        error: '✕',
        warning: '▲',
        info: '◈'
    };

    toast.innerHTML = `
        <span class="toast-icon" aria-hidden="true">${icons[type] || '◈'}</span>
        <span class="toast-message">${escapeHtml(message)}</span>
        <button class="toast-close" aria-label="Dismiss notification" onclick="this.parentElement.remove()">×</button>
    `;

    container.appendChild(toast);

    if (durationMs > 0) {
        setTimeout(() => {
            toast.style.transition = 'opacity 250ms, transform 250ms';
            toast.style.opacity = '0';
            toast.style.transform = 'translateY(-10px)';
            setTimeout(() => toast.remove(), 250);
        }, durationMs);
    }
}

// Alias for backwards compatibility
function showTemporarySyncToast(msg) {
    showToast(msg, 'success');
}

// --------------------------------------------------------------------------
// NON-BLOCKING IN-APP MODAL CONFIRM & PROMPT DIALOGS
// --------------------------------------------------------------------------
let appDialogResolver = null;

function showAppConfirm(message) {
    return new Promise((resolve) => {
        appDialogResolver = resolve;
        const modal = document.getElementById('dialog-modal');
        const title = document.getElementById('dialog-modal-title');
        const msg = document.getElementById('dialog-modal-message');
        const input = document.getElementById('dialog-modal-input');
        const cancelBtn = document.getElementById('dialog-modal-cancel');
        
        title.textContent = 'Confirm Action';
        msg.textContent = message;
        input.style.display = 'none';
        cancelBtn.style.display = 'inline-flex';
        modal.style.display = 'flex';
    });
}

function showAppPrompt(message, defaultValue = '') {
    return new Promise((resolve) => {
        appDialogResolver = resolve;
        const modal = document.getElementById('dialog-modal');
        const title = document.getElementById('dialog-modal-title');
        const msg = document.getElementById('dialog-modal-message');
        const input = document.getElementById('dialog-modal-input');
        const cancelBtn = document.getElementById('dialog-modal-cancel');
        
        title.textContent = 'User Input Required';
        msg.textContent = message;
        input.style.display = 'block';
        input.value = defaultValue;
        cancelBtn.style.display = 'inline-flex';
        modal.style.display = 'flex';
        setTimeout(() => input.focus(), 100);
    });
}

function closeAppDialog(confirmed) {
    const modal = document.getElementById('dialog-modal');
    const input = document.getElementById('dialog-modal-input');
    modal.style.display = 'none';
    if (appDialogResolver) {
        if (!confirmed) {
            appDialogResolver(null);
        } else if (input.style.display !== 'none') {
            appDialogResolver(input.value);
        } else {
            appDialogResolver(true);
        }
        appDialogResolver = null;
    }
}

// Global Loading Progress Bar
function showLoading(percent = 40) {
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

// --------------------------------------------------------------------------
// REAL-TIME SERVER-SENT EVENTS (SSE) BUS INTEGRATION
// --------------------------------------------------------------------------
let globalEvtSource = null;

function initEventStream() {
    if (globalEvtSource) {
        globalEvtSource.close();
    }
    console.log('[SSE] Connecting to real-time events stream...');
    const token = getAuthToken();
    const streamUrl = token ? `/api/stream/events?token=${encodeURIComponent(token)}` : '/api/stream/events';
    const evtSource = token ? new EventSource(streamUrl) : new EventSource('/api/stream/events');
    globalEvtSource = evtSource;
    
    evtSource.addEventListener('connected', () => {
        console.log('[SSE] Stream connected successfully.');
    });
    
    evtSource.addEventListener('task_update', (e) => {
        try {
            const task = JSON.parse(e.data);
            updateTaskInUI(task);
        } catch (err) {
            console.error('[SSE] Error handling task_update:', err);
        }
    });
    
    evtSource.addEventListener('task_output', (e) => {
        try {
            const payload = JSON.parse(e.data);
            appendLogChunk(payload.task_id, payload.chunk);
        } catch (err) {
            console.error('[SSE] Error handling task_output:', err);
        }
    });
    
    evtSource.addEventListener('task_counts', (e) => {
        try {
            const counts = JSON.parse(e.data);
            updateHeaderTicker(counts.ongoing, counts.pending);
        } catch (err) {
            console.error('[SSE] Error handling task_counts:', err);
        }
    });

    evtSource.addEventListener('telemetry', (e) => {
        try {
            const tele = JSON.parse(e.data);
            handleTelemetryUpdate(tele);
        } catch (err) {
            console.error('[SSE] Error handling telemetry:', err);
        }
    });
    
    evtSource.onerror = (err) => {
        console.warn('[SSE] Connection error. EventSource will reconnect automatically...', err);
    };
}

async function fetchInitialTelemetry() {
    try {
        const res = await fetch('/api/telemetry');
        if (res.ok) {
            const data = await res.json();
            handleTelemetryUpdate(data);
        }
    } catch (e) {}
}

function handleTelemetryUpdate(data) {
    if (!data) return;
    
    // CPU
    if (data.cpu) {
        const cpuPct = data.cpu.utilization_pct || 0;
        const cpuFill = document.getElementById('tele-cpu-fill');
        const cpuVal = document.getElementById('tele-cpu-val');
        const cardCpuVal = document.getElementById('tele-card-cpu-val');
        const cardCpuSub = document.getElementById('tele-card-cpu-sub');
        if (cpuFill) cpuFill.style.width = `${Math.min(100, Math.max(0, cpuPct))}%`;
        if (cpuVal) cpuVal.textContent = `${cpuPct.toFixed(1)}%`;
        if (cardCpuVal) cardCpuVal.textContent = `${cpuPct.toFixed(1)}%`;
        if (cardCpuSub) cardCpuSub.textContent = `Load: ${data.cpu.load_1m} / ${data.cpu.load_5m} / ${data.cpu.load_15m} (Cores: ${data.cpu.cores})`;
    }
    
    // RAM
    if (data.memory) {
        const ramPct = data.memory.utilization_pct || 0;
        const ramFill = document.getElementById('tele-ram-fill');
        const ramVal = document.getElementById('tele-ram-val');
        const cardRamVal = document.getElementById('tele-card-ram-val');
        const cardRamSub = document.getElementById('tele-card-ram-sub');
        if (ramFill) ramFill.style.width = `${Math.min(100, Math.max(0, ramPct))}%`;
        if (ramVal) ramVal.textContent = `${ramPct.toFixed(1)}%`;
        if (cardRamVal) cardRamVal.textContent = `${ramPct.toFixed(1)}%`;
        if (cardRamSub) cardRamSub.textContent = `Used: ${data.memory.used_mb} MB / ${data.memory.total_mb} MB`;
    }

    // Queues
    if (data.queues) {
        let totalActive = 0;
        let totalLimit = 0;
        let subDetails = [];
        for (const [qName, qStats] of Object.entries(data.queues)) {
            totalActive += qStats.active || 0;
            totalLimit += qStats.limit || 0;
            subDetails.push(`${qName.toUpperCase()}: ${qStats.active}/${qStats.limit}`);
        }
        const slotsVal = document.getElementById('tele-slots-val');
        const cardQueuesVal = document.getElementById('tele-card-queues-val');
        const cardQueuesSub = document.getElementById('tele-card-queues-sub');
        if (slotsVal) slotsVal.textContent = `SLOTS: ${totalActive}/${totalLimit}`;
        if (cardQueuesVal) cardQueuesVal.textContent = `${totalActive} / ${totalLimit}`;
        if (cardQueuesSub) cardQueuesSub.textContent = subDetails.join(' | ');
    }

    // Disk
    if (data.disk && data.disk.length > 0) {
        const primary = data.disk[0];
        const cardDiskVal = document.getElementById('tele-card-disk-val');
        const cardDiskSub = document.getElementById('tele-card-disk-sub');
        if (cardDiskVal) cardDiskVal.textContent = `${primary.utilization_pct.toFixed(1)}%`;
        if (cardDiskSub) cardDiskSub.textContent = `Free: ${primary.free_gb} GB / ${primary.total_gb} GB (${primary.path})`;
    }
}

function toggleTelemetryDetail() {
    const grid = document.getElementById('telemetry-detail-grid');
    if (!grid) return;
    grid.style.display = grid.style.display === 'none' ? 'grid' : 'none';
}

function updateHeaderTicker(ongoing, pending) {
    const tickerText = document.getElementById('ticker-text');
    const tickerDot = document.getElementById('ticker-dot');
    const tickerBadge = document.getElementById('task-ticker');
    
    if (tickerText) {
        tickerText.textContent = `Ongoing: ${ongoing} | Pending: ${pending}`;
    }
    if (tickerDot) {
        if (ongoing > 0) {
            tickerDot.className = 'ticker-dot active';
            if (tickerBadge) tickerBadge.classList.add('active');
        } else {
            tickerDot.className = 'ticker-dot';
            if (tickerBadge) tickerBadge.classList.remove('active');
        }
    }
}

function updateTaskInUI(task) {
    if (loadedTasks[task.task_id]) {
        Object.assign(loadedTasks[task.task_id], task);
    } else {
        loadedTasks[task.task_id] = task;
    }
    
    // 1. Update Desktop Row
    const row = document.getElementById(`row-${task.task_id}`);
    if (row) {
        const badge = row.querySelector('.status-badge');
        if (badge) updateTaskBadge(badge, task);
        
        const chk = row.querySelector('.task-checkbox');
        if (chk) chk.checked = selectedTaskIds.has(task.task_id);
        
        const timeline = row.querySelector('.task-timeline');
        if (timeline) {
            const shortId = task.task_id.split('-')[0];
            const qBadge = task.queue_name ? `<div style="margin-top: 5px;"><strong style="color: var(--text-secondary);">Queue:</strong> <span style="color: var(--accent-primary); text-transform: uppercase; font-size: 0.9em; font-weight: bold;">${task.queue_name}</span></div>` : '';
            timeline.innerHTML = `
                <div><strong style="color: var(--text-secondary);">Started:</strong><br>${formatTime(task.start_time)}</div>
                <div style="margin-top: 5px;"><strong style="color: var(--text-secondary);">Ended:</strong><br>${formatTime(task.end_time)}</div>
                ${qBadge}
            `;
        }
    } else {
        // If row is not present on current page, re-render tasks
        renderTasks(loadedTasks);
    }

    // 2. Update Mobile Card
    renderTaskCard(task);
}

function appendLogChunk(taskId, chunk) {
    if (loadedTasks[taskId]) {
        loadedTasks[taskId].output = (loadedTasks[taskId].output || '') + chunk;
    }

    // 1. Update Desktop Table pre
    const row = document.getElementById(`row-${taskId}`);
    const deskPre = row ? row.querySelector('.log-output') : null;
    if (deskPre) {
        if (deskPre.querySelector('.btn-lazy-load')) deskPre.innerHTML = '';
        deskPre.textContent += chunk;
        if (deskPre.textContent.length > 150000) {
            deskPre.textContent = deskPre.textContent.slice(-100000);
        }
        const state = getScrollState(taskId);
        if (state.locked) {
            deskPre.scrollTop = deskPre.scrollHeight;
        }
    }

    // 2. Update Mobile Card pre
    const mobPre = document.getElementById(`terminal-card-${taskId}`);
    if (mobPre) {
        mobPre.textContent += chunk;
        if (mobPre.textContent.length > 150000) {
            mobPre.textContent = mobPre.textContent.slice(-100000);
        }
        const state = getScrollState(taskId);
        if (state.locked) {
            mobPre.scrollTop = mobPre.scrollHeight;
        }
    }
}

async function copyLog(taskId, btn) {
    const text = loadedTasks[taskId]?.output || '';
    if (!text) {
        showToast('No log content to copy.', 'warning');
        return;
    }
    try {
        await navigator.clipboard.writeText(text);
        showToast('Log copied to clipboard.', 'success');
    } catch (e) {
        showToast('Failed to copy to clipboard.', 'error');
    }
}

// --------------------------------------------------------------------------
// NAVIGATION SYSTEM (DESKTOP & MOBILE BOTTOM NAV)
// --------------------------------------------------------------------------
function switchTab(tabId) {
    // 1. Desktop Nav Links
    document.querySelectorAll('.nav-btn').forEach(btn => btn.classList.remove('active'));
    const activeDesktopBtn = document.getElementById(`btn-${tabId}`);
    if (activeDesktopBtn) activeDesktopBtn.classList.add('active');

    // 2. Mobile Bottom Nav Buttons
    document.querySelectorAll('.bottom-nav-btn').forEach(btn => btn.classList.remove('active'));
    const activeMobileBtn = document.getElementById(`bottom-btn-${tabId}`);
    if (activeMobileBtn) activeMobileBtn.classList.add('active');

    // 3. Tab Panels
    const tabTasks = document.getElementById('tab-tasks');
    const tabUtils = document.getElementById('tab-utilities');
    const tabLibs = document.getElementById('tab-libraries');
    if (tabTasks) tabTasks.style.display = 'none';
    if (tabUtils) tabUtils.style.display = 'none';
    if (tabLibs) tabLibs.style.display = 'none';

    const activeContent = document.getElementById(`tab-${tabId}`);
    if (activeContent) activeContent.style.display = 'block';

    // Utilities Tab Monitoring
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
    
    // Libraries Tab Loading
    if (tabId === 'libraries') {
        fetchLibrariesList();
    }
}

// --------------------------------------------------------------------------
// TASKS QUEUE FETCHING & RENDERING
// --------------------------------------------------------------------------
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
            Object.assign(loadedTasks, newTasks);
            tasksOffset = offset;
        }
        
        hasMoreTasks = newTasksCount === tasksLimit;
        renderTasks(loadedTasks);
        
        const loadMoreContainer = document.getElementById('tasks-load-more-container');
        if (loadMoreContainer) {
            loadMoreContainer.style.display = hasMoreTasks ? 'block' : 'none';
        }
    } catch (error) {
        console.error("Failed to fetch tasks:", error);
        showToast("Failed to load tasks from server.", "error");
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
        btn.textContent = "Loading...";
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
            const mobPre = document.getElementById(`terminal-card-${taskId}`);
            if (mobPre) {
                mobPre.textContent = task.output || '(No log output)';
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

function updateTaskBadge(badgeElement, task) {
    if (badgeElement.dataset.status !== task.status) {
        let badgeContent = `<span title="${task.status}">${getStatusIcon(task.status)}</span>`;
        
        if (task.status === 'Running' || task.status === 'Pending') {
            badgeContent += `<button class="btn btn-danger btn-icon" onclick="cancelTask('${task.task_id}')" title="Cancel Task" aria-label="Cancel Task">🛑</button>`;
        }
        
        if (task.status.includes('Failed') || task.status.includes('Interrupted') || task.status === 'Cancelled') {
            badgeContent += `<button class="btn btn-secondary btn-icon" onclick="retryTask('${task.task_id}')" title="Retry Task" aria-label="Retry Task">↻</button>`;
        }
        
        badgeElement.innerHTML = `<div style="display: flex; align-items: center; justify-content: center; gap: 6px;">${badgeContent}</div>`;
        badgeElement.dataset.status = task.status;
    }
}

function getStatusIcon(status) {
    if (!status) return '⏺';
    if (status.includes('Pending')) return '<span class="status-pending" style="padding: 2px 6px; border-radius: 2px;">⏳ PENDING</span>';
    if (status.includes('Running')) return '<span class="status-running" style="padding: 2px 6px; border-radius: 2px;">⚡ RUNNING</span>';
    if (status.includes('Completed')) return '<span class="status-completed" style="padding: 2px 6px; border-radius: 2px;">✓ DONE</span>';
    if (status.includes('Failed')) return '<span class="status-failed" style="padding: 2px 6px; border-radius: 2px;">✕ FAILED</span>';
    if (status.includes('Cancelled')) return '<span class="status-cancelled" style="padding: 2px 6px; border-radius: 2px;">⊘ CANCELLED</span>';
    return status;
}

function renderTasks(tasks) {
    const tbody = document.querySelector('#tasks-table tbody');
    const taskList = Object.values(tasks).sort((a, b) => new Date(b.start_time) - new Date(a.start_time));

    // Clear desktop placeholder
    if (tbody.firstElementChild && !tbody.firstElementChild.id) {
        tbody.firstElementChild.remove();
    }

    if (taskList.length === 0) {
        tbody.innerHTML = `<tr><td colspan="5" style="text-align: center; color: var(--text-muted); padding: 30px;">No tasks found matching the selected filters.</td></tr>`;
        const cardContainer = document.getElementById('tasks-card-container');
        if (cardContainer) {
            cardContainer.innerHTML = `<div class="card" style="text-align: center; color: var(--text-muted); padding: 20px;">No tasks found.</div>`;
        }
        return;
    }

    // Render Desktop Rows
    taskList.forEach((task, index) => {
        let tr = document.getElementById(`row-${task.task_id}`);
        const shortId = task.task_id.split('-')[0];
        let queueBadge = '';
        if (task.queue_name) {
            queueBadge = `<div style="margin-top: 5px;"><strong style="color: var(--text-secondary);">Queue:</strong> <span style="color: var(--accent-primary); text-transform: uppercase; font-size: 0.9em; font-weight: bold;">${task.queue_name}</span></div>`;
        }

        const detailsHtml = `
            <div style="font-weight: bold; color: var(--accent-primary); margin-bottom: 6px;">ID: ${shortId}</div>
            <div class="task-timeline" style="font-size: 0.8em; color: var(--text-muted); line-height: 1.4;">
                <div><strong style="color: var(--text-secondary);">Started:</strong><br>${formatTime(task.start_time)}</div>
                <div style="margin-top: 5px;"><strong style="color: var(--text-secondary);">Ended:</strong><br>${formatTime(task.end_time)}</div>
                ${queueBadge}
            </div>
        `;

        if (!tr) {
            tr = document.createElement('tr');
            tr.id = `row-${task.task_id}`;
            tr.innerHTML = `
                <td style="vertical-align: top; text-align: center;"><div class="task-checkbox-wrap"><input type="checkbox" class="task-checkbox" data-task-id="${task.task_id}" ${selectedTaskIds.has(task.task_id) ? 'checked' : ''} onchange="toggleTaskSelection('${task.task_id}', this.checked)" aria-label="Select task ${shortId}"></div></td>
                <td style="vertical-align: top;">${detailsHtml}</td>
                <td style="vertical-align: top;"><pre style="margin:0; white-space: pre-wrap; word-wrap: break-word; font-family: var(--font-family-mono); font-size: var(--font-size-xs); color: var(--text-primary);"><code>${escapeHtml(task.command)}</code></pre></td>
                <td style="vertical-align: top; text-align: center;"><div class="status-badge"></div></td>
                <td style="vertical-align: top;"><pre class="log-output" id="terminal-${task.task_id}"></pre></td>
            `;
        } else {
            const chk = tr.querySelector('.task-checkbox');
            if (chk) chk.checked = selectedTaskIds.has(task.task_id);
            const detailsCell = tr.children[1];
            if (detailsCell) detailsCell.innerHTML = detailsHtml;
        }

        if (tbody.children[index] !== tr) {
            tbody.insertBefore(tr, tbody.children[index]);
        }

        const badge = tr.querySelector('.status-badge');
        const preElement = tr.querySelector('.log-output');
        updateTaskBadge(badge, task);

        let displayData = task.output || '';
        if (task.status.includes('Failed') && !displayData) displayData = task.error || 'Execution failed.';

        if (task.status !== 'Running' && !task.output) {
            if (!preElement.querySelector('.btn-lazy-load')) {
                preElement.innerHTML = `<button class="btn btn-secondary btn-sm btn-lazy-load" onclick="lazyLoadTaskOutput('${task.task_id}', this)">📄 View Logs</button>`;
            }
        } else {
            if (preElement.textContent !== displayData || preElement.querySelector('.btn-lazy-load')) {
                preElement.textContent = displayData || '...';
                const state = getScrollState(task.task_id);
                if (state.locked) {
                    setTimeout(() => { preElement.scrollTop = preElement.scrollHeight; }, 0);
                }
            }
        }

        // Render Mobile Card Synchronously
        renderTaskCard(task);
    });

    // Prune removed desktop rows
    while (tbody.children.length > taskList.length) {
        tbody.lastElementChild.remove();
    }

    syncCheckboxStates();
    updateBatchDock();
}

function renderTaskCard(task) {
    const container = document.getElementById('tasks-card-container');
    if (!container) return;

    let card = document.getElementById(`card-${task.task_id}`);
    const shortId = task.task_id.split('-')[0];
    const qName = (task.queue_name || 'default').toLowerCase();
    const statusClass = `status-${(task.status || 'pending').toLowerCase().split(' ')[0].replace(/[^a-z]/g, '')}`;

    let actionsHtml = '';
    if (task.status === 'Running' || task.status === 'Pending') {
        actionsHtml += `<button class="btn btn-danger btn-icon" onclick="cancelTask('${task.task_id}')" title="Cancel Task" aria-label="Cancel Task">🛑</button>`;
    }
    if (task.status.includes('Failed') || task.status.includes('Interrupted') || task.status === 'Cancelled') {
        actionsHtml += `<button class="btn btn-secondary btn-icon" onclick="retryTask('${task.task_id}')" title="Retry Task" aria-label="Retry Task">↻</button>`;
    }
    actionsHtml += `<button class="btn btn-secondary btn-icon" onclick="copyLog('${task.task_id}', this)" title="Copy Log" aria-label="Copy Log">📋</button>`;

    const cardHtml = `
        <header class="task-card-header">
            <div style="display: flex; align-items: center; gap: 8px;">
                <input type="checkbox" class="task-checkbox" data-task-id="${task.task_id}" ${selectedTaskIds.has(task.task_id) ? 'checked' : ''} onchange="toggleTaskSelection('${task.task_id}', this.checked)" aria-label="Select task ${shortId}">
                <div class="task-id-badge">
                    <span class="queue-chip queue-${qName}">${(task.queue_name || 'DEFAULT').toUpperCase()}</span>
                    <code class="task-id-code">#${shortId}</code>
                </div>
            </div>
            <div class="task-status-pill ${statusClass}" role="status" aria-label="Status: ${task.status}">
                ${task.status === 'Running' ? '<span class="ticker-dot active" style="margin-right: 4px;"></span>' : ''}
                ${task.status}
            </div>
        </header>

        <div class="task-command-block">
            <code class="task-command-code">${escapeHtml(task.command || '')}</code>
        </div>

        <dl class="task-meta-grid">
            <div class="meta-item">
                <dt>STARTED</dt>
                <dd>${formatTime(task.start_time)}</dd>
            </div>
            <div class="meta-item">
                <dt>ENDED</dt>
                <dd>${formatTime(task.end_time)}</dd>
            </div>
        </dl>

        <details class="task-log-details" open>
            <summary style="cursor: pointer; font-size: 0.8em; color: var(--text-muted); margin-bottom: 6px; display: flex; justify-content: space-between;">
                <span>TERMINAL READOUT</span>
                <span style="color: var(--accent-primary); font-family: var(--font-family-mono);">LIVE</span>
            </summary>
            <div class="terminal-toolbar">
                <button class="terminal-tool-btn btn-lock-active" onclick="toggleScrollLock('${task.task_id}', this)">
                    🔒 LOCK SCROLL
                </button>
            </div>
            <pre class="task-log-terminal" id="terminal-card-${task.task_id}" onscroll="handleUserTerminalScroll('${task.task_id}')">${escapeHtml(task.output || (task.status === 'Running' ? '...' : '(No output)'))}</pre>
        </details>

        <footer class="task-card-footer">
            ${actionsHtml}
        </footer>
    `;

    if (!card) {
        card = document.createElement('article');
        card.className = 'task-card';
        card.id = `card-${task.task_id}`;
        card.dataset.status = task.status;
        card.innerHTML = cardHtml;
        container.appendChild(card);
    } else {
        card.dataset.status = task.status;
        card.innerHTML = cardHtml;
        const chk = card.querySelector('.task-checkbox');
        if (chk) chk.checked = selectedTaskIds.has(task.task_id);
    }
}

// --------------------------------------------------------------------------
// TASK ACTIONS: CANCEL, RETRY, PURGE, FILTERS
// --------------------------------------------------------------------------
async function cancelTask(taskId) {
    const ok = await showAppConfirm("Are you sure you want to cancel this task?");
    if (!ok) return;
    try {
        const response = await fetch(`/api/tasks/${taskId}/cancel`, { method: 'POST' });
        if (!response.ok) {
            const data = await response.json();
            showToast(`Error: ${data.detail}`, 'error');
            return;
        }
        showToast("Task cancelled successfully.", "info");
    } catch (error) {
        showToast("Failed to cancel task: " + error.message, "error");
    }
}

async function retryTask(taskId) {
    try {
        const response = await fetch(`/api/tasks/${taskId}/retry`, { method: 'POST' });
        if (!response.ok) {
            const data = await response.json();
            showToast(`Error: ${data.detail}`, 'error');
            return;
        }
        showToast("Task requeued successfully.", "success");
    } catch (error) {
        showToast("Failed to retry task: " + error.message, "error");
    }
}

async function purgeTasks() {
    const ageSelect = document.getElementById('purge-age');
    if (!ageSelect) return;
    const age = ageSelect.value;
    
    let msg = `Purge tasks older than ${ageSelect.options[ageSelect.selectedIndex].text}?`;
    if (age === 'all') {
        msg = "Purge the entire tasks queue history? (Active tasks will not be affected)";
    }
    
    const ok = await showAppConfirm(msg);
    if (!ok) return;
    
    try {
        const response = await fetch(`/api/tasks/purge?age=${age}`, { method: 'POST' });
        const data = await response.json();
        if (response.ok) {
            showToast(data.message, "success");
            applyFilters();
        } else {
            showToast(`Error: ${data.detail}`, "error");
        }
    } catch (error) {
        showToast("Failed to purge tasks: " + error.message, "error");
    }
}

// --------------------------------------------------------------------------
// BATCH OPERATIONS & SELECTION MANAGEMENT (MVP 2)
// --------------------------------------------------------------------------
function toggleTaskSelection(taskId, isSelected) {
    if (isSelected) {
        selectedTaskIds.add(taskId);
    } else {
        selectedTaskIds.delete(taskId);
    }
    triggerHaptic(10);
    syncCheckboxStates();
    updateBatchDock();
}

function toggleSelectAll(selectAll) {
    const taskIds = Object.keys(loadedTasks);
    if (selectAll) {
        taskIds.forEach(id => selectedTaskIds.add(id));
    } else {
        selectedTaskIds.clear();
    }
    triggerHaptic(15);
    syncCheckboxStates();
    updateBatchDock();
}

function deselectAllTasks() {
    selectedTaskIds.clear();
    syncCheckboxStates();
    updateBatchDock();
}

function syncCheckboxStates() {
    const allTaskIds = Object.keys(loadedTasks);
    const allSelected = allTaskIds.length > 0 && allTaskIds.every(id => selectedTaskIds.has(id));
    
    const deskAll = document.getElementById('select-all-desktop');
    if (deskAll) deskAll.checked = allSelected;
    const mobAll = document.getElementById('select-all-mobile');
    if (mobAll) mobAll.checked = allSelected;
    
    document.querySelectorAll('.task-checkbox[data-task-id]').forEach(cb => {
        const tid = cb.dataset.taskId;
        cb.checked = selectedTaskIds.has(tid);
    });
}

function updateBatchDock() {
    const dock = document.getElementById('batch-action-dock');
    const countLabel = document.getElementById('batch-selection-count');
    if (!dock) return;
    
    const count = selectedTaskIds.size;
    if (count > 0) {
        if (countLabel) countLabel.textContent = `${count} Task${count > 1 ? 's' : ''} Selected`;
        dock.style.display = 'block';
    } else {
        dock.style.display = 'none';
    }
}

async function batchCancelSelected() {
    if (selectedTaskIds.size === 0) return;
    const ids = Array.from(selectedTaskIds);
    const ok = await showAppConfirm(`Are you sure you want to cancel ${ids.length} selected task(s)?`);
    if (!ok) return;
    
    showLoading(40);
    try {
        const res = await fetch('/api/tasks/batch/cancel', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ task_ids: ids })
        });
        const data = await res.json();
        if (res.ok) {
            showToast(data.message || `Cancelled ${data.cancelled_count} task(s).`, 'success');
            triggerHaptic(20);
            deselectAllTasks();
            fetchTasks(tasksOffset);
        } else {
            showToast(`Batch cancel failed: ${data.detail || data.message}`, 'error');
        }
    } catch (err) {
        showToast(`Batch cancel error: ${err.message}`, 'error');
    } finally {
        hideLoading();
    }
}

async function batchRetrySelected() {
    if (selectedTaskIds.size === 0) return;
    const ids = Array.from(selectedTaskIds);
    const ok = await showAppConfirm(`Are you sure you want to retry ${ids.length} selected task(s)?`);
    if (!ok) return;
    
    showLoading(40);
    try {
        const res = await fetch('/api/tasks/batch/retry', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ task_ids: ids })
        });
        const data = await res.json();
        if (res.ok) {
            showToast(data.message || `Requeued ${data.retried_count} task(s).`, 'success');
            triggerHaptic(20);
            deselectAllTasks();
            fetchTasks(tasksOffset);
        } else {
            showToast(`Batch retry failed: ${data.detail || data.message}`, 'error');
        }
    } catch (err) {
        showToast(`Batch retry error: ${err.message}`, 'error');
    } finally {
        hideLoading();
    }
}

async function batchPurgeSelected() {
    if (selectedTaskIds.size === 0) return;
    const ids = Array.from(selectedTaskIds);
    const ok = await showAppConfirm(`Are you sure you want to purge ${ids.length} selected task(s) from history?`);
    if (!ok) return;
    
    showLoading(40);
    try {
        const res = await fetch('/api/tasks/batch/purge', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ task_ids: ids })
        });
        const data = await res.json();
        if (res.ok) {
            showToast(data.message || `Purged ${data.purged_count} task(s).`, 'success');
            triggerHaptic(20);
            deselectAllTasks();
            applyFilters();
        } else {
            showToast(`Batch purge failed: ${data.detail || data.message}`, 'error');
        }
    } catch (err) {
        showToast(`Batch purge error: ${err.message}`, 'error');
    } finally {
        hideLoading();
    }
}

function applyFilters() {
    loadedTasks = {};
    const cardContainer = document.getElementById('tasks-card-container');
    if (cardContainer) cardContainer.innerHTML = '';
    fetchTasks(0);
}

function applyFiltersWithDebounce() {
    if (filterDebounceTimeout) clearTimeout(filterDebounceTimeout);
    filterDebounceTimeout = setTimeout(applyFilters, 300);
}

function clearFilters() {
    const q = document.getElementById('filter-queue');
    const s = document.getElementById('filter-status');
    const c = document.getElementById('filter-command');
    if (q) q.value = '';
    if (s) s.value = '';
    if (c) c.value = '';
    applyFilters();
}

// --------------------------------------------------------------------------
// FFMPEG MEDIA TRANSCODING
// --------------------------------------------------------------------------
async function fetchProfiles() {
    try {
        const response = await fetch('/api/config/ffmpeg');
        const data = await response.json();
        ffmpegConfig = data.profiles || {};
        
        const profileSelect = document.getElementById('ffmpeg-profile');
        if (!profileSelect) return;
        profileSelect.innerHTML = '';
        
        Object.keys(ffmpegConfig).forEach(profileName => {
            const option = document.createElement('option');
            option.value = profileName;
            option.textContent = profileName;
            profileSelect.appendChild(option);
        });
        
        onProfileChange();
    } catch (error) {
        console.error("Failed to load FFMPEG profiles:", error);
    }
}

function onProfileChange() {
    const profileSelect = document.getElementById('ffmpeg-profile');
    if (!profileSelect) return;
    const profileName = profileSelect.value;
    const profileData = ffmpegConfig[profileName];
    
    const modeSelect = document.getElementById('ffmpeg-mode');
    if (!modeSelect) return;
    modeSelect.innerHTML = '';
    
    const singleOption = document.createElement('option');
    singleOption.value = 'single';
    singleOption.textContent = 'Single File Processing';
    modeSelect.appendChild(singleOption);
    
    if (profileData && profileData.batch_compatible) {
        const batchOption = document.createElement('option');
        batchOption.value = 'batch';
        batchOption.textContent = 'Batch Folder Processing';
        modeSelect.appendChild(batchOption);
    }
    
    updateFfmpegUI();
}

function updateFfmpegUI() {
    const mode = document.getElementById('ffmpeg-mode')?.value;
    const lblInput = document.getElementById('lbl-ffmpeg-input');
    const lblOutput = document.getElementById('lbl-ffmpeg-output');
    const inputField = document.getElementById('ffmpeg-input');
    const outputField = document.getElementById('ffmpeg-output');
    const extContainer = document.getElementById('batch-ext-container');
    const extSelect = document.getElementById('ffmpeg-ext');
    
    if (!mode || !lblInput || !lblOutput || !inputField || !outputField || !extContainer || !extSelect) return;

    if (mode === 'batch') {
        lblInput.textContent = "Source Directory";
        inputField.placeholder = "/path/to/source_folder/";
        lblOutput.textContent = "Destination Directory";
        outputField.placeholder = "/path/to/destination_folder/";
        
        extContainer.style.display = "block";
        extSelect.innerHTML = '';
        
        const profileName = document.getElementById('ffmpeg-profile').value;
        const profileData = ffmpegConfig[profileName];
        const allowedExts = profileData?.allowed_extensions || ['.mp4', '.mkv'];
        
        allowedExts.forEach(ext => {
            const opt = document.createElement('option');
            opt.value = ext;
            opt.textContent = ext;
            extSelect.appendChild(opt);
        });
    } else {
        lblInput.textContent = "Input Path";
        inputField.placeholder = "/path/to/input.mp4";
        lblOutput.textContent = "Output Path";
        outputField.placeholder = "/path/to/output.mkv";
        extContainer.style.display = "none";
    }
}

async function executeFfmpeg() {
    const inputPath = document.getElementById('ffmpeg-input').value.trim();
    const outputPath = document.getElementById('ffmpeg-output').value.trim();
    const profile = document.getElementById('ffmpeg-profile').value;
    const mode = document.getElementById('ffmpeg-mode').value;
    const outputExt = document.getElementById('ffmpeg-ext')?.value || '.mp4';

    if (!inputPath || !outputPath) {
        showToast("Please provide both input and output destinations.", "warning");
        return;
    }

    try {
        const response = await fetch('/api/execute/ffmpeg', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                input_target: inputPath,
                output_target: outputPath,
                profile: profile,
                mode: mode,
                output_extension: outputExt
            })
        });

        const data = await response.json();
        if (response.ok) {
            showToast(data.message, "success");
            fetchTasks();
            setTimeout(() => switchTab('tasks'), 400);
        } else {
            showToast(`Transcode failed: ${data.detail}`, "error");
        }
    } catch (error) {
        showToast("Failed to queue FFMPEG task: " + error.message, "error");
    }
}

// --------------------------------------------------------------------------
// FILESYSTEM EXPLORER & OPERATIONS
// --------------------------------------------------------------------------
async function fetchFsConfig() {
    try {
        const response = await fetch('/api/config/fs');
        const data = await response.json();
        fsConfig = data.actions || {};
        
        const select = document.getElementById('fs-action-select');
        if (!select) return;
        select.innerHTML = '<option value="">Select Action...</option>';
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

async function fetchBookmarks() {
    try {
        const response = await fetch('/api/config/bookmarks');
        const bookmarks = await response.json();
        
        const datalist = document.getElementById('bookmarks-list');
        if (!datalist) return;
        datalist.innerHTML = ''; 
        
        Object.entries(bookmarks).forEach(([name, path]) => {
            const option = document.createElement('option');
            option.value = path;
            option.textContent = name;
            datalist.appendChild(option);
        });
    } catch (error) {
        console.error("Failed to load bookmarks:", error);
    }
}

async function fetchRemotesConfig() {
    try {
        const response = await fetch('/api/config/remotes');
        remotesConfig = await response.json();
        
        const serverSelect = document.getElementById('fs-remote-server');
        const exploreSelect = document.getElementById('fs-explore-server');
        
        if (serverSelect) serverSelect.innerHTML = '<option value="">Target Remote...</option>';
        if (exploreSelect) exploreSelect.innerHTML = '<option value="">Local Filesystem</option>';
        
        Object.keys(remotesConfig).forEach(serverName => {
            if (serverSelect) {
                const opt = document.createElement('option');
                opt.value = serverName;
                opt.textContent = serverName;
                serverSelect.appendChild(opt);
            }
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
    const datalist = document.getElementById('bookmarks-list');
    if (!datalist || !pathInput) return;
    datalist.innerHTML = '';
    
    if (serverName && remotesConfig[serverName] && remotesConfig[serverName].bookmarks) {
        const bookmarks = remotesConfig[serverName].bookmarks;
        Object.entries(bookmarks).forEach(([name, path]) => {
            const opt = document.createElement('option');
            opt.value = path;
            opt.textContent = name;
            datalist.appendChild(opt);
        });
        const firstPath = Object.values(bookmarks)[0] || '/';
        pathInput.value = firstPath;
    } else {
        await fetchBookmarks();
        pathInput.value = '/';
    }
}

async function openExplorer() {
    const remoteServer = document.getElementById('fs-explore-server').value;
    const targetPath = document.getElementById('fs-explore-path').value.trim() || '/';
    const modal = document.getElementById('explorer-modal');
    const title = document.getElementById('explorer-title');
    const list = document.getElementById('explorer-list');

    modal.style.display = 'flex';
    title.textContent = `Browsing ${remoteServer ? remoteServer : 'Local'}: ${targetPath}`;
    list.innerHTML = '<div style="padding: 20px; text-align: center; color: var(--text-muted);">Loading files...</div>';

    try {
        const response = await fetch(`/api/fs/list?target_path=${encodeURIComponent(targetPath)}&remote_server=${encodeURIComponent(remoteServer)}`);
        const data = await response.json();

        if (response.ok) {
            document.getElementById('fs-explore-path').value = data.target_path;
            title.textContent = `Browsing ${remoteServer ? remoteServer : 'Local'}: ${data.target_path}`;
            renderExplorerList(data.items, data.parent_path);
        } else {
            list.innerHTML = `<div style="padding: 20px; color: var(--status-failed);">Error: ${data.detail || 'Could not load directory'}</div>`;
        }
    } catch (error) {
        list.innerHTML = `<div style="padding: 20px; color: var(--status-failed);">Connection Error.</div>`;
    }
}

function closeExplorer() {
    document.getElementById('explorer-modal').style.display = 'none';
    const sel = document.getElementById('fs-action-select');
    if (sel) sel.value = '';
    onFsActionChange(); 
}

function browseToFolder(path) {
    document.getElementById('fs-explore-path').value = path;
    openExplorer();
}

function renderExplorerList(items, parentPath) {
    const list = document.getElementById('explorer-list');
    list.innerHTML = '';

    if (parentPath) {
        const pDiv = document.createElement('div');
        pDiv.className = 'file-item';
        pDiv.style.cursor = 'pointer';
        pDiv.onclick = () => browseToFolder(parentPath);
        pDiv.innerHTML = `
            <div style="display: flex; align-items: center; gap: 8px;">
                <span>📁</span>
                <span class="file-name" style="font-weight: bold; color: var(--accent-primary);">.. (Parent Directory)</span>
            </div>
            <button class="btn btn-secondary btn-sm" style="pointer-events: none;">Go Up</button>
        `;
        list.appendChild(pDiv);
    }

    if (items.length === 0 && !parentPath) {
        list.innerHTML = '<div style="padding: 20px; text-align: center; color: var(--text-muted);">Directory is empty.</div>';
        return;
    }

    items.forEach(item => {
        const div = document.createElement('div');
        div.className = 'file-item';
        
        const icon = item.is_dir ? '📁' : '📄';
        const sizeStr = item.is_dir ? '' : `(${(item.size / 1024 / 1024).toFixed(2)} MB)`;

        div.innerHTML = `
            <div style="display: flex; align-items: center; gap: 8px; flex-grow: 1; overflow: hidden;">
                <input type="checkbox" class="fs-checkbox" value="${item.path}">
                <span>${icon}</span>
                <span class="file-name" style="text-overflow: ellipsis; overflow: hidden; white-space: nowrap;">${escapeHtml(item.name)}</span>
                <span class="file-size">${sizeStr}</span>
            </div>
            <div style="display: flex; gap: 6px; flex-shrink: 0;">
                ${item.is_dir ? `<button class="btn btn-secondary btn-icon" onclick="event.stopPropagation(); browseToFolder('${item.path}')" title="Browse">📂</button>` : ''}
                <button class="btn btn-secondary btn-icon" onclick="event.stopPropagation(); renameExplorerItem('${item.path}', '${item.name}')" title="Rename">✏️</button>
            </div>
        `;
        list.appendChild(div);
    });
}

async function renameExplorerItem(path, oldName) {
    const newName = await showAppPrompt(`Enter new name for "${oldName}":`, oldName);
    if (!newName || newName.trim() === "" || newName === oldName) return;
    
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
            showToast(`Renamed to ${newName}`, 'success');
            openExplorer();
        } else {
            showToast(`Rename error: ${data.detail}`, 'error');
        }
    } catch (error) {
        showToast("Failed to connect to engine: " + error.message, 'error');
    }
}

function onFsActionChange() {
    const action = document.getElementById('fs-action-select')?.value;
    const destInput = document.getElementById('fs-dest-path');
    const remoteSelect = document.getElementById('fs-remote-server');
    
    if (!action || !fsConfig[action]) {
        if (destInput) destInput.style.display = 'none';
        if (remoteSelect) remoteSelect.style.display = 'none';
        return;
    }

    const isRemote = fsConfig[action].requires_remote;
    const requiresDest = fsConfig[action].requires_destination;

    if (isRemote) {
        if (remoteSelect) remoteSelect.style.display = 'block';
        if (destInput) {
            destInput.style.display = 'block';
            destInput.setAttribute('list', 'remote-bookmarks-list');
            destInput.placeholder = "Remote Target Path...";
        }
        onRemoteServerChange();
    } else if (requiresDest) {
        if (remoteSelect) {
            remoteSelect.style.display = 'none';
            remoteSelect.value = '';
        }
        if (destInput) {
            destInput.style.display = 'block';
            destInput.setAttribute('list', 'bookmarks-list');
            destInput.placeholder = "Destination Path (e.g. /dest/)";
        }
    } else {
        if (remoteSelect) remoteSelect.style.display = 'none';
        if (destInput) {
            destInput.style.display = 'none';
            destInput.value = '';
        }
    }
}

function onRemoteServerChange() {
    const serverName = document.getElementById('fs-remote-server')?.value;
    const datalist = document.getElementById('remote-bookmarks-list');
    if (!datalist) return;
    datalist.innerHTML = '';

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
    const remoteServer = document.getElementById('fs-remote-server').value;
    const sourceServer = document.getElementById('fs-explore-server').value;
    
    const checkboxes = document.querySelectorAll('.fs-checkbox:checked');
    const sourcePaths = Array.from(checkboxes).map(cb => cb.value);

    if (sourcePaths.length === 0) {
        showToast("Please select at least one file or folder.", "warning");
        return;
    }
    if (!action) {
        showToast("Please select an action to perform.", "warning");
        return;
    }
    if (fsConfig[action]?.requires_destination && !destInput) {
        showToast(`Action '${action}' requires a destination path.`, "warning");
        return;
    }
    if (fsConfig[action]?.requires_remote && !remoteServer) {
        showToast(`Action '${action}' requires a target Remote Server.`, "warning");
        return;
    }

    try {
        const res = await fetch('/api/execute/fs', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                action: action,
                source_paths: sourcePaths,
                destination_path: destInput,
                remote_server: remoteServer,
                source_server: sourceServer
            })
        });

        const data = await res.json();
        if (res.ok) {
            showToast(data.message, "success");
            closeExplorer();
            fetchTasks();
            setTimeout(() => switchTab('tasks'), 400);
        } else {
            showToast(`Batch failed: ${data.detail}`, "error");
        }
    } catch (error) {
        showToast("Failed to queue file operations: " + error.message, "error");
    }
}

// --------------------------------------------------------------------------
// SYSTEM SWITCHBOARD & CUSTOM CARDS
// --------------------------------------------------------------------------
async function fetchSwitchboardConfig() {
    try {
        const response = await fetch('/api/config/switchboard');
        const switchboard = await response.json();
        const container = document.getElementById('switchboard-container');
        if (!container) return;
        container.innerHTML = '';
        
        Object.entries(switchboard).forEach(([category, data]) => {
            const catDiv = document.createElement('div');
            catDiv.style.cssText = "display: flex; flex-direction: column; gap: 8px;";
            catDiv.innerHTML = `<h5 style="color: var(--text-secondary); text-transform: uppercase; margin-bottom: 4px;">${category}</h5>`;
            
            Object.keys(data.buttons || {}).forEach(btnName => {
                const btn = document.createElement('button');
                btn.className = "btn-switch";
                btn.textContent = btnName;
                btn.onclick = () => fireSwitchboard(category, btnName, btn);
                catDiv.appendChild(btn);
            });
            container.appendChild(catDiv);
        });
    } catch (error) {
        console.error("Failed to load Switchboard config:", error);
    }
}

async function fireSwitchboard(category, btnName, btnElement) {
    const originalText = btnElement.textContent;
    btnElement.disabled = true;
    btnElement.textContent = "Running...";

    try {
        const response = await fetch('/api/execute/switchboard', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ category, button_name: btnName })
        });

        const data = await response.json();

        if (response.ok) {
            btnElement.textContent = "✓ Success";
            if (data.type === "immediate" || data.type === "detached") {
                document.getElementById('sb-modal-title').textContent = `${btnName} Result`;
                document.getElementById('sb-modal-output').textContent = data.output || 'Command executed.';
                document.getElementById('switchboard-modal').style.display = 'flex';
            } else {
                showToast(data.message, "success");
                fetchTasks();
            }
        } else {
            btnElement.textContent = "✕ Failed";
            showToast(`Error: ${data.detail}`, "error");
        }
    } catch (error) {
        btnElement.textContent = "✕ Error";
        showToast("Execution failed: " + error.message, "error");
    } finally {
        setTimeout(() => {
            btnElement.textContent = originalText;
            btnElement.disabled = false;
        }, 2000);
    }
}

function closeSwitchboardModal() {
    document.getElementById('switchboard-modal').style.display = 'none';
}

async function fetchGenericCards() {
    try {
        const response = await fetch('/api/config/cards');
        const cards = await response.json();
        const container = document.getElementById('generic-cards-container');
        if (!container) return;
        container.innerHTML = '';
        
        Object.entries(cards).forEach(([cardName, config]) => {
            const cardDiv = document.createElement('div');
            cardDiv.className = 'card';
            const safeName = cardName.replace(/[^a-zA-Z0-9]/g, '-');
            
            let html = `<h4>${escapeHtml(cardName)}</h4>`;
            html += `<form id="form-${safeName}">`;
            
            (config.fields || []).forEach(f => {
                html += `<div style="margin-bottom: 12px;">`;
                html += `<label for="${safeName}-${f.name}">${escapeHtml(f.label || f.name)}</label>`;
                if (f.type === 'path') {
                    html += `<input type="text" id="${safeName}-${f.name}" list="bookmarks-list" value="${escapeHtml(f.default || '')}">`;
                } else {
                    html += `<input type="text" id="${safeName}-${f.name}" value="${escapeHtml(f.default || '')}">`;
                }
                html += `</div>`;
            });

            html += `<button type="submit" class="btn btn-primary" style="width: 100%;">Queue Task</button>`;
            html += `</form>`;
            
            cardDiv.innerHTML = html;
            container.appendChild(cardDiv);

            const formElement = cardDiv.querySelector('form');
            formElement.onsubmit = (e) => {
                e.preventDefault();
                fireGenericTask(cardName, safeName, formElement, config.fields);
            };
        });
    } catch (error) {
        console.error("Failed to load custom cards:", error);
    }
}

async function fireGenericTask(cardName, safeName, formElement, fields) {
    const submitBtn = formElement.querySelector('button');
    const originalText = submitBtn.textContent;
    submitBtn.disabled = true;
    submitBtn.textContent = "Queueing...";

    const inputsData = {};
    (fields || []).forEach(f => {
        const field = document.getElementById(`${safeName}-${f.name}`);
        if (field) inputsData[f.name] = field.value;
    });

    try {
        const response = await fetch('/api/execute/generic', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ card_name: cardName, inputs: inputsData })
        });

        const data = await response.json();
        if (response.ok) {
            showToast(data.message, "success");
            formElement.reset();
            fetchTasks();
            setTimeout(() => switchTab('tasks'), 500);
        } else {
            showToast(`Error: ${data.detail}`, "error");
        }
    } catch (error) {
        showToast("Execution failed: " + error.message, "error");
    } finally {
        setTimeout(() => {
            submitBtn.disabled = false;
            submitBtn.textContent = originalText;
        }, 2000);
    }
}

// --------------------------------------------------------------------------
// LOCAL PROCESS MONITOR & SUPERVISOR
// --------------------------------------------------------------------------
async function fetchProcessConfig() {
    try {
        const response = await fetch('/api/config/processes');
        processConfig = await response.json();
        renderProcessListPlaceholder();
    } catch (error) {
        console.error("Failed to fetch process configuration:", error);
    }
}

function renderProcessListPlaceholder() {
    const container = document.getElementById('process-list');
    if (!container) return;
    
    if (Object.keys(processConfig).length === 0) {
        container.innerHTML = `<p style="color: var(--text-muted); font-style: italic;">No processes configured in config.json.</p>`;
        return;
    }
    
    let html = '';
    for (const [name, info] of Object.entries(processConfig)) {
        const safeName = name.replace(/[^a-zA-Z0-9]/g, '-');
        html += `
            <div class="card" id="proc-card-${safeName}" style="padding: 12px; margin-bottom: 10px;">
                <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px;">
                    <div>
                        <strong style="color: var(--accent-primary); font-size: 1.05em;">${escapeHtml(name)}</strong>
                        <span style="font-size: 0.85em; color: var(--text-muted); margin-left: 6px;">(Port: ${info.port})</span>
                    </div>
                    <span class="task-status-pill" id="proc-badge-${safeName}" style="background: var(--bg-surface-elevated); color: var(--text-muted);">Checking...</span>
                </div>
                
                <div style="font-size: 0.85em; background: var(--bg-terminal); padding: 6px 10px; border-radius: var(--radius-hud); font-family: var(--font-family-mono); overflow-x: auto; white-space: nowrap; margin: 8px 0; border: 1px solid var(--border-subtle);">
                    <code>${escapeHtml(info.command)}</code>
                </div>
                
                <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px;">
                    <div style="display: flex; gap: 6px;">
                        <button class="btn btn-secondary btn-sm proc-start-btn" onclick="startProcess('${name}')" disabled>Start</button>
                        <button class="btn btn-secondary btn-sm proc-stop-btn" onclick="stopProcess('${name}', false)" disabled>Stop</button>
                        <button class="btn btn-danger btn-sm proc-kill-btn" onclick="stopProcess('${name}', true)" disabled>Force Kill</button>
                    </div>
                    ${info.log_file ? `<button class="btn btn-secondary btn-sm" onclick="openProcessLogsModal('${name}')">View Logs</button>` : ''}
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
                badge.className = 'task-status-pill status-running';
                
                if (startBtn) startBtn.disabled = true;
                if (stopBtn) stopBtn.disabled = false;
                if (killBtn) killBtn.disabled = false;
            } else {
                badge.textContent = 'Stopped';
                badge.className = 'task-status-pill status-cancelled';
                
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
    if (badge) badge.textContent = 'Starting...';
    
    try {
        const response = await fetch('/api/processes/start', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name })
        });
        const data = await response.json();
        if (response.ok) {
            showToast(`Started process ${name}`, 'success');
            setTimeout(fetchProcessStatuses, 1000);
        } else {
            showToast(`Error starting process: ${data.detail}`, 'error');
            fetchProcessStatuses();
        }
    } catch (error) {
        showToast("Failed to start process: " + error.message, 'error');
        fetchProcessStatuses();
    }
}

async function stopProcess(name, force = false) {
    const safeName = name.replace(/[^a-zA-Z0-9]/g, '-');
    const badge = document.getElementById(`proc-badge-${safeName}`);
    if (badge) badge.textContent = force ? 'Killing...' : 'Stopping...';
    
    try {
        const response = await fetch('/api/processes/stop', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, force })
        });
        const data = await response.json();
        if (response.ok) {
            showToast(`Stopped process ${name}`, 'info');
            setTimeout(fetchProcessStatuses, 1000);
        } else {
            showToast(`Error stopping process: ${data.detail}`, 'error');
            fetchProcessStatuses();
        }
    } catch (error) {
        showToast("Failed to stop process: " + error.message, 'error');
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
        pre.textContent = data.logs || '(Empty logs)';
    } catch (error) {
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

// --------------------------------------------------------------------------
// REPOSITORY LIBRARIES FRONTEND
// --------------------------------------------------------------------------
async function fetchLibrariesList() {
    showLoading(40);
    try {
        const response = await fetch('/api/libraries');
        if (!response.ok) return;
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
    
    if (Object.keys(libraries).length === 0) {
        grid.innerHTML = '<div style="color: var(--text-muted); font-style: italic;">No folder libraries configured.</div>';
        return;
    }
    
    for (const [name, config] of Object.entries(libraries)) {
        const card = document.createElement('div');
        card.className = 'card';
        card.style.cursor = 'pointer';
        card.onclick = () => openLibraryDetail(name, config);
        
        card.innerHTML = `
            <h4 style="color: var(--accent-primary); margin-bottom: 8px;">📁 ${escapeHtml(name)}</h4>
            <div style="font-size: 0.85em; color: var(--text-secondary); line-height: 1.5;">
                <div><strong>Source:</strong> [${config.source?.server}] ${escapeHtml(config.source?.path)}</div>
                <div><strong>Backup:</strong> [${config.backup?.server}] ${escapeHtml(config.backup?.path)}</div>
            </div>
            <div style="margin-top: 12px; display: flex; justify-content: flex-end;">
                <button class="btn btn-primary btn-sm">Explore & Sync →</button>
            </div>
        `;
        grid.appendChild(card);
    }
}

function showLibrariesList() {
    document.getElementById('library-detail-container').style.display = 'none';
    document.getElementById('libraries-list-container').style.display = 'block';
    fetchLibrariesList();
}

async function openLibraryDetail(name, config) {
    currentLibraryName = name;
    currentLibrarySubpath = "";
    currentLibrarySourceBase = config.source?.path || "";
    currentLibrarySourceServer = config.source?.server || "local";
    currentLibraryBackupBase = config.backup?.path || "";
    currentLibraryBackupServer = config.backup?.server || "local";
    
    document.getElementById('libraries-list-container').style.display = 'none';
    document.getElementById('library-detail-container').style.display = 'block';
    document.getElementById('library-detail-title').textContent = `${name} Repository`;
    
    await fetchLibraryItems();
}

async function fetchLibraryItems(deepScan = false, nocache = false) {
    showLoading(40);
    try {
        let url = `/api/libraries/browse?library_name=${encodeURIComponent(currentLibraryName)}&subpath=${encodeURIComponent(currentLibrarySubpath)}`;
        if (deepScan) url += '&deep_scan=true';
        if (nocache) url += '&nocache=true';
        
        const response = await fetch(url);
        if (!response.ok) {
            const err = await response.json();
            showToast(`Browse failed: ${err.detail}`, 'error');
            return;
        }
        
        const data = await response.json();
        currentLibraryItems = data.items || [];
        currentLibraryIsCached = data.cached || false;
        
        const cachedIndicator = document.getElementById('library-cached-indicator');
        if (cachedIndicator) {
            cachedIndicator.style.display = currentLibraryIsCached ? 'inline-block' : 'none';
        }
        
        renderBreadcrumbs();
        filterLibraryItems();
    } catch (e) {
        showToast("Error loading library items: " + e.message, 'error');
    } finally {
        hideLoading();
    }
}

function renderBreadcrumbs() {
    const container = document.getElementById('library-breadcrumbs');
    if (!container) return;
    container.innerHTML = '';
    
    const rootSpan = document.createElement('span');
    rootSpan.textContent = 'root';
    rootSpan.style.cursor = 'pointer';
    rootSpan.style.color = 'var(--accent-primary)';
    rootSpan.onclick = () => {
        currentLibrarySubpath = "";
        fetchLibraryItems();
    };
    container.appendChild(rootSpan);
    
    if (!currentLibrarySubpath) return;
    
    const parts = currentLibrarySubpath.split('/').filter(Boolean);
    let accum = "";
    parts.forEach((p, idx) => {
        accum += (accum ? `/${p}` : p);
        const thisSub = accum;
        
        const sep = document.createElement('span');
        sep.textContent = ' / ';
        sep.style.color = 'var(--text-muted)';
        container.appendChild(sep);
        
        const span = document.createElement('span');
        span.textContent = p;
        if (idx === parts.length - 1) {
            span.style.color = 'var(--text-primary)';
            span.style.fontWeight = 'bold';
        } else {
            span.style.cursor = 'pointer';
            span.style.color = 'var(--accent-primary)';
            span.onclick = () => {
                currentLibrarySubpath = thisSub;
                fetchLibraryItems();
            };
        }
        container.appendChild(span);
    });
}

function filterLibraryItems() {
    const query = document.getElementById('library-search')?.value.toLowerCase().trim() || '';
    const statusVal = document.getElementById('library-status-filter')?.value || 'all';
    
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

function renderLibraryItems(items) {
    const tbody = document.getElementById('library-items-table-body');
    if (!tbody) return;
    tbody.innerHTML = '';
    
    if (items.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" style="text-align: center; color: var(--text-muted); padding: 25px;">No items in this directory.</td></tr>';
        return;
    }
    
    items.forEach(item => {
        const tr = document.createElement('tr');
        tr.style.borderBottom = '1px solid var(--border-subtle)';
        
        const nameCell = document.createElement('td');
        nameCell.style.padding = '10px';
        const icon = item.is_dir ? '📁' : '📄';
        
        if (item.is_dir) {
            nameCell.innerHTML = `<span style="cursor: pointer; color: var(--accent-primary); font-weight: bold;">${icon} ${escapeHtml(item.name)}</span>`;
            nameCell.onclick = () => {
                currentLibrarySubpath = currentLibrarySubpath ? `${currentLibrarySubpath}/${item.relative_path}` : item.relative_path;
                fetchLibraryItems();
            };
        } else {
            nameCell.innerHTML = `<span>${icon} ${escapeHtml(item.name)}</span>`;
        }
        tr.appendChild(nameCell);
        
        const statusCell = document.createElement('td');
        statusCell.style.padding = '10px';
        statusCell.innerHTML = `<span class="task-status-pill status-${item.status.replace('_', '-')}">${item.status}</span>`;
        tr.appendChild(statusCell);
        
        const srcSizeCell = document.createElement('td');
        srcSizeCell.style.padding = '10px';
        srcSizeCell.textContent = item.source_size !== null ? `${(item.source_size / (1024*1024)).toFixed(2)} MB` : '--';
        tr.appendChild(srcSizeCell);
        
        const bkSizeCell = document.createElement('td');
        bkSizeCell.style.padding = '10px';
        bkSizeCell.textContent = item.backup_size !== null ? `${(item.backup_size / (1024*1024)).toFixed(2)} MB` : '--';
        tr.appendChild(bkSizeCell);
        
        const actionsCell = document.createElement('td');
        actionsCell.style.padding = '10px';
        actionsCell.style.textAlign = 'right';
        
        let actHtml = '<div style="display: flex; gap: 6px; justify-content: flex-end;">';
        
        if (!item.is_dir) {
            const ext = item.name.split('.').pop().toLowerCase();
            if (['mp4', 'mkv', 'avi', 'mov', 'webm'].includes(ext)) {
                actHtml += `<button class="btn btn-secondary btn-icon" onclick="openMediaInfoModal('${escapeHtml(item.relative_path)}')" title="Inspect & Convert">🎬</button>`;
            }
        }
        
        actHtml += `<button class="btn btn-secondary btn-icon" onclick="syncLibraryItem('${escapeHtml(item.relative_path)}', 'source_to_backup')" title="Sync to Backup">→</button>`;
        actHtml += `<button class="btn btn-secondary btn-icon" onclick="syncLibraryItem('${escapeHtml(item.relative_path)}', 'backup_to_source')" title="Sync to Source">←</button>`;
        actHtml += `<button class="btn btn-danger btn-icon" onclick="deleteLibraryItem('${escapeHtml(item.relative_path)}', '${item.name}')" title="Delete">🗑</button>`;
        actHtml += '</div>';
        
        actionsCell.innerHTML = actHtml;
        tr.appendChild(actionsCell);
        
        tbody.appendChild(tr);
    });
}

async function triggerLibraryDeepScan() {
    const btn = document.getElementById('btn-library-deep-scan');
    btn.disabled = true;
    btn.textContent = "Scanning...";
    await fetchLibraryItems(true, true);
    btn.disabled = false;
    btn.textContent = "Deep Scan";
}

async function syncLibraryItem(relPath, direction) {
    const fullRelPath = currentLibrarySubpath ? `${currentLibrarySubpath}/${relPath}` : relPath;
    try {
        const response = await fetch('/api/libraries/sync', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                library_name: currentLibraryName,
                relative_path: fullRelPath,
                direction: direction
            })
        });
        const data = await response.json();
        if (response.ok) {
            showToast("Sync copy task queued.", "success");
            fetchTasks();
        } else {
            showToast(`Sync failed: ${data.detail}`, "error");
        }
    } catch (e) {
        showToast("Failed to queue sync: " + e.message, "error");
    }
}

async function deleteLibraryItem(relPath, name) {
    const fullRelPath = currentLibrarySubpath ? `${currentLibrarySubpath}/${relPath}` : relPath;
    const ok = await showAppConfirm(`Are you sure you want to delete "${name}" from this repository?`);
    if (!ok) return;
    
    try {
        const response = await fetch('/api/libraries/delete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                library_name: currentLibraryName,
                relative_path: fullRelPath,
                target: 'source'
            })
        });
        const data = await response.json();
        if (response.ok) {
            showToast("Deletion task queued.", "info");
            fetchTasks();
        } else {
            showToast(`Deletion failed: ${data.detail}`, "error");
        }
    } catch (e) {
        showToast("Failed to delete item: " + e.message, "error");
    }
}

// --------------------------------------------------------------------------
// MEDIA INFO & PIPELINE CONVERSION
// --------------------------------------------------------------------------
async function openMediaInfoModal(relativePath) {
    const fullRelPath = currentLibrarySubpath ? `${currentLibrarySubpath}/${relativePath}` : relativePath;
    showLoading(40);
    try {
        const response = await fetch('/api/libraries/media-info', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                library_name: currentLibraryName,
                relative_path: fullRelPath
            })
        });
        
        if (!response.ok) {
            const err = await response.json();
            showToast(`Media Info error: ${err.detail}`, 'error');
            return;
        }
        
        const details = await response.json();
        document.getElementById('media-info-title').textContent = `Media Info: ${details.filename}`;
        
        const detailsDiv = document.getElementById('media-info-details');
        detailsDiv.innerHTML = `
            <div><strong>Format:</strong> ${escapeHtml(details.format)}</div>
            <div><strong>Duration:</strong> ${escapeHtml(details.duration)}</div>
            <div><strong>Size:</strong> ${escapeHtml(details.size)}</div>
            <div><strong>Bitrate:</strong> ${escapeHtml(details.bitrate)}</div>
        `;
        
        (details.video || []).forEach((v, idx) => {
            detailsDiv.innerHTML += `
                <div style="grid-column: 1 / -1; border-top: 1px solid var(--border-subtle); padding-top: 6px; color: var(--accent-primary);">
                    <strong>Video #${idx+1}:</strong> ${v.codec} | ${v.resolution} | ${v.fps} fps
                </div>
            `;
        });
        
        (details.audio || []).forEach((a, idx) => {
            detailsDiv.innerHTML += `
                <div style="grid-column: 1 / -1; color: var(--accent-secondary);">
                    <strong>Audio #${idx+1}:</strong> ${a.codec} | ${a.channels} ch | Lang: ${a.language}
                </div>
            `;
        });
        
        const profilesDiv = document.getElementById('media-conversion-profiles');
        profilesDiv.innerHTML = '';
        
        const configResp = await fetch('/api/config/ffmpeg');
        const config = await configResp.json();
        const profiles = config.profiles || {};
        
        Object.entries(profiles).forEach(([pName, pData]) => {
            const card = document.createElement('div');
            card.className = 'card';
            card.style.cssText = "padding: 10px; margin-bottom: 8px; display: flex; justify-content: space-between; align-items: center;";
            card.innerHTML = `
                <div>
                    <strong style="color: var(--text-primary);">${escapeHtml(pName)}</strong>
                    <div style="font-size: 0.8em; color: var(--text-muted); font-family: var(--font-family-mono);">${escapeHtml(pData.flags || '')}</div>
                </div>
                <button class="btn btn-primary btn-sm" onclick="startMediaConversion('${fullRelPath}', '${pName}')">Convert</button>
            `;
            profilesDiv.appendChild(card);
        });
        
        document.getElementById('media-info-modal').style.display = 'flex';
    } catch (e) {
        showToast("Failed to fetch media details: " + e.message, 'error');
    } finally {
        hideLoading();
    }
}

function closeMediaInfoModal() {
    document.getElementById('media-info-modal').style.display = 'none';
}

async function startMediaConversion(relativePath, profileName) {
    closeMediaInfoModal();
    showLoading(40);
    try {
        const response = await fetch('/api/libraries/media-convert', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                library_name: currentLibraryName,
                relative_path: relativePath,
                profile_name: profileName
            })
        });
        
        if (response.ok) {
            showToast("Media conversion pipeline queued.", "success");
            fetchTasks();
            setTimeout(() => switchTab('tasks'), 400);
        } else {
            const err = await response.json();
            showToast(`Conversion failed: ${err.detail}`, 'error');
        }
    } catch (e) {
        showToast("Failed to start media conversion: " + e.message, 'error');
    } finally {
        hideLoading();
    }
}

// --------------------------------------------------------------------------
// AUTHENTICATION & RBAC UI MANAGEMENT (MVP 2)
// --------------------------------------------------------------------------
let systemInitialized = false;

async function initAuth() {
    try {
        const statusRes = await originalFetch('/api/auth/status');
        if (statusRes.ok) {
            const statusData = await statusRes.json();
            systemInitialized = statusData.initialized;
            if (!systemInitialized) {
                currentUser = {
                    user_id: 'root-uninit',
                    email: 'Setup Root Admin',
                    role: 'Admin',
                    token: ''
                };
                updateUserUI();
                return;
            }
        }
    } catch (e) {
        console.warn('[Auth] Status check failed:', e);
    }
    
    const token = getAuthToken();
    if (token) {
        try {
            const meRes = await fetch('/api/auth/me');
            if (meRes.ok) {
                const meData = await meRes.json();
                currentUser = { ...meData, token };
            } else {
                setAuthToken('');
                currentUser = null;
            }
        } catch (e) {
            console.warn('[Auth] Token verification failed:', e);
            setAuthToken('');
            currentUser = null;
        }
    } else {
        currentUser = null;
    }
    updateUserUI();
}

function updateUserUI() {
    const roleBadge = document.getElementById('user-role-badge');
    const emailLabel = document.getElementById('user-email-label');
    const profileEmail = document.getElementById('profile-email-val');
    const profileRole = document.getElementById('profile-role-val');
    
    if (currentUser) {
        const role = (currentUser.role || 'Admin').toUpperCase();
        if (roleBadge) {
            roleBadge.textContent = role;
            roleBadge.className = `role-badge role-badge-${(currentUser.role || 'admin').toLowerCase()}`;
        }
        if (emailLabel) emailLabel.textContent = currentUser.email || 'Admin';
        if (profileEmail) profileEmail.textContent = currentUser.email || '';
        if (profileRole) {
            profileRole.textContent = role;
            profileRole.className = `role-badge role-badge-${(currentUser.role || 'admin').toLowerCase()}`;
        }
    } else {
        if (roleBadge) {
            roleBadge.textContent = 'GUEST';
            roleBadge.className = 'role-badge role-badge-viewer';
        }
        if (emailLabel) emailLabel.textContent = systemInitialized ? 'Sign In' : 'Setup Admin';
        if (profileEmail) profileEmail.textContent = 'Not signed in';
        if (profileRole) {
            profileRole.textContent = 'GUEST';
            profileRole.className = 'role-badge role-badge-viewer';
        }
    }
}

function openAuthModal(viewOverride) {
    const modal = document.getElementById('auth-modal');
    const setupView = document.getElementById('auth-setup-view');
    const loginView = document.getElementById('auth-login-view');
    const profileView = document.getElementById('auth-profile-view');
    const title = document.getElementById('auth-modal-title');
    if (!modal) return;
    
    setupView.style.display = 'none';
    loginView.style.display = 'none';
    profileView.style.display = 'none';
    
    if (viewOverride === 'setup' || (!systemInitialized && !currentUser?.user_id?.startsWith('usr_'))) {
        title.textContent = 'System Initialization';
        setupView.style.display = 'block';
    } else if (viewOverride === 'login' || !currentUser || !currentUser.token) {
        title.textContent = 'Sign In';
        loginView.style.display = 'block';
    } else {
        title.textContent = 'User Profile';
        profileView.style.display = 'block';
    }
    modal.style.display = 'flex';
}

function closeAuthModal() {
    const modal = document.getElementById('auth-modal');
    if (modal) modal.style.display = 'none';
}

async function handleSetupAdmin(e) {
    if (e) e.preventDefault();
    const email = document.getElementById('setup-email')?.value.trim();
    const password = document.getElementById('setup-password')?.value;
    const confirm = document.getElementById('setup-confirm-password')?.value;
    
    if (!email || !password) {
        showToast('Please provide both email and password.', 'warning');
        return;
    }
    if (password !== confirm) {
        showToast('Passwords do not match.', 'error');
        return;
    }
    
    showLoading(50);
    try {
        const res = await originalFetch('/api/auth/setup-admin', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password })
        });
        const data = await res.json();
        if (res.ok) {
            showToast('Root administrator initialized successfully!', 'success');
            setAuthToken(data.token);
            currentUser = {
                user_id: data.user.id,
                email: data.user.email,
                role: data.user.role,
                token: data.token
            };
            systemInitialized = true;
            updateUserUI();
            closeAuthModal();
            initEventStream();
        } else {
            showToast(`Setup failed: ${data.detail}`, 'error');
        }
    } catch (err) {
        showToast(`Setup error: ${err.message}`, 'error');
    } finally {
        hideLoading();
    }
}

async function handleLogin(e) {
    if (e) e.preventDefault();
    const email = document.getElementById('login-email')?.value.trim();
    const password = document.getElementById('login-password')?.value;
    
    if (!email || !password) {
        showToast('Please enter email and password.', 'warning');
        return;
    }
    
    showLoading(50);
    try {
        const res = await originalFetch('/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password })
        });
        const data = await res.json();
        if (res.ok) {
            showToast(`Welcome back, ${data.user.email}!`, 'success');
            setAuthToken(data.token);
            currentUser = {
                user_id: data.user.id,
                email: data.user.email,
                role: data.user.role,
                token: data.token
            };
            systemInitialized = true;
            updateUserUI();
            closeAuthModal();
            initEventStream();
            fetchTasks(0);
        } else {
            showToast(`Login failed: ${data.detail}`, 'error');
        }
    } catch (err) {
        showToast(`Login error: ${err.message}`, 'error');
    } finally {
        hideLoading();
    }
}

async function handleLogout() {
    showLoading(30);
    try {
        await fetch('/api/auth/logout', { method: 'POST' });
    } catch (e) {}
    setAuthToken('');
    currentUser = null;
    updateUserUI();
    closeAuthModal();
    showToast('Signed out successfully.', 'info');
    initEventStream();
    hideLoading();
}

// --------------------------------------------------------------------------
// APPLICATION INITIALIZATION
// --------------------------------------------------------------------------
async function initApp() {
    console.log("[Pareo V2] Booting application...");
    
    // 0. Initialize PWA
    initPWA();

    // 1. Initialize Bespoke Theme Engine
    initTheme();

    // 2. Auth & RBAC State
    await initAuth();

    // 3. Connect Real-Time SSE Bus
    initEventStream();

    // 4. Load Initial Telemetry
    fetchInitialTelemetry();
    
    // 5. Load Application Data
    fetchTasks(0);
    fetchProfiles();
    fetchFsConfig();
    fetchBookmarks();
    fetchRemotesConfig();
    fetchSwitchboardConfig();
    fetchGenericCards();
    fetchProcessConfig();
    
    // 6. Default to Tasks Tab
    switchTab('tasks');
}

window.addEventListener('DOMContentLoaded', () => {
    initApp();
});
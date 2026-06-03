// Handle Navigation Toggling
function switchTab(event, tabId) {
    document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
    
    document.getElementById(tabId).classList.add('active');
    event.currentTarget.classList.add('active');
}

// Trigger Backend Command
async function executeCommand(cmd) {
    // 1. Instantly switch to the tasks tab for immediate visual feedback
    const tasksTab = document.querySelector('.nav-item:nth-child(2)');
    switchTab({ currentTarget: tasksTab }, 'tasks');

    // 2. Optimistically add a temporary placeholder row to the top of the table
    const tbody = document.querySelector('#tasks-table tbody');
    const tempRow = document.createElement('tr');
    tempRow.innerHTML = `
        <td><small>...</small></td>
        <td><code>${cmd}</code></td>
        <td><span class="badge pending">Starting</span></td>
        <td><pre>Dispatching to engine...</pre></td>
    `;
    tbody.prepend(tempRow); 

    try {
        // 3. Send the request to the Pareo engine
        await fetch(`/api/execute/${cmd}`, { method: 'POST' });
        
        // 4. Immediately force a fetch of the true state 
        // This overwrites the temporary row with the real task ID and status
        fetchTasks();
        
    } catch (error) {
        console.error("Execution failed:", error);
        tempRow.innerHTML = `
            <td colspan="4" style="color: #e74c3c; text-align: center;"><strong>Error:</strong> Failed to connect to Pareo engine.</td>
        `;
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
    tbody.innerHTML = ''; // Clear current rows
    
    // Convert dictionary to array and sort by start time (newest first)
    const taskList = Object.values(tasks).sort((a, b) => new Date(b.start_time) - new Date(a.start_time));

    taskList.forEach(task => {
        const tr = document.createElement('tr');
        
        // Determine what to show in the Output column
        let displayData = '';
        if (task.status === 'Failed') {
            displayData = task.error;
        } else if (task.output) {
            // Keep output visually manageable in the table
            displayData = task.output; 
        } else {
            displayData = '...';
        }

        // Shorten the UUID for cleaner display
        const shortId = task.task_id.split('-')[0];

        tr.innerHTML = `
            <td><small>${shortId}</small></td>
            <td><code>${task.command}</code></td>
            <td><span class="badge ${task.status.toLowerCase()}">${task.status}</span></td>
            <td><pre>${displayData}</pre></td>
        `;
        tbody.appendChild(tr);
    });
}

// Start the polling loop (every 2 seconds)
setInterval(fetchTasks, 2000);
fetchTasks(); // Initial fetch on load
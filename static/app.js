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


// Updated Render Tasks with targeted DOM updates and robust auto-scrolling
function renderTasks(tasks) {
    const tbody = document.querySelector('#tasks-table tbody');
    const taskList = Object.values(tasks).sort((a, b) => new Date(b.start_time) - new Date(a.start_time));

    taskList.forEach(task => {
        // Attempt to find the existing row
        let tr = document.getElementById(`row-${task.task_id}`);
        
        let displayData = '';
        if (task.status === 'Failed' && !task.output) {
            displayData = task.error || 'Execution failed.';
        } else if (task.output) {
            displayData = task.output; 
        } else {
            displayData = '...';
        }

        // 1. If the row doesn't exist, create its skeleton
        if (!tr) {
            tr = document.createElement('tr');
            tr.id = `row-${task.task_id}`;
            tr.innerHTML = `
                <td><small>${task.task_id.split('-')[0]}</small></td>
                <td><code>${task.command}</code></td>
                <td><span class="status-badge badge"></span></td>
                <td><pre class="log-output"></pre></td>
            `;
            
            // Clean up the optimistic "Starting" placeholder once real data arrives
            if (tbody.firstElementChild && !tbody.firstElementChild.id) {
                tbody.firstElementChild.remove();
            }
            tbody.appendChild(tr);
        }

        // 2. Update existing elements individually (prevents layout thrashing)
        const badge = tr.querySelector('.status-badge');
        const preElement = tr.querySelector('.log-output');

        badge.className = `status-badge badge ${task.status.toLowerCase()}`;
        badge.textContent = task.status;

        // 3. Only update text and scroll if new data actually arrived
        if (preElement.textContent !== displayData) {
            preElement.textContent = displayData;
            
            // Auto-scroll logic
            if (task.status === 'Running') {
                // requestAnimationFrame ensures the browser paints the new text BEFORE calculating height
                requestAnimationFrame(() => {
                    preElement.scrollTop = preElement.scrollHeight;
                });
            }
        }
    });
}

// Trigger FFMPEG Command
async function executeFfmpeg() {
    const inputPath = document.getElementById('ffmpeg-input').value.trim();
    const outputPath = document.getElementById('ffmpeg-output').value.trim();

    if (!inputPath || !outputPath) {
        alert("Please provide both an input and output path.");
        return;
    }

    // 1. Instantly switch to the tasks tab
    const tasksTab = document.querySelector('.nav-item:nth-child(2)');
    switchTab({ currentTarget: tasksTab }, 'tasks');

    // 2. Optimistic UI placeholder
    const tbody = document.querySelector('#tasks-table tbody');
    const tempRow = document.createElement('tr');
    tempRow.innerHTML = `
        <td><small>...</small></td>
        <td><code>ffmpeg -i "${inputPath}" "${outputPath}"</code></td>
        <td><span class="badge pending">Starting</span></td>
        <td><pre>Dispatching FFMPEG to engine...</pre></td>
    `;
    tbody.prepend(tempRow); 

    try {
        // 3. Send the JSON payload to the new FFMPEG endpoint
        await fetch('/api/execute/ffmpeg', { 
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                input_path: inputPath,
                output_path: outputPath
            })
        });
        
        // 4. Clear the input fields for the next run
        document.getElementById('ffmpeg-input').value = '';
        document.getElementById('ffmpeg-output').value = '';

        // 5. Force immediate fetch
        fetchTasks();
        
    } catch (error) {
        console.error("Execution failed:", error);
        tempRow.innerHTML = `
            <td colspan="4" style="color: #e74c3c; text-align: center;"><strong>Error:</strong> Failed to connect to Pareo engine.</td>
        `;
    }
}


// Start the polling loop (every 2 seconds)
setInterval(fetchTasks, 2000);
fetchTasks(); // Initial fetch on load
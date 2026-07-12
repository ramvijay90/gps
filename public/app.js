document.addEventListener('DOMContentLoaded', () => {
    const startBtn = document.getElementById('start-btn');
    const stopBtn = document.getElementById('stop-btn');
    const statusBadge = document.getElementById('system-status');
    const terminalOutput = document.getElementById('terminal-output');
    const spinner = document.getElementById('loading-spinner');
    const btnFetchOdo = document.getElementById('btn-fetch-odo');
    
    // Mode Switching Logic
    const radioCards = document.querySelectorAll('.radio-card');
    const driveSettings = document.getElementById('drive-settings');
    let currentMode = 'parked';

    radioCards.forEach(card => {
        card.addEventListener('click', () => {
            radioCards.forEach(c => c.classList.remove('active'));
            card.classList.add('active');
            
            const radio = card.querySelector('input[type="radio"]');
            radio.checked = true;
            currentMode = radio.value;

            if (currentMode === 'drive' || currentMode === 'drive_km' || currentMode === 'travel_report' || currentMode === 'travel_hours') {
                driveSettings.classList.remove('hidden');
            } else {
                driveSettings.classList.add('hidden');
            }
            
            const shieldSettings = document.getElementById('shield-settings');
            if (shieldSettings) {
                if (currentMode === 'drive_km') {
                    shieldSettings.style.display = 'block';
                } else {
                    shieldSettings.style.display = 'none';
                }
            }
        });
    });

    // Auto-fetch Odometer logic
    btnFetchOdo.addEventListener('click', async () => {
        const selectedOptions = Array.from(document.getElementById('vehicle-select').selectedOptions);
        if (selectedOptions.length !== 1) {
            alert('Please select exactly ONE vehicle to auto-fetch its data.');
            return;
        }
        
        const imei = selectedOptions[0].value;
        const originalText = btnFetchOdo.innerText;
        btnFetchOdo.innerText = 'Fetching instantly from database...';
        btnFetchOdo.disabled = true;

        const historyDateEl = document.getElementById('history_date');
        const historyDateStr = (historyDateEl && historyDateEl.value) ? historyDateEl.value : "";

        try {
            const response = await fetch('/api/fetch_odo', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ imei: imei, history_date: historyDateStr })
            });
            const data = await response.json();
            if (data.success) {
                if (data.odo > 0) document.getElementById('start_odo').value = data.odo;
                if (data.today_odo !== undefined) document.getElementById('start_today_odo').value = data.today_odo;
                if (data.lat !== 0) document.getElementById('lat').value = data.lat;
                if (data.lng !== 0) document.getElementById('lng').value = data.lng;
                alert(`Successfully fetched real vehicle state:\nTotal Odometer: ${data.odo} KM\nToday's Distance: ${data.today_odo} KM\nLatitude: ${data.lat}\nLongitude: ${data.lng}`);
            } else {
                alert('Could not fetch historical data. Vehicle might have no history.');
            }
        } catch (error) {
            alert('Error fetching data.');
        } finally {
            btnFetchOdo.innerText = originalText;
            btnFetchOdo.disabled = false;
        }
    });

    // Vehicle Loading Logic
    const vehicleSelect = document.getElementById('vehicle-select');
    const selectAllBtn = document.getElementById('select-all-btn');
    
    const sleepTableBody = document.getElementById('sleep-manager-table-body');
    
    async function loadVehicles() {
        try {
            const res = await fetch('/api/vehicles');
            const vehicles = await res.json();
            
            // Render select dropdown
            vehicleSelect.innerHTML = '';
            vehicles.forEach(v => {
                const option = document.createElement('option');
                option.value = v.imei;
                option.textContent = `${v.vehicle_no} (IMEI: ${v.imei})`;
                vehicleSelect.appendChild(option);
            });
            
            // Render Sleep Manager Table
            if (sleepTableBody) {
                sleepTableBody.innerHTML = '';
                vehicles.forEach(v => {
                    const tr = document.createElement('tr');
                    tr.style.borderBottom = '1px solid #333';
                    
                    const isSleep = !!v.sleep_mode;
                    const badgeColor = isSleep ? '#4caf50' : '#888';
                    const badgeText = isSleep ? '🌙 Sleep Active' : '☀️ Normal (1m)';
                    
                    tr.innerHTML = `
                        <td style="padding: 8px;">${v.vehicle_no}</td>
                        <td style="padding: 8px; font-family: monospace;">${v.imei}</td>
                        <td style="padding: 8px;"><span style="background: ${badgeColor}; color: white; padding: 2px 6px; border-radius: 4px; font-size: 0.8rem; font-weight: bold;">${badgeText}</span></td>
                        <td style="padding: 8px; text-align: right; display: flex; gap: 5px; justify-content: flex-end;">
                            <button class="btn-toggle-sleep" data-imei="${v.imei}" data-enable="true" style="padding: 3px 8px; font-size: 0.75rem; background: #4caf50; border: none; border-radius: 4px; color: white; cursor: pointer; font-weight: bold; ${isSleep ? 'opacity: 0.5; cursor: not-allowed;' : ''}" ${isSleep ? 'disabled' : ''}>Sleep</button>
                            <button class="btn-toggle-sleep" data-imei="${v.imei}" data-enable="false" style="padding: 3px 8px; font-size: 0.75rem; background: #f44336; border: none; border-radius: 4px; color: white; cursor: pointer; font-weight: bold; ${!isSleep ? 'opacity: 0.5; cursor: not-allowed;' : ''}" ${!isSleep ? 'disabled' : ''}>Normal</button>
                        </td>
                    `;
                    sleepTableBody.appendChild(tr);
                });
                
                // Add event listeners to sleep toggle buttons
                document.querySelectorAll('.btn-toggle-sleep').forEach(btn => {
                    btn.addEventListener('click', async (e) => {
                        e.preventDefault();
                        const imei = btn.getAttribute('data-imei');
                        const enable = btn.getAttribute('data-enable') === 'true';
                        
                        if (!confirm(`Are you sure you want to change sleep mode settings for this vehicle?`)) {
                            return;
                        }
                        
                        btn.disabled = true;
                        btn.textContent = "...";
                        
                        try {
                            const response = await fetch('/api/set-sleep-state', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ imei, enabled: enable })
                            });
                            const result = await response.json();
                            if (result.success) {
                                alert("Command sent successfully!");
                                loadVehicles(); // Reload to refresh table status
                            } else {
                                alert("Failed to change sleep setting: " + result.message);
                                btn.disabled = false;
                                btn.textContent = enable ? "Sleep" : "Normal";
                            }
                        } catch (err) {
                            alert("Network error.");
                            btn.disabled = false;
                            btn.textContent = enable ? "Sleep" : "Normal";
                        }
                    });
                });
            }
            
        } catch (e) {
            console.error("Failed to load vehicles", e);
            vehicleSelect.innerHTML = '<option value="">Failed to load vehicles</option>';
            if (sleepTableBody) {
                sleepTableBody.innerHTML = '<tr><td colspan="4" style="padding: 8px; text-align: center; color: red;">Error loading vehicles</td></tr>';
            }
        }
    }
    
    loadVehicles();

    selectAllBtn.addEventListener('click', (e) => {
        e.preventDefault();
        Array.from(vehicleSelect.options).forEach(opt => opt.selected = true);
    });

    let pollingInterval = null;

    function addLogLine(text, isMuted = false) {
        const div = document.createElement('div');
        div.className = 'log-line' + (isMuted ? ' text-muted' : '');
        div.textContent = text;
        terminalOutput.appendChild(div);
        terminalOutput.scrollTop = terminalOutput.scrollHeight;
    }

    function updateStatus(isRunning) {
        if (isRunning) {
            statusBadge.className = 'status-badge online';
            statusBadge.textContent = 'System Online';
        } else {
            statusBadge.className = 'status-badge offline';
            statusBadge.textContent = 'System Offline';
        }
    }

    async function pollStatus() {
        try {
            const res = await fetch('/api/status');
            const data = await res.json();
            
            updateStatus(data.is_running);
            
            terminalOutput.innerHTML = '';
            data.logs.forEach(log => addLogLine(log));
            
            // Render Scheduled Jobs
            const scheduledList = document.getElementById('scheduled-jobs-list');
            if (data.scheduled_jobs && data.scheduled_jobs.length > 0) {
                scheduledList.innerHTML = data.scheduled_jobs.map((job, idx) => `
                    <div style="background: rgba(255, 255, 255, 0.05); padding: 0.5rem; margin-bottom: 0.5rem; border-radius: 4px; display: flex; justify-content: space-between; align-items: center;">
                        <div>
                            <strong>Vehicles:</strong> ${job.imeis ? job.imeis.length : 0} <br>
                            <strong>Target:</strong> ${job.target_hours || 0} Hrs <br>
                            <strong>Shield:</strong> ${job.shield_hours || 0} Hrs
                        </div>
                        <button onclick="cancelSchedule(${idx})" style="background: #f44336; color: white; border: none; padding: 4px 8px; border-radius: 4px; cursor: pointer;">Cancel</button>
                    </div>
                `).join('');
            } else {
                scheduledList.innerHTML = "No jobs scheduled.";
            }

            // Render Active Shields
            const shieldsList = document.getElementById('active-shields-list');
            if (data.active_shields && data.active_shields.length > 0) {
                shieldsList.innerHTML = data.active_shields.map(s => `
                    <div style="background: rgba(255, 255, 255, 0.05); padding: 0.5rem; margin-bottom: 0.5rem; border-radius: 4px; display: flex; justify-content: space-between; align-items: center;">
                        <div>
                            <strong>IMEI:</strong> ${s.imei} <br>
                            <strong>Expires:</strong> ${s.expiry_time}
                        </div>
                        <button onclick="cancelShield('${s.imei}')" style="background: #f44336; color: white; border: none; padding: 4px 8px; border-radius: 4px; cursor: pointer;">Cancel</button>
                    </div>
                `).join('');
            } else {
                shieldsList.innerHTML = "No active shields.";
            }
            
            // Render History
            const historyBody = document.getElementById('history-table-body');
            if (data.history && data.history.length > 0) {
                historyBody.innerHTML = data.history.map(h => `
                    <tr style="border-bottom: 1px solid #333;">
                        <td style="padding: 8px;">${h.timestamp}</td>
                        <td style="padding: 8px; color: #00bcd4; font-weight: bold;">${h.imei}</td>
                        <td style="padding: 8px;">${h.mode === 'drive_km' ? '🚗 KM' : '👻 Hours'}</td>
                        <td style="padding: 8px; color: #4caf50;">+${h.added_km}</td>
                        <td style="padding: 8px;">${h.final_odo}</td>
                        <td style="padding: 8px;">${h.target_hours}</td>
                        <td style="padding: 8px;">${h.shield_hours}</td>
                    </tr>
                `).join('');
            } else {
                historyBody.innerHTML = `<tr><td colspan="7" style="padding: 8px; text-align: center;">No history available.</td></tr>`;
            }
            
            
        } catch (e) {
            console.error("Failed to poll status", e);
        }
    }
    
    // Set polling to run forever every 2 seconds
    pollingInterval = setInterval(pollStatus, 2000);

    // Cancel functions exposed to window
    window.cancelSchedule = async function(index) {
        if (!confirm("Cancel this scheduled job?")) return;
        try {
            const res = await fetch('/api/cancel_schedule', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ index })
            });
            const data = await res.json();
            alert(data.message);
            pollStatus();
        } catch (e) { alert("Error cancelling."); }
    };

    window.cancelShield = async function(imei) {
        if (!confirm("Cancel the shield for " + imei + "? Hardware tracking will resume instantly!")) return;
        try {
            const res = await fetch('/api/cancel_shield', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ imei })
            });
            const data = await res.json();
            alert(data.message);
            pollStatus();
        } catch (e) { alert("Error cancelling."); }
    };

    startBtn.addEventListener('click', async () => {
        const selectedOptions = Array.from(vehicleSelect.selectedOptions);
        const imeis = selectedOptions.map(opt => opt.value);
        
        const lat = document.getElementById('lat').value;
        const lng = document.getElementById('lng').value;
        
        // Pass exact date string to backend
        const historyDateEl = document.getElementById('history_date');
        const historyDateStr = (historyDateEl && historyDateEl.value) ? historyDateEl.value : "";

        const hours = parseFloat(document.getElementById('target_hours').value) || 0;
        const minutes = parseFloat(document.getElementById('target_minutes').value) || 0;
        const targetHours = hours + (minutes / 60.0);
        
        const startOdo = parseFloat(document.getElementById('start_odo').value) || 0;
        const startTodayOdo = parseFloat(document.getElementById('start_today_odo').value) || 0;
        const speed = document.getElementById('speed').value;
        const shieldHoursEl = document.getElementById('shield_hours');
        const shieldHours = (shieldHoursEl && shieldHoursEl.value) ? parseFloat(shieldHoursEl.value) : 0;

        if (imeis.length === 0) {
            alert("Please select at least one vehicle.");
            return;
        }

        try {
            let apiUrl = '/api/start';
            let bodyData = {
                imeis: imeis, lat, lng, mode: currentMode,
                history_date: historyDateStr, target_hours: targetHours, 
                start_odo: startOdo, start_today_odo: startTodayOdo, speed: speed,
                shield_hours: shieldHours
            };
            
            if (currentMode === 'travel_report' || currentMode === 'travel_hours') {
                apiUrl = '/api/run-travel-report';
                bodyData = {
                    imeis: imeis, date: historyDateStr, hours: targetHours, speed: speed,
                    hours_only: (currentMode === 'travel_hours')
                };
            }

            const res = await fetch(apiUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(bodyData)
            });
            const data = await res.json();
            
            if (data.success) {
                terminalOutput.innerHTML = '';
                addLogLine(`Task started for ${imeis.length} vehicles. Moving to background...`);
                alert("Spoofing task sent to background! You can monitor or cancel it in the Active Background Tasks section below.");
                updateStatus(true);
            } else {
                alert("Error starting spoofer: " + data.message);
            }
        } catch (e) {
            alert("Network error.");
        }
    });

    const scheduleBtn = document.getElementById('schedule-btn');
    if (scheduleBtn) {
        scheduleBtn.addEventListener('click', async () => {
            const selectedOptions = Array.from(vehicleSelect.selectedOptions);
            const imeis = selectedOptions.map(opt => opt.value);
            
            const lat = document.getElementById('lat').value;
            const lng = document.getElementById('lng').value;
            const historyDateEl = document.getElementById('history_date');
            const historyDateStr = (historyDateEl && historyDateEl.value) ? historyDateEl.value : "";

            const hours = parseFloat(document.getElementById('target_hours').value) || 0;
            const minutes = parseFloat(document.getElementById('target_minutes').value) || 0;
            const targetHours = hours + (minutes / 60.0);
            
            const startOdo = parseFloat(document.getElementById('start_odo').value) || 0;
            const startTodayOdo = parseFloat(document.getElementById('start_today_odo').value) || 0;
            const speed = document.getElementById('speed').value;
            const shieldHoursEl = document.getElementById('shield_hours');
            const shieldHours = (shieldHoursEl && shieldHoursEl.value) ? parseFloat(shieldHoursEl.value) : 0;

            if (imeis.length === 0) {
                alert("Please select at least one vehicle to schedule.");
                return;
            }

            try {
                const res = await fetch('/api/schedule', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        imeis: imeis, lat, lng, mode: currentMode,
                        history_date: historyDateStr, target_hours: targetHours, 
                        start_odo: startOdo, start_today_odo: startTodayOdo, speed: speed,
                        shield_hours: shieldHours
                    })
                });
                const data = await res.json();
                if (data.success) {
                    alert(data.message);
                    addLogLine(`[SCHEDULED] ${imeis.length} vehicles scheduled for 11:55 PM.`);
                    pollStatus();
                } else {
                    alert("Error scheduling: " + data.message);
                }
            } catch (e) {
                alert("Network error scheduling.");
            }
        });
    }

    // Removed global Stop button logic as user prefers canceling individual tasks
    
    // Clear history
    const btnClearHistory = document.getElementById('btn-clear-history');
    if (btnClearHistory) {
        btnClearHistory.addEventListener('click', async () => {
            if (!confirm("Are you sure you want to permanently clear the entire spoofing history?")) return;
            try {
                const res = await fetch('/api/history', { method: 'DELETE' });
                const data = await res.json();
                if (data.success) {
                    pollStatus();
                } else {
                    alert(data.message);
                }
            } catch (e) {
                alert("Error clearing history.");
            }
        });
    }
    
    // GPRS Command Console
    const cmdTemplate = document.getElementById('cmd-template');
    const cmdInput = document.getElementById('cmd-input');
    const sendCmdBtn = document.getElementById('send-cmd-btn');
    
    if (cmdTemplate && cmdInput) {
        cmdTemplate.addEventListener('change', () => {
            cmdInput.value = cmdTemplate.value;
        });
    }
    
    if (sendCmdBtn) {
        sendCmdBtn.addEventListener('click', async (e) => {
            e.preventDefault();
            
            const selectedOptions = Array.from(vehicleSelect.selectedOptions);
            const imeis = selectedOptions.map(opt => opt.value);
            const cmdText = cmdInput.value.trim();
            
            if (imeis.length === 0) {
                alert("Please select at least one vehicle to send commands to.");
                return;
            }
            
            if (!cmdText) {
                alert("Please enter a command payload first.");
                return;
            }
            
            if (!confirm(`Are you sure you want to send command "${cmdText}" to ${imeis.length} vehicle(s)?`)) {
                return;
            }
            
            sendCmdBtn.disabled = true;
            sendCmdBtn.textContent = "Sending...";
            
            try {
                const res = await fetch('/api/send-command', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ imeis, command: cmdText })
                });
                const data = await res.json();
                
                if (data.success) {
                    alert(data.message);
                    addLogLine(`[CMD SENT] Command "${cmdText}" sent to ${imeis.length} vehicle(s).`);
                } else {
                    alert("Failed to send command: " + data.message);
                }
            } catch (err) {
                alert("Network error sending command.");
            } finally {
                sendCmdBtn.disabled = false;
                sendCmdBtn.textContent = "Send GPRS Command";
            }
        });
    }
    
    // Sidebar Tabs switching
    const menuItems = document.querySelectorAll('.sidebar-menu li');
    const tabPanels = document.querySelectorAll('.tab-panel');
    
    menuItems.forEach(item => {
        item.addEventListener('click', (e) => {
            e.preventDefault();
            menuItems.forEach(mi => mi.classList.remove('active'));
            item.classList.add('active');
            
            const targetId = item.getAttribute('data-target');
            tabPanels.forEach(panel => {
                if (panel.id === targetId) {
                    panel.classList.remove('hidden');
                } else {
                    panel.classList.add('hidden');
                }
            });
        });
    });

    // Clear Telemetry log button
    const btnClearTelemetry = document.getElementById('btn-clear-telemetry');
    if (btnClearTelemetry && terminalOutput) {
        btnClearTelemetry.addEventListener('click', async () => {
            try {
                const res = await fetch('/api/clear-logs', { method: 'POST' });
                const data = await res.json();
                if (data.success) {
                    terminalOutput.innerHTML = '<div class="log-line text-muted">Awaiting connection...</div>';
                }
            } catch (e) {
                console.error("Failed to clear telemetry logs:", e);
            }
        });
    }

    // Search vehicles in main selector
    const vehicleSearch = document.getElementById('vehicle-search');
    if (vehicleSearch) {
        vehicleSearch.addEventListener('input', () => {
            const query = vehicleSearch.value.trim().toLowerCase();
            const options = vehicleSelect.querySelectorAll('option');
            options.forEach(opt => {
                if (opt.value === "") return;
                const text = opt.textContent.toLowerCase();
                if (text.includes(query)) {
                    opt.style.display = 'block';
                } else {
                    opt.style.display = 'none';
                }
            });
        });
    }

    // Search vehicles in sleep mode manager
    const sleepSearch = document.getElementById('sleep-search');
    if (sleepSearch) {
        sleepSearch.addEventListener('input', () => {
            const query = sleepSearch.value.trim().toLowerCase();
            const rows = document.querySelectorAll('#sleep-manager-table-body tr');
            rows.forEach(row => {
                const text = row.textContent.toLowerCase();
                if (text.includes(query)) {
                    row.style.display = '';
                } else {
                    row.style.display = 'none';
                }
            });
        });
    }

    // Search in KM report table
    const kmReportSearch = document.getElementById('km-report-search');
    if (kmReportSearch) {
        kmReportSearch.addEventListener('input', () => {
            const query = kmReportSearch.value.trim().toLowerCase();
            const rows = document.querySelectorAll('#tbody-km-report tr');
            rows.forEach(row => {
                const text = row.textContent.toLowerCase();
                if (text.includes(query)) {
                    row.style.display = '';
                } else {
                    row.style.display = 'none';
                }
            });
        });
    }

    // Search in Hours report table
    const hoursReportSearch = document.getElementById('hours-report-search');
    if (hoursReportSearch) {
        hoursReportSearch.addEventListener('input', () => {
            const query = hoursReportSearch.value.trim().toLowerCase();
            const rows = document.querySelectorAll('#tbody-hours-report tr');
            rows.forEach(row => {
                const text = row.textContent.toLowerCase();
                if (text.includes(query)) {
                    row.style.display = '';
                } else {
                    row.style.display = 'none';
                }
            });
        });
    }

    // Quick Date selectors for Reports
    function setDateRange(type, fromId, toId) {
        const fromInput = document.getElementById(fromId);
        const toInput = document.getElementById(toId);
        if (!fromInput || !toInput) return;
        
        const now = new Date();
        const y = now.getFullYear();
        const m = now.getMonth();
        
        if (type === 'current') {
            const firstDay = new Date(y, m, 1);
            fromInput.value = formatDateLocal(firstDay);
            toInput.value = formatDateLocal(now);
        } else if (type === 'last') {
            const firstDayLast = new Date(y, m - 1, 1);
            const lastDayLast = new Date(y, m, 0);
            fromInput.value = formatDateLocal(firstDayLast);
            toInput.value = formatDateLocal(lastDayLast);
        }
    }
    
    function formatDateLocal(date) {
        const offset = date.getTimezoneOffset();
        const local = new Date(date.getTime() - (offset * 60 * 1000));
        return local.toISOString().split('T')[0];
    }
    
    // Bind buttons
    const btnKmCurrent = document.getElementById('btn-km-current-month');
    const btnKmLast = document.getElementById('btn-km-last-month');
    const btnHoursCurrent = document.getElementById('btn-hours-current-month');
    const btnHoursLast = document.getElementById('btn-hours-last-month');
    
    if (btnKmCurrent) btnKmCurrent.addEventListener('click', (e) => { e.preventDefault(); setDateRange('current', 'km-from-date', 'km-to-date'); });
    if (btnKmLast) btnKmLast.addEventListener('click', (e) => { e.preventDefault(); setDateRange('last', 'km-from-date', 'km-to-date'); });
    if (btnHoursCurrent) btnHoursCurrent.addEventListener('click', (e) => { e.preventDefault(); setDateRange('current', 'hours-from-date', 'hours-to-date'); });
    if (btnHoursLast) btnHoursLast.addEventListener('click', (e) => { e.preventDefault(); setDateRange('last', 'hours-from-date', 'hours-to-date'); });
    
    // Set defaults to current month on load
    setDateRange('current', 'km-from-date', 'km-to-date');
    setDateRange('current', 'hours-from-date', 'hours-to-date');

    // Dynamic Daily Reports Generation
    let currentKmReportData = null;
    let currentHoursReportData = null;

    async function generateReport(type) {
        const fromDateStr = document.getElementById(type === 'km' ? 'km-from-date' : 'hours-from-date').value;
        const toDateStr = document.getElementById(type === 'km' ? 'km-to-date' : 'hours-to-date').value;
        const tbody = document.getElementById(type === 'km' ? 'tbody-km-report' : 'tbody-hours-report');
        const thead = document.getElementById(type === 'km' ? 'thead-km-report' : 'thead-hours-report');
        
        if (!fromDateStr || !toDateStr) {
            alert("Please select both From and To dates.");
            return;
        }
        
        tbody.innerHTML = '<tr><td colspan="5" style="padding: 12px; text-align: center;">Generating report...</td></tr>';
        
        try {
            const resV = await fetch('/api/vehicles');
            const vehicles = await resV.json();
            
            const resH = await fetch('/api/history');
            const history = await resH.json();
            
            const d1 = new Date(fromDateStr);
            const d2 = new Date(toDateStr);
            const datesList = [];
            let temp = new Date(d1);
            while (temp <= d2) {
                datesList.push(temp.toISOString().split('T')[0]);
                temp.setDate(temp.getDate() + 1);
            }
            
            if (datesList.length > 31) {
                alert("Maximum report window is 31 days.");
                tbody.innerHTML = '<tr><td colspan="5" style="padding: 12px; text-align: center; color: red;">Please select a date range <= 31 days.</td></tr>';
                return;
            }
            
            let headerHtml = `<tr>
                <th>#</th>
                <th>Vehicle</th>
                <th>Type</th>
                <th>Category</th>
                <th>Total</th>
            `;
            datesList.forEach(dt => {
                const parts = dt.split('-');
                const d = parseInt(parts[2]);
                const m = parseInt(parts[1]);
                headerHtml += `<th>${d}/${m}</th>`;
            });
            headerHtml += '</tr>';
            thead.innerHTML = headerHtml;
            
            tbody.innerHTML = '';
            const reportRows = [];
            
            vehicles.forEach((v, index) => {
                const imei = v.imei;
                let totalVal = 0.0;
                const dailyVals = [];
                
                datesList.forEach(dt => {
                    const dayLogs = history.filter(item => item.imei === imei && item.date === dt);
                    
                    let val = 0.0;
                    if (type === 'km') {
                        dayLogs.forEach(log => {
                            if (log.mode === 'travel_report' || log.mode === 'drive_km' || log.mode === 'drive') {
                                val += parseFloat(log.added_km || 0);
                            }
                        });
                        totalVal += val;
                        dailyVals.push(val);
                    } else {
                        dayLogs.forEach(log => {
                            if (log.mode === 'travel_hours' || log.mode === 'drive' || log.mode === 'drive_km') {
                                val += parseFloat(log.target_hours || 0);
                            }
                        });
                        totalVal += val;
                        dailyVals.push(val);
                    }
                });
                
                let totalStr = "";
                if (type === 'km') {
                    totalStr = totalVal > 0 ? totalVal.toFixed(1) : "0.0";
                } else {
                    const h = Math.floor(totalVal);
                    const m = Math.round((totalVal - h) * 60);
                    totalStr = `${h}h ${m}m`;
                }
                
                const tr = document.createElement('tr');
                tr.style.borderBottom = '1px solid #333';
                
                let cellsHtml = `
                    <td style="padding: 10px 8px;">${index + 1}</td>
                    <td style="padding: 10px 8px; font-weight: bold; color: #fff;">${v.vehicle_no}</td>
                    <td style="padding: 10px 8px;">${v.type || '-'}</td>
                    <td style="padding: 10px 8px;">${v.category || 'NA'}</td>
                    <td style="padding: 10px 8px; font-weight: bold; color: #ffeb3b;">${totalStr}</td>
                `;
                
                dailyVals.forEach(val => {
                    let valStr = "";
                    if (type === 'km') {
                        valStr = val > 0 ? val.toFixed(1) : "-";
                    } else {
                        if (val > 0) {
                            const h = Math.floor(val);
                            const m = Math.round((val - h) * 60);
                            valStr = `${h}h ${m}m`;
                        } else {
                            valStr = "-";
                        }
                    }
                    cellsHtml += `<td style="padding: 10px 8px;">${valStr}</td>`;
                });
                
                tr.innerHTML = cellsHtml;
                tbody.appendChild(tr);
                
                reportRows.push({
                    vehicle: v.vehicle_no,
                    type: v.type || '-',
                    category: v.category || 'NA',
                    total: totalStr,
                    daily: dailyVals
                });
            });
            
            if (type === 'km') {
                currentKmReportData = { dates: datesList, rows: reportRows };
            } else {
                currentHoursReportData = { dates: datesList, rows: reportRows };
            }
            
            if (vehicles.length === 0) {
                tbody.innerHTML = '<tr><td colspan="5" style="padding: 12px; text-align: center;">No vehicles found.</td></tr>';
            }
            
        } catch (e) {
            console.error("Failed to generate report:", e);
            tbody.innerHTML = '<tr><td colspan="5" style="padding: 12px; text-align: center; color: red;">Error generating report.</td></tr>';
        }
    }
    
    const btnGenKm = document.getElementById('btn-generate-km');
    const btnGenHours = document.getElementById('btn-generate-hours');
    if (btnGenKm) btnGenKm.addEventListener('click', (e) => { e.preventDefault(); generateReport('km'); });
    if (btnGenHours) btnGenHours.addEventListener('click', (e) => { e.preventDefault(); generateReport('hours'); });

    // Export to Excel (Export ONLY filtered/visible rows from the DOM)
    function exportToExcel(type) {
        const tableId = type === 'km' ? 'table-km-report' : 'table-hours-report';
        const table = document.getElementById(tableId);
        if (!table) return;
        
        const rows = [];
        
        // Grab headers from the DOM
        const headerCells = table.querySelectorAll('thead tr th');
        const headers = Array.from(headerCells).map(th => th.textContent.trim());
        rows.push(headers);
        
        // Grab visible rows from the DOM
        const bodyRows = table.querySelectorAll('tbody tr');
        let visibleCount = 0;
        
        bodyRows.forEach(tr => {
            if (tr.style.display !== 'none') {
                visibleCount++;
                const cells = tr.querySelectorAll('td');
                // If there's only one cell spanning columns (like "No vehicles found"), ignore or skip
                if (cells.length < 3) return;
                
                const rowData = Array.from(cells).map((td, idx) => {
                    if (idx === 0) return visibleCount;
                    const txt = td.textContent.trim();
                    // Parse distance cells as floats where possible
                    if (type === 'km' && idx >= 4 && txt !== '-') {
                        const val = parseFloat(txt);
                        return isNaN(val) ? txt : val;
                    }
                    return txt;
                });
                rows.push(rowData);
            }
        });
        
        if (visibleCount === 0 || rows.length <= 1) {
            alert("No report data visible to export. Please generate the report first.");
            return;
        }
        
        const wb = XLSX.utils.book_new();
        const ws = XLSX.utils.aoa_to_sheet(rows);
        XLSX.utils.book_append_sheet(wb, ws, `${type.toUpperCase()} Report`);
        const filename = `${type}_report_${new Date().toISOString().split('T')[0]}.xlsx`;
        XLSX.writeFile(wb, filename);
    }

    // Export to PDF (Export ONLY filtered/visible rows from the DOM)
    function exportToPDF(type) {
        const tableId = type === 'km' ? 'table-km-report' : 'table-hours-report';
        const table = document.getElementById(tableId);
        if (!table) return;
        
        const headerCells = table.querySelectorAll('thead tr th');
        const headers = Array.from(headerCells).map(th => th.textContent.trim());
        
        const rows = [];
        const bodyRows = table.querySelectorAll('tbody tr');
        let visibleCount = 0;
        
        bodyRows.forEach(tr => {
            if (tr.style.display !== 'none') {
                visibleCount++;
                const cells = tr.querySelectorAll('td');
                if (cells.length < 3) return;
                
                const rowData = Array.from(cells).map((td, idx) => {
                    if (idx === 0) return visibleCount;
                    return td.textContent.trim();
                });
                rows.push(rowData);
            }
        });
        
        if (visibleCount === 0 || rows.length === 0) {
            alert("No report data visible to export. Please generate the report first.");
            return;
        }
        
        const { jsPDF } = window.jspdf;
        const doc = new jsPDF('l', 'mm', 'a4');
        
        doc.setFont("Helvetica", "bold");
        doc.setFontSize(16);
        doc.text(`iGPS Spoof ${type.toUpperCase()} Daily Report`, 14, 15);
        
        const fromDateStr = document.getElementById(type === 'km' ? 'km-from-date' : 'hours-from-date').value;
        const toDateStr = document.getElementById(type === 'km' ? 'km-to-date' : 'hours-to-date').value;
        doc.setFont("Helvetica", "normal");
        doc.setFontSize(10);
        doc.text(`Report Period: ${fromDateStr} to ${toDateStr}`, 14, 21);
        
        doc.autoTable({
            head: [headers],
            body: rows,
            startY: 25,
            theme: 'striped',
            headStyles: { fillColor: [15, 23, 42], fontSize: 8 },
            bodyStyles: { fontSize: 7, textColor: [33, 33, 33] },
            styles: { cellPadding: 1.5, halign: 'left' },
            margin: { left: 10, right: 10 }
        });
        
        const filename = `${type}_report_${new Date().toISOString().split('T')[0]}.pdf`;
        doc.save(filename);
    }
    
    const btnExpKmExcel = document.getElementById('btn-export-km-excel');
    const btnExpKmPdf = document.getElementById('btn-export-km-pdf');
    const btnExpHrsExcel = document.getElementById('btn-export-hours-excel');
    const btnExpHrsPdf = document.getElementById('btn-export-hours-pdf');
    
    if (btnExpKmExcel) btnExpKmExcel.addEventListener('click', (e) => { e.preventDefault(); exportToExcel('km'); });
    if (btnExpKmPdf) btnExpKmPdf.addEventListener('click', (e) => { e.preventDefault(); exportToPDF('km'); });
    if (btnExpHrsExcel) btnExpHrsExcel.addEventListener('click', (e) => { e.preventDefault(); exportToExcel('hours'); });
    if (btnExpHrsPdf) btnExpHrsPdf.addEventListener('click', (e) => { e.preventDefault(); exportToPDF('hours'); });

    pollStatus();
});

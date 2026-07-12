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
    
    async function loadVehicles() {
        try {
            const res = await fetch('/api/vehicles');
            const vehicles = await res.json();
            
            vehicleSelect.innerHTML = '';
            
            vehicles.forEach(v => {
                const option = document.createElement('option');
                option.value = v.imei;
                option.textContent = `${v.vehicle_no} (IMEI: ${v.imei})`;
                vehicleSelect.appendChild(option);
            });
            
        } catch (e) {
            console.error("Failed to load vehicles", e);
            vehicleSelect.innerHTML = '<option value="">Failed to load vehicles</option>';
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
    
    pollStatus();
});

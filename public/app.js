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

            if (currentMode === 'drive' || currentMode === 'drive_km') {
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
            
            const scheduleBtn = document.getElementById('schedule-btn');
            if (scheduleBtn) {
                if (currentMode === 'drive_km') {
                    scheduleBtn.classList.remove('hidden');
                } else {
                    scheduleBtn.classList.add('hidden');
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
            statusBadge.textContent = 'Spoofer Active';
            startBtn.classList.add('hidden');
            stopBtn.classList.remove('hidden');
            spinner.classList.remove('hidden');
            document.querySelectorAll('input, select, button.btn-secondary').forEach(i => i.disabled = true);
        } else {
            statusBadge.className = 'status-badge offline';
            statusBadge.textContent = 'System Offline';
            startBtn.classList.remove('hidden');
            stopBtn.classList.add('hidden');
            spinner.classList.add('hidden');
            document.querySelectorAll('input, select, button.btn-secondary').forEach(i => i.disabled = false);
            if(pollingInterval) clearInterval(pollingInterval);
        }
    }

    async function pollStatus() {
        try {
            const res = await fetch('/api/status');
            const data = await res.json();
            
            updateStatus(data.is_running);
            
            terminalOutput.innerHTML = '';
            data.logs.forEach(log => addLogLine(log));
            
            if(!data.is_running && pollingInterval) {
                clearInterval(pollingInterval);
            }
            
        } catch (e) {
            console.error("Failed to poll status", e);
        }
    }

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
            const res = await fetch('/api/start', {
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
                terminalOutput.innerHTML = '';
                addLogLine(`Initializing spoofer engine for ${imeis.length} vehicles...`);
                updateStatus(true);
                pollingInterval = setInterval(pollStatus, 1000);
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
                } else {
                    alert("Error scheduling: " + data.message);
                }
            } catch (e) {
                alert("Network error scheduling.");
            }
        });
    }

    stopBtn.addEventListener('click', async () => {
        try {
            const res = await fetch('/api/stop', { method: 'POST' });
            const data = await res.json();
            if (data.success) {
                updateStatus(false);
                addLogLine("[-] System offline. Reverted to hardware tracking.", true);
            }
        } catch (e) {
            alert("Network error.");
        }
    });
    
    pollStatus();
});

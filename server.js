const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const mqtt = require('mqtt');
const axios = require('axios');
const engine = require('./spoofer');
const { runTravelReport } = require('./travel_report_spoofer');

const app = express();
const port = 5001;
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) {
    try {
        fs.mkdirSync(DATA_DIR, { recursive: true });
    } catch (e) {
        console.error("Failed to create data directory:", e.message);
    }
}

const SCHEDULED_FILE = path.join(DATA_DIR, 'scheduled_jobs.json');
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');
const SLEEP_CONFIGS_FILE = path.join(DATA_DIR, 'sleep_configs.json');

// Auto-restore backup migration: Copy files from hostinger_deployment or parent to data/ folder if missing or empty
[
    { target: SCHEDULED_FILE, candidates: [path.join(__dirname, '..', 'scheduled_jobs.json'), path.join(__dirname, 'scheduled_jobs.json')] },
    { target: HISTORY_FILE, candidates: [path.join(__dirname, '..', 'history.json'), path.join(__dirname, 'history.json')] },
    { target: SLEEP_CONFIGS_FILE, candidates: [path.join(__dirname, '..', 'sleep_configs.json'), path.join(__dirname, 'sleep_configs.json')] }
].forEach(group => {
    try {
        let bestCandidate = null;
        let maxSize = -1;
        
        group.candidates.forEach(cand => {
            if (fs.existsSync(cand)) {
                const size = fs.statSync(cand).size;
                if (size > maxSize) {
                    maxSize = size;
                    bestCandidate = cand;
                }
            }
        });
        
        const targetExists = fs.existsSync(group.target);
        const targetSize = targetExists ? fs.statSync(group.target).size : 0;
        
        if (bestCandidate && (!targetExists || targetSize < 10) && maxSize > targetSize) {
            console.log(`Auto-restoring ${path.basename(bestCandidate)} to ${group.target} (${maxSize} bytes)...`);
            fs.copyFileSync(bestCandidate, group.target);
        }
    } catch (err) {
        console.error(`Failed to migrate/restore ${path.basename(group.target)}:`, err.message);
    }
});

// Seed missing May 1-3, 2026 spoofing records for vehicle 9713 (IMEI 869925071606287) if history is empty
try {
    const targetImei = '869925071606287';
    let history = [];
    if (fs.existsSync(HISTORY_FILE)) {
        try {
            history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8') || '[]');
        } catch(e) {}
    }
    
    const hasMay1 = history.some(h => h.imei === targetImei && h.date === '2026-05-01');
    const hasMay2 = history.some(h => h.imei === targetImei && h.date === '2026-05-02');
    const hasMay3 = history.some(h => h.imei === targetImei && h.date === '2026-05-03');
    
    let changed = false;
    if (!hasMay1) {
        history.push({
            timestamp: "2026-05-01 12:56:46",
            date: "2026-05-01",
            imei: targetImei,
            vehicle_no: "TN 45 CB 9713",
            mode: "travel_report",
            added_km: 3.3,
            start_odo: 2552.82,
            final_odo: 2556.12,
            target_hours: 0,
            shield_hours: 0
        });
        changed = true;
    }
    if (!hasMay2) {
        history.push({
            timestamp: "2026-05-02 17:56:53",
            date: "2026-05-02",
            imei: targetImei,
            vehicle_no: "TN 45 CB 9713",
            mode: "travel_report",
            added_km: 3.3,
            start_odo: 2556.12,
            final_odo: 2559.42,
            target_hours: 0,
            shield_hours: 0
        });
        changed = true;
    }
    if (!hasMay3) {
        history.push({
            timestamp: "2026-05-03 10:00:00",
            date: "2026-05-03",
            imei: targetImei,
            vehicle_no: "TN 45 CB 9713",
            mode: "travel_report",
            added_km: 3.3,
            start_odo: 2559.42,
            final_odo: 2562.72,
            target_hours: 0,
            shield_hours: 0
        });
        changed = true;
    }
    
    if (changed) {
        console.log("Auto-seeding May 1-3 spoofing records for vehicle 9713...");
        fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 4));
    }
} catch (err) {
    console.error("Failed to seed May history records:", err.message);
}

app.use(cors());
app.use(express.json());
// Serve the frontend UI exactly like Flask's "static" folder
app.use(express.static('public'));

function loadScheduledJobs() {
    try {
        if (fs.existsSync(SCHEDULED_FILE)) {
            const data = fs.readFileSync(SCHEDULED_FILE, 'utf8');
            return JSON.parse(data);
        }
    } catch (e) {
        console.error("Error reading schedule:", e);
    }
    return [];
}

function saveScheduledJobs(jobs) {
    fs.writeFileSync(SCHEDULED_FILE, JSON.stringify(jobs, null, 4));
}

// Background scheduler running every 30 seconds
setInterval(() => {
    const now = new Date();
    // Convert current UTC time to IST by adding 5 hours 30 mins
    const ist_time = new Date(now.getTime() + (5.5 * 3600000));
    
    // Check if IST time is 23:55 (11:55 PM)
    if (ist_time.getUTCHours() === 23 && ist_time.getUTCMinutes() === 55) {
        const jobs = loadScheduledJobs();
        if (jobs && jobs.length > 0) {
            console.log(`[SCHEDULER] Woke up at ${now}. Found ${jobs.length} jobs. Triggering Spoofing...`);
            
            jobs.forEach(job => {
                // Set is_scheduled flag inside engine so it uses 23:59:50 timestamp
                engine.is_scheduled = true;
                
                // Force history_date to empty so it defaults to today 23:59:50
                engine.start(
                    job.imeis || [], 
                    job.lat, 
                    job.lng, 
                    job.mode, 
                    '', 
                    parseFloat(job.target_hours || 0), 
                    parseFloat(job.start_odo || 0), 
                    parseFloat(job.speed || 0), 
                    parseFloat(job.start_today_odo || 0),
                    parseFloat(job.shield_hours || 0)
                );
            });
            
            console.log("[SCHEDULER] All jobs injected. Clearing schedule.");
            saveScheduledJobs([]);
        }
    }
}, 30000);

function loadSleepConfigs() {
    try {
        if (fs.existsSync(SLEEP_CONFIGS_FILE)) {
            return JSON.parse(fs.readFileSync(SLEEP_CONFIGS_FILE, 'utf8'));
        }
    } catch (e) {
        console.error("Error reading sleep configs:", e);
    }
    return {};
}

function saveSleepConfigs(configs) {
    fs.writeFileSync(SLEEP_CONFIGS_FILE, JSON.stringify(configs, null, 4));
}

// API Routes
app.get('/api/vehicles', (req, res) => {
    try {
        const vehiclesData = fs.readFileSync(path.join(__dirname, 'vehicles.json'), 'utf8');
        const vehicles = JSON.parse(vehiclesData);
        const sleepConfigs = loadSleepConfigs();
        
        vehicles.forEach(v => {
            v.sleep_mode = !!sleepConfigs[v.imei];
        });
        
        res.json(vehicles);
    } catch (e) {
        res.json([]);
    }
});

app.post('/api/start', (req, res) => {
    const data = req.body;
    
    engine.is_scheduled = false; // Reset if started manually
    const success = engine.start(
        data.imeis || [],
        data.lat,
        data.lng,
        data.mode,
        data.history_date || '',
        parseFloat(data.target_hours || 0),
        parseFloat(data.start_odo || 0),
        parseFloat(data.speed || 0),
        parseFloat(data.start_today_odo || 0),
        parseFloat(data.shield_hours || 0)
    );
    
    res.json({ success: success, message: success ? "Spoofer started successfully." : "Spoofer is already running." });
});

app.post('/api/schedule', (req, res) => {
    const data = req.body;
    const jobs = loadScheduledJobs();
    jobs.push(data);
    saveScheduledJobs(jobs);
    
    const count = (data.imeis || []).length;
    res.json({ success: true, message: `Successfully scheduled ${count} vehicles for 11:55 PM!` });
});

app.post('/api/stop', (req, res) => {
    const success = engine.stop();
    res.json({ success: success, message: success ? "Spoofer stopped successfully." : "Spoofer is not running." });
});

app.post('/api/fetch_odo', async (req, res) => {
    const data = req.body;
    if (!data.imei) return res.json({ success: false, odo: 0 });
    
    const result = await engine.fetch_live_data_instant(data.imei, data.history_date || null);
    res.json(result);
});

app.get('/api/status', (req, res) => {
    let history = [];
    try {
        if (fs.existsSync(HISTORY_FILE)) {
            history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
        }
    } catch(e) {}
    
    res.json({
        is_running: engine.is_running,
        mode: engine.mode,
        logs: engine.get_logs(),
        scheduled_jobs: loadScheduledJobs(),
        active_shields: engine.get_active_shields(),
        history: history
    });
});

app.post('/api/cancel_schedule', (req, res) => {
    const { index } = req.body;
    const jobs = loadScheduledJobs();
    if (index >= 0 && index < jobs.length) {
        jobs.splice(index, 1);
        saveScheduledJobs(jobs);
        res.json({ success: true, message: 'Scheduled job cancelled successfully.' });
    } else {
        res.json({ success: false, message: 'Job not found.' });
    }
});

app.post('/api/cancel_shield', (req, res) => {
    const { imei } = req.body;
    const success = engine.cancel_shield(imei);
    res.json({ success: success, message: success ? `Shield for ${imei} cancelled.` : 'Shield not found.' });
});

app.get('/api/history', (req, res) => {
    try {
        if (fs.existsSync(HISTORY_FILE)) {
            const data = fs.readFileSync(HISTORY_FILE, 'utf8');
            res.json(JSON.parse(data));
        } else {
            res.json([]);
        }
    } catch (e) {
        res.json([]);
    }
});

app.delete('/api/history', (req, res) => {
    try {
        fs.writeFileSync(HISTORY_FILE, JSON.stringify([]));
        res.json({ success: true, message: 'History cleared.' });
    } catch (e) {
        res.json({ success: false, message: 'Failed to clear history.' });
    }
});

app.post('/api/clear-logs', (req, res) => {
    engine.logs = [];
    res.json({ success: true, message: 'Telemetry logs cleared on server.' });
});


app.post('/api/run-travel-report', (req, res) => {
    const { imeis, date, hours, speed, hours_only } = req.body;
    if (!imeis || !date) {
        return res.json({ success: false, message: 'IMEI list and Date are required.' });
    }
    
    console.log(`[TR] Starting Auto Travel Report (hours_only=${hours_only}) for ${imeis.length} vehicles...`);
    
    imeis.forEach(async (imei) => {
        try {
            const is_hours_only = !!hours_only;
            const target_h = parseFloat(hours || 1.5);
            const target_spd = parseFloat(speed || 30);
            
            await runTravelReport(imei, date, target_h, target_spd, (msg) => {
                console.log(`[TR] [${imei}] ${msg}`);
                engine.log(`[TR] [${imei}] ${msg}`);
            }, is_hours_only);
            
            console.log(`[TR] [${imei}] Finished successfully.`);
            const added_km = is_hours_only ? 0 : (target_h * target_spd);
            engine.save_history(imei, is_hours_only ? "travel_hours" : "travel_report", added_km, 0, 0, target_h, 0, date);
        } catch (err) {
            console.error(`[TR ERROR] [${imei}] ${err.message}`);
            engine.log(`[TR ERROR] [${imei}] ${err.message}`);
        }
    });
    
    res.json({ success: true, message: `Started Auto Travel Report for ${imeis.length} vehicles.` });
});

app.post('/api/send-command', (req, res) => {
    const { imeis, command } = req.body;
    if (!imeis || !command) {
        return res.json({ success: false, message: 'IMEI list and Command are required.' });
    }
    
    let vehicles = [];
    try {
        vehicles = require('./vehicles.json');
    } catch (e) {
        console.error("Failed to load vehicles.json for commands:", e.message);
    }
    
    engine.log(`[CMD] Sending "${command}" to ${imeis.length} vehicle(s)...`);
    
    const client = mqtt.connect("mqtt://igps.io:1883", {
        username: "realiot",
        password: "realmqtt@123",
        clientId: `mqttjs_cmd_${Math.random().toString(16).substr(2, 8)}`,
        connectTimeout: 5000
    });
    
    client.on('error', (err) => {
        console.error("[CMD ERROR] MQTT Client Error:", err.message);
        engine.log(`[CMD ERROR] MQTT Client Error: ${err.message}`);
    });
    
    client.on('connect', () => {
        // Subscribe to both base topic BB/IMEI and subtopic BB/IMEI/LIVE for all target vehicles
        imeis.forEach(imei => {
            const baseTopic = `BB/${imei}`;
            const liveTopic = `BB/${imei}/LIVE`;
            
            client.subscribe(baseTopic, (err) => {
                if (err) {
                    console.error(`[CMD ERROR] Failed to subscribe to base response topic for ${imei}:`, err.message);
                } else {
                    console.log(`[CMD] Listening on: ${baseTopic}`);
                }
            });

            client.subscribe(liveTopic, (err) => {
                if (err) {
                    console.error(`[CMD ERROR] Failed to subscribe to live response topic for ${imei}:`, err.message);
                } else {
                    console.log(`[CMD] Listening on: ${liveTopic}`);
                    engine.log(`[CMD] Listening for replies on: ${liveTopic}`);
                }
            });
        });

        // Publish the GPRS commands using the validated session parameters (trichy / 10-digit number)
        imeis.forEach(imei => {
            const topic = `BB/${imei}/CMD`;
            const v = vehicles.find(item => item.imei === imei);
            
            // Check if vehicle has a valid 10-digit mobile number, otherwise default to a valid user mobile
            let phone = "9043527299";
            if (v && v.sim && v.sim.length === 10 && !isNaN(v.sim)) {
                phone = v.sim;
            }
            
            const random_prefix = Math.floor(10000 + Math.random() * 90000);
            const payload = `DATA=${random_prefix}-ad$trichy$${command},${phone}`;
            
            client.publish(topic, payload, (err) => {
                if (err) {
                    console.error(`[CMD ERROR] Failed to send to ${imei}:`, err.message);
                    engine.log(`[CMD ERROR] Failed to send to ${imei}: ${err.message}`);
                } else {
                    console.log(`[CMD SUCCESS] Sent to ${imei}: ${payload}`);
                }
            });
        });
        
        // Handle incoming responses
        client.on('message', (topic, payload) => {
            try {
                const msgStr = payload.toString();
                const parts = topic.split('/');
                const imei = parts[1];
                const isLive = parts[2] === 'LIVE';
                
                // Get vehicle name if available
                const v = vehicles.find(item => item.imei === imei);
                const name = v ? v.vehicle_no : imei;
                
                // Filter out standard GPS telemetry payloads on the base topic (e.g. ##,862...)
                // to avoid flooding the feed, but capture actual text responses (e.g. status status, OK, sleep ok, etc.)
                // and command acknowledgments (containing "-ad")
                if (isLive || msgStr.includes('-ad') || (!msgStr.startsWith('##') && !msgStr.startsWith('%%'))) {
                    let displayMsg = msgStr;
                    if (msgStr.includes('-ad')) {
                        // Extract the command suffix token (e.g. 77296-ad,$)
                        const parts = msgStr.split(',');
                        const ackPart = parts.find(p => p.includes('-ad'));
                        displayMsg = `Command Ack received: ${ackPart || 'OK'}`;
                    }
                    console.log(`[CMD RESPONSE] [${name}] ${displayMsg}`);
                    engine.log(`[CMD RESPONSE] [${name}] ${displayMsg}`);
                }
            } catch (err) {
                console.error("[CMD RESPONSE ERROR] Error parsing response:", err.message);
            }
        });

        // End listener after 30 seconds
        setTimeout(() => {
            console.log("[CMD] Closing command response listener client.");
            client.end();
        }, 30000);
    });
    
    res.json({ success: true, message: `Command transmission started for ${imeis.length} vehicles.` });
});

app.post('/api/set-sleep-state', (req, res) => {
    const { imei, enabled } = req.body;
    if (!imei) {
        return res.json({ success: false, message: 'IMEI is required.' });
    }
    
    // Read and verify vehicle exists
    let vehicles = [];
    const VEHICLES_FILE = path.join(__dirname, 'vehicles.json');
    try {
        vehicles = JSON.parse(fs.readFileSync(VEHICLES_FILE, 'utf8'));
        const v = vehicles.find(item => item.imei === imei);
        if (v) {
            // Save state to sleep_configs.json instead of vehicles.json
            const sleepConfigs = loadSleepConfigs();
            sleepConfigs[imei] = !!enabled;
            saveSleepConfigs(sleepConfigs);
        } else {
            return res.json({ success: false, message: 'Vehicle not found.' });
        }
    } catch (e) {
        console.error("Error updating sleep configs:", e.message);
        return res.json({ success: false, message: 'Failed to update sleep configuration.' });
    }
    
    // Formulate GPRS command: SLEEP 005 for Truck Boss (IMEI starts with 86294), TIMER,10,36000# for Concox/KTT
    const isTruckBoss = imei.startsWith("86294");
    const command = enabled 
        ? (isTruckBoss ? "SLEEP 005" : "TIMER,10,36000#")
        : (isTruckBoss ? "SLEEP 000" : "TIMER,10,60#");
    engine.log(`[SLEEP SETTING] Toggling sleep mode ${enabled ? 'ON' : 'OFF'} for vehicle ${imei} using command "${command}"...`);
    
    const client = mqtt.connect("mqtt://igps.io:1883", {
        username: "realiot",
        password: "realmqtt@123",
        clientId: `mqttjs_sleep_${Math.random().toString(16).substr(2, 8)}`,
        connectTimeout: 5000
    });
    
    client.on('error', (err) => {
        console.error("[SLEEP ERROR] MQTT Client Error:", err.message);
        engine.log(`[SLEEP ERROR] MQTT Error: ${err.message}`);
    });
    
    client.on('connect', () => {
        const liveTopic = `BB/${imei}/LIVE`;
        const baseTopic = `BB/${imei}`;
        
        // Subscribe to responses
        client.subscribe(baseTopic);
        client.subscribe(liveTopic);
        
        const cmdTopic = `BB/${imei}/CMD`;
        const v = vehicles.find(item => item.imei === imei);
        let phone = "9043527299";
        if (v && v.sim && v.sim.length === 10 && !isNaN(v.sim)) {
            phone = v.sim;
        }
        
        const random_prefix = Math.floor(10000 + Math.random() * 90000);
        const payload = `DATA=${random_prefix}-ad$trichy$${command},${phone}`;
        
        client.publish(cmdTopic, payload, (err) => {
            if (err) {
                console.error(`[SLEEP ERROR] Failed to publish command to ${imei}:`, err.message);
                engine.log(`[SLEEP ERROR] Failed to send: ${err.message}`);
            } else {
                console.log(`[SLEEP SUCCESS] Command published to ${imei}: ${payload}`);
            }
        });
        
        client.on('message', (topic, payload) => {
            try {
                const msgStr = payload.toString();
                const parts = topic.split('/');
                const isLive = parts[2] === 'LIVE';
                
                if (isLive || msgStr.includes('-ad') || (!msgStr.startsWith('##') && !msgStr.startsWith('%%'))) {
                    let displayMsg = msgStr;
                    if (msgStr.includes('-ad')) {
                        const parts = msgStr.split(',');
                        const ackPart = parts.find(p => p.includes('-ad'));
                        displayMsg = `Command Ack received: ${ackPart || 'OK'}`;
                    }
                    console.log(`[SLEEP RESPONSE] [${v.vehicle_no}] ${displayMsg}`);
                    engine.log(`[SLEEP RESPONSE] [${v.vehicle_no}] ${displayMsg}`);
                }
            } catch (err) {}
        });
        
        // Close client after 30 seconds
        setTimeout(() => {
            client.end();
        }, 30000);
    });
    
    res.json({ success: true, message: `Command "${command}" published successfully to device.` });
});

app.listen(port, () => {
    console.log(`Node.js Admin Dashboard running at http://localhost:${port}`);
});

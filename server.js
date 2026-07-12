const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const mqtt = require('mqtt');
const engine = require('./spoofer');
const { runTravelReport } = require('./travel_report_spoofer');

const app = express();
const port = 5001;
const SCHEDULED_FILE = 'scheduled_jobs.json';
const HISTORY_FILE = 'history.json';

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

// API Routes
app.get('/api/vehicles', (req, res) => {
    try {
        const vehicles = require('./vehicles.json');
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
app.post('/api/run-travel-report', (req, res) => {
    const { imeis, date, hours, speed, hours_only } = req.body;
    if (!imeis || !date) {
        return res.json({ success: false, message: 'IMEI list and Date are required.' });
    }
    
    console.log(`[TR] Starting Auto Travel Report (hours_only=${hours_only}) for ${imeis.length} vehicles...`);
    
    imeis.forEach(async (imei) => {
        try {
            await runTravelReport(imei, date, hours || 1.5, speed || 30, (msg) => {
                console.log(`[TR] [${imei}] ${msg}`);
                engine.log(`[TR] [${imei}] ${msg}`);
            }, hours_only || false);
            console.log(`[TR] [${imei}] Finished successfully.`);
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
    
    // Read and update vehicles.json
    let vehicles = [];
    const VEHICLES_FILE = path.join(__dirname, 'vehicles.json');
    try {
        vehicles = JSON.parse(fs.readFileSync(VEHICLES_FILE, 'utf8'));
        const v = vehicles.find(item => item.imei === imei);
        if (v) {
            v.sleep_mode = !!enabled;
            fs.writeFileSync(VEHICLES_FILE, JSON.stringify(vehicles, null, 4));
        } else {
            return res.json({ success: false, message: 'Vehicle not found.' });
        }
    } catch (e) {
        console.error("Error updating vehicles.json for sleep mode:", e.message);
        return res.json({ success: false, message: 'Failed to update vehicle configuration.' });
    }
    
    // Formulate GPRS command: TIMER,10,36000# to enable sleep, TIMER,10,60# to disable
    const command = enabled ? "TIMER,10,36000#" : "TIMER,10,60#";
    engine.log(`[SLEEP SETTING] Toggling sleep mode ${enabled ? 'ON' : 'OFF'} for vehicle ${imei}...`);
    
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

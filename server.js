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
const DATA_DIR = path.join(__dirname, '..', 'data_storage');
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

// Migrate old data if present
[
    { target: SCHEDULED_FILE, src: path.join(__dirname, 'data', 'scheduled_jobs.json') },
    { target: HISTORY_FILE, src: path.join(__dirname, 'data', 'history.json') },
    { target: SLEEP_CONFIGS_FILE, src: path.join(__dirname, 'data', 'sleep_configs.json') }
].forEach(group => {
    try {
        if (fs.existsSync(group.src) && !fs.existsSync(group.target)) {
            fs.copyFileSync(group.src, group.target);
            console.log(`Migrated ${path.basename(group.target)} to safe data_storage.`);
        }
    } catch(e) {}
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

app.post('/api/refresh_cache', (req, res) => {
    const { imeis, date, override_km, override_normal_km } = req.body;
    if (!imeis || !date) {
        return res.json({ success: false, message: 'IMEI list and Date are required.' });
    }
    
    console.log(`[REFRESH] Starting Cache Refresh for ${imeis.length} vehicles on date ${date}...`);
    engine.log(`[REFRESH] Starting Cache Refresh for ${imeis.length} vehicles on date: ${date}`);
    
    imeis.forEach(async (imei) => {
        try {
            engine.log(`[REFRESH] [${imei}] Syncing reports table summary...`);
            
            let total_km_str = null;
            let normal_km_str = null;
            let use_override = false;
            
            if (override_km !== undefined && String(override_km).trim() !== "") {
                const val = parseFloat(override_km);
                if (!isNaN(val)) {
                    total_km_str = val.toFixed(3);
                    use_override = true;
                } else {
                    engine.log(`[REFRESH] [${imei}] Invalid override KM format: ${override_km}`);
                }
            }
            
            if (override_normal_km !== undefined && String(override_normal_km).trim() !== "") {
                normal_km_str = String(override_normal_km).trim();
                use_override = true;
            }
            
            if (!use_override) {
                engine.log(`[REFRESH] [${imei}] Fetching raw history telemetry...`);
                const from_date_str = `${date} 00:00:00`;
                const to_date_str = `${date} 23:59:59`;
                
                const params = new URLSearchParams();
                params.append('imei', imei);
                params.append('from', from_date_str);
                params.append('to', to_date_str);
                params.append('username', 'trichy');
                params.append('action', 'history_web');
                
                const history_res = await axios.post('http://dev.igps.io/http.php', params.toString(), {
                    headers: {'Content-Type': 'application/x-www-form-urlencoded'},
                    timeout: 15000
                });
                
                const history_data = history_res.data;
                if (!Array.isArray(history_data) || history_data.length === 0) {
                    engine.log(`[REFRESH] [${imei}] No raw history packets found. Skipping.`);
                    return;
                }
                
                const odos = [];
                history_data.forEach(pkt => {
                    const totel_km = pkt.totel_km || "";
                    if (!totel_km) return;
                    try {
                        let val;
                        if (totel_km.includes("-")) {
                            val = parseFloat(totel_km.split("-")[0]);
                        } else {
                            val = parseFloat(totel_km);
                        }
                        if (!isNaN(val)) odos.push(val);
                    } catch(e) {}
                });
                
                if (odos.length < 2) {
                    engine.log(`[REFRESH] [${imei}] Insufficient odometer packets to calculate run. Skipping.`);
                    return;
                }
                
                const max_odo = Math.max(...odos);
                const min_odo = Math.min(...odos);
                const total_km = max_odo - min_odo;
                total_km_str = total_km.toFixed(3);
                
                // Split trips to build normal_km
                const trips = [];
                let current_trip_odos = [];
                
                history_data.forEach(pkt => {
                    const speed = parseFloat(pkt.speed || 0);
                    const totel_km = pkt.totel_km || "";
                    if (!totel_km) return;
                    let val;
                    try {
                        if (totel_km.includes("-")) {
                            val = parseFloat(totel_km.split("-")[0]);
                        } else {
                            val = parseFloat(totel_km);
                        }
                    } catch(e) { return; }
                    
                    if (isNaN(val)) return;
                    
                    if (speed > 0) {
                        current_trip_odos.push(val);
                    } else {
                        if (current_trip_odos.length > 1) {
                            const trip_dist = Math.max(...current_trip_odos) - Math.min(...current_trip_odos);
                            if (trip_dist > 0.01) {
                                trips.push(parseFloat(trip_dist.toFixed(3)));
                            }
                            current_trip_odos = [];
                        }
                    }
                });
                
                if (current_trip_odos.length > 1) {
                    const trip_dist = Math.max(...current_trip_odos) - Math.min(...current_trip_odos);
                    if (trip_dist > 0.01) {
                        trips.push(parseFloat(trip_dist.toFixed(3)));
                    }
                }
                
                if (trips.length === 0) {
                    trips.push(parseFloat(total_km.toFixed(3)));
                }
                
                normal_km_str = trips.join(",");
                engine.log(`[REFRESH] [${imei}] Auto-calculated Run KM: ${total_km_str}, Trips: [${normal_km_str}]`);
            } else {
                if (total_km_str === null) {
                    try {
                        const sum = normal_km_str.split(",").map(parseFloat).reduce((a, b) => a + b, 0);
                        total_km_str = sum.toFixed(3);
                    } catch(e) {
                        total_km_str = "0.000";
                    }
                }
                if (normal_km_str === null) {
                    normal_km_str = total_km_str;
                }
                engine.log(`[REFRESH] [${imei}] Using Manual Override Run KM: ${total_km_str}, Trips: [${normal_km_str}]`);
            }
            
            // Check reports table row
            const target_date_db = `${date} 00:00:00`;
            const check_query = `SELECT sno, km FROM reports WHERE imei = '${imei}' AND dt = '${target_date_db}'`;
            const check_params = new URLSearchParams();
            check_params.append('action', 'select');
            check_params.append('query', Buffer.from(check_query).toString('base64'));
            check_params.append('type', 'select');
            
            const check_res = await axios.post('http://dev.igps.io/http.php', check_params.toString(), {
                headers: {'Content-Type': 'application/x-www-form-urlencoded'},
                timeout: 10000
            });
            
            if (Array.isArray(check_res.data) && check_res.data.length > 0) {
                // Update
                const old_km = check_res.data[0].km || "0";
                const update_query = `UPDATE reports SET km = '${total_km_str}', normal_km = '${normal_km_str}' WHERE imei = '${imei}' AND dt = '${target_date_db}'`;
                const update_params = new URLSearchParams();
                update_params.append('action', 'select');
                update_params.append('query', Buffer.from(update_query).toString('base64'));
                update_params.append('type', 'update');
                
                await axios.post('http://dev.igps.io/http.php', update_params.toString(), {
                    headers: {'Content-Type': 'application/x-www-form-urlencoded'},
                    timeout: 10000
                });
                engine.log(`[REFRESH] [${imei}] Updated report row. Original KM: ${old_km} -> New KM: ${total_km_str}`);
            } else {
                // Insert
                const insert_query = `INSERT INTO reports (imei, dt, km, normal_km, username) VALUES ('{imei}', '{target_date_db}', '{total_km_str}', '{normal_km_str}', 'trichy')`;
                const insert_params = new URLSearchParams();
                insert_params.append('action', 'select');
                insert_params.append('query', Buffer.from(insert_query).toString('base64'));
                insert_params.append('type', 'insert');
                
                await axios.post('http://dev.igps.io/http.php', insert_params.toString(), {
                    headers: {'Content-Type': 'application/x-www-form-urlencoded'},
                    timeout: 10000
                });
                engine.log(`[REFRESH] [${imei}] Created new daily report row: ${total_km_str} KM`);
            }
        } catch(err) {
            console.error(`[REFRESH ERROR] [${imei}] ${err.message}`);
            engine.log(`[REFRESH ERROR] [${imei}] ${err.message}`);
        }
    });
    
    res.json({ success: true, message: `Cache refresh started for ${imeis.length} vehicles.` });
});

app.post('/api/fetch_existing_trips', async (req, res) => {
    const { imei, date } = req.body;
    if (!imei || !date) {
        return res.json({ success: false, message: 'IMEI and Date are required.' });
    }
    
    try {
        const target_date_db = `${date} 00:00:00`;
        const check_query = `SELECT normal_km FROM reports WHERE imei = '${imei}' AND dt = '${target_date_db}'`;
        const check_params = new URLSearchParams();
        check_params.append('action', 'select');
        check_params.append('query', Buffer.from(check_query).toString('base64'));
        check_params.append('type', 'select');
        
        const check_res = await axios.post('http://dev.igps.io/http.php', check_params.toString(), {
            headers: {'Content-Type': 'application/x-www-form-urlencoded'},
            timeout: 10000
        });
        
        if (Array.isArray(check_res.data) && check_res.data.length > 0) {
            const normal_km = check_res.data[0].normal_km || "";
            if (normal_km) {
                return res.json({ success: true, normal_km: normal_km });
            }
        }
        
        // Fallback to history calculations
        const from_date_str = `${date} 00:00:00`;
        const to_date_str = `${date} 23:59:59`;
        
        const params = new URLSearchParams();
        params.append('imei', imei);
        params.append('from', from_date_str);
        params.append('to', to_date_str);
        params.append('username', 'trichy');
        params.append('action', 'history_web');
        
        const history_res = await axios.post('http://dev.igps.io/http.php', params.toString(), {
            headers: {'Content-Type': 'application/x-www-form-urlencoded'},
            timeout: 15000
        });
        
        const history_data = history_res.data;
        if (Array.isArray(history_data) && history_data.length > 0) {
            const odos = [];
            history_data.forEach(pkt => {
                const totel_km = pkt.totel_km || "";
                if (!totel_km) return;
                try {
                    let val;
                    if (totel_km.includes("-")) {
                        val = parseFloat(totel_km.split("-")[0]);
                    } else {
                        val = parseFloat(totel_km);
                    }
                    if (!isNaN(val)) odos.push(val);
                } catch(e) {}
            });
            
            if (odos.length >= 2) {
                const total_km = Math.max(...odos) - Math.min(...odos);
                const trips = [];
                let current_trip_odos = [];
                
                history_data.forEach(pkt => {
                    const speed = parseFloat(pkt.speed || 0);
                    const totel_km = pkt.totel_km || "";
                    if (!totel_km) return;
                    let val;
                    try {
                        if (totel_km.includes("-")) {
                            val = parseFloat(totel_km.split("-")[0]);
                        } else {
                            val = parseFloat(totel_km);
                        }
                    } catch(e) { return; }
                    
                    if (isNaN(val)) return;
                    
                    if (speed > 0) {
                        current_trip_odos.push(val);
                    } else {
                        if (current_trip_odos.length > 1) {
                            const trip_dist = Math.max(...current_trip_odos) - Math.min(...current_trip_odos);
                            if (trip_dist > 0.01) {
                                trips.push(parseFloat(trip_dist.toFixed(3)));
                            }
                            current_trip_odos = [];
                        }
                    }
                });
                
                if (current_trip_odos.length > 1) {
                    const trip_dist = Math.max(...current_trip_odos) - Math.min(...current_trip_odos);
                    if (trip_dist > 0.01) {
                        trips.push(parseFloat(trip_dist.toFixed(3)));
                    }
                }
                
                if (trips.length === 0) {
                    trips.push(parseFloat(total_km.toFixed(3)));
                }
                
                return res.json({ success: true, normal_km: trips.join(",") });
            }
        }
    } catch(err) {
        console.error(err);
    }
    
    return res.json({ success: false, message: 'Could not fetch any trip data.' });
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
            
            // Auto-engage shield if date is today (IST)
            const istToday = new Date(Date.now() + (330 * 60000)).toISOString().split('T')[0];
            if (date === istToday) {
                // Fetch the final state to lock the correct final odometer and coordinates
                const state = await engine.fetch_live_data_instant(imei, date);
                const final_odo = state.odo || 0.0;
                const final_lat = state.lat || 10.822819;
                const final_lng = state.lng || 78.681126;
                
                // Engage Shield for 12 hours
                engine.engage_shield(imei, final_odo, final_lat, final_lng, is_hours_only, 12);
            }
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

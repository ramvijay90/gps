const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const mqtt = require('mqtt');
const axios = require('axios');
const { exec } = require('child_process');
const PYTHON_CMD = process.platform === 'win32' ? 'python' : 'python3';
const engine = require('./spoofer');
const { runTravelReport } = require('./travel_report_spoofer');

const app = express();
const port = process.env.PORT || 5001;
const DATA_DIR = fs.existsSync(path.join(__dirname, 'data_storage'))
    ? path.join(__dirname, 'data_storage')
    : path.join(__dirname, '..', 'data_storage');
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

async function insertHistoryIntoDatabase(record) {
    try {
        const insertSql = `INSERT INTO \`gps_history_log\` (timestamp, date, imei, mode, added_km, start_odo, final_odo, target_hours, shield_hours) VALUES ('${record.timestamp}', '${record.date}', '${record.imei}', '${record.mode}', ${record.added_km || 0}, ${record.start_odo || 0}, ${record.final_odo || 0}, ${record.target_hours || 0}, ${record.shield_hours || 0})`;
        const sqlB64 = Buffer.from(insertSql).toString('base64');
        const params = new URLSearchParams();
        params.append('action', 'select');
        params.append('query', sqlB64);
        params.append('type', 'select');
        
        await axios.post('http://dev.igps.io/http.php', params.toString(), {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'User-Agent': 'Mozilla/5.0'
            },
            timeout: 5000
        });
    } catch (e) {
        console.error("[-] Failed to insert history record into database:", e.message);
    }
}

async function initHistoryFromDatabase() {
    try {
        let localHistory = [];
        if (fs.existsSync(HISTORY_FILE)) {
            try {
                localHistory = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8') || '[]');
            } catch(e) {}
        }
        if (!Array.isArray(localHistory)) localHistory = [];

        console.log("[INIT] Fetching history from MySQL database...");
        const sql = "SELECT * FROM `gps_history_log` ORDER BY sno DESC LIMIT 1000";
        const sqlB64 = Buffer.from(sql).toString('base64');
        const params = new URLSearchParams();
        params.append('action', 'select');
        params.append('query', sqlB64);
        params.append('type', 'select');
        
        const res = await axios.post('http://dev.igps.io/http.php', params.toString(), {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'User-Agent': 'Mozilla/5.0'
            },
            timeout: 10000
        });
        
        let dbHistory = [];
        const rows = res.data;
        if (Array.isArray(rows)) {
            dbHistory = rows.map(r => ({
                timestamp: r.timestamp,
                date: r.date,
                imei: r.imei,
                mode: r.mode,
                added_km: parseFloat(r.added_km || 0),
                start_odo: parseFloat(r.start_odo || 0),
                final_odo: parseFloat(r.final_odo || 0),
                target_hours: parseFloat(r.target_hours || 0),
                shield_hours: parseFloat(r.shield_hours || 0)
            }));
        }
        
        const dbKeys = new Set(dbHistory.map(h => `${h.imei}_${h.timestamp}`));
        let migratedCount = 0;
        for (const localRec of localHistory) {
            const key = `${localRec.imei}_${localRec.timestamp}`;
            if (localRec.imei && localRec.timestamp && !dbKeys.has(key)) {
                await insertHistoryIntoDatabase(localRec);
                dbHistory.push(localRec);
                dbKeys.add(key);
                migratedCount++;
            }
        }
        if (migratedCount > 0) {
            console.log(`[INIT] Migrated ${migratedCount} local history records to remote MySQL database.`);
        }
        
        const targetImei = '869925071606287';
        const hasMay1 = dbHistory.some(h => h.imei === targetImei && h.date === '2026-05-01');
        const hasMay2 = dbHistory.some(h => h.imei === targetImei && h.date === '2026-05-02');
        const hasMay3 = dbHistory.some(h => h.imei === targetImei && h.date === '2026-05-03');
        
        if (!hasMay3) {
            const record = {
                timestamp: "2026-05-03 10:00:00",
                date: "2026-05-03",
                imei: targetImei,
                mode: "travel_report",
                added_km: 3.3,
                start_odo: 2559.42,
                final_odo: 2562.72,
                target_hours: 0,
                shield_hours: 0
            };
            dbHistory.push(record);
            await insertHistoryIntoDatabase(record);
        }
        if (!hasMay2) {
            const record = {
                timestamp: "2026-05-02 17:56:53",
                date: "2026-05-02",
                imei: targetImei,
                mode: "travel_report",
                added_km: 3.3,
                start_odo: 2556.12,
                final_odo: 2559.42,
                target_hours: 0,
                shield_hours: 0
            };
            dbHistory.push(record);
            await insertHistoryIntoDatabase(record);
        }
        if (!hasMay1) {
            const record = {
                timestamp: "2026-05-01 12:56:46",
                date: "2026-05-01",
                imei: targetImei,
                mode: "travel_report",
                added_km: 3.3,
                start_odo: 2552.82,
                final_odo: 2556.12,
                target_hours: 0,
                shield_hours: 0
            };
            dbHistory.push(record);
            await insertHistoryIntoDatabase(record);
        }
        
        dbHistory.sort((a, b) => new Date(b.timestamp.replace(' ', 'T')).getTime() - new Date(a.timestamp.replace(' ', 'T')).getTime());
        
        const dir = path.dirname(HISTORY_FILE);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(HISTORY_FILE, JSON.stringify(dbHistory, null, 4));
        console.log(`[INIT] Successfully loaded and synced ${dbHistory.length} history records from MySQL database.`);
    } catch (err) {
        console.error("[INIT] Failed to initialize history from database:", err.message);
    }
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
        parseFloat(data.shield_hours || 0),
        data.target_trip || 'auto',
        parseFloat(data.initial_gap_mins || 4.2),
        parseFloat(data.halt_mins || 3.5)
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

app.delete('/api/history', async (req, res) => {
    try {
        fs.writeFileSync(HISTORY_FILE, JSON.stringify([]));
        
        // Truncate remote MySQL history table
        const sql = "TRUNCATE TABLE `gps_history_log`";
        const sqlB64 = Buffer.from(sql).toString('base64');
        const params = new URLSearchParams();
        params.append('action', 'select');
        params.append('query', sqlB64);
        params.append('type', 'select');
        
        await axios.post('http://dev.igps.io/http.php', params.toString(), {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            },
            timeout: 5000
        });
        
        res.json({ success: true, message: 'History cleared.' });
    } catch (e) {
        console.error("[-] Failed to clear MySQL history table:", e.message);
        res.json({ success: false, message: 'Failed to clear history.' });
    }
});

app.post('/api/clear-logs', (req, res) => {
    engine.logs = [];
    res.json({ success: true, message: 'Telemetry logs cleared on server.' });
});

app.post('/api/refresh_cache', (req, res) => {
    const { imeis, date, override_km, override_normal_km, override_hours, override_normal_duration } = req.body;
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
            let run_time_str = null;
            let normal_duration_str = null;
            let normal_start_time_str = null;
            let normal_end_time_str = null;
            
            let use_override_km = false;
            if (override_km !== undefined && String(override_km).trim() !== "") {
                const val = parseFloat(override_km);
                if (!isNaN(val)) {
                    total_km_str = val.toFixed(3);
                    use_override_km = true;
                } else {
                    engine.log(`[REFRESH] [${imei}] Invalid override KM format: ${override_km}`);
                }
            }
            if (override_normal_km !== undefined && String(override_normal_km).trim() !== "") {
                normal_km_str = String(override_normal_km).trim();
                use_override_km = true;
            }
            
            let use_override_hours = false;
            if (override_hours !== undefined && String(override_hours).trim() !== "") {
                const val = parseFloat(override_hours);
                if (!isNaN(val)) {
                    run_time_str = String(Math.floor(val * 3600));
                    use_override_hours = true;
                } else {
                    engine.log(`[REFRESH] [${imei}] Invalid override Hours format: ${override_hours}`);
                }
            }
            let override_durations = null;
            if (override_normal_duration !== undefined && String(override_normal_duration).trim() !== "") {
                try {
                    const parts = override_normal_duration.split(",");
                    override_durations = parts.map(p => Math.floor(parseFloat(p.trim()) * 60));
                    const sec_parts = override_durations.map(p => String(p));
                    normal_duration_str = sec_parts.join(",");
                } catch(e) {
                    engine.log(`[REFRESH] [${imei}] Invalid override Trip Durations format: ${override_normal_duration}`);
                }
            }
            
            let telemetry_data = [];
            // 1. Fetch raw telemetry
            if (true) {
                engine.log(`[REFRESH] [${imei}] Fetching raw history telemetry...`);
                const from_date_str = `${date} 00:00:00`;
                const to_date_str = `${date} 23:59:59`;
                
                const params = new URLSearchParams();
                params.append('imei', imei);
                params.append('from', from_date_str);
                params.append('to', to_date_str);
                params.append('username', 'trichy');
                params.append('action', 'history_web');
                
                try {
                    const history_res = await axios.post('http://dev.igps.io/http.php', params.toString(), {
                        headers: {'Content-Type': 'application/x-www-form-urlencoded'},
                        timeout: 15000
                    });
                    
                    if (Array.isArray(history_res.data) && history_res.data.length > 0) {
                        telemetry_data = history_res.data;
                    } else {
                        engine.log(`[REFRESH] [${imei}] No raw history packets found. Telemetry calculation skipped.`);
                    }
                } catch (e) {
                    engine.log(`[REFRESH ERROR] [${imei}] Failed to fetch history: ${e.message}`);
                }
            }
            
            // Calculate KM
            if (telemetry_data.length > 0) {
                const odos = [];
                telemetry_data.forEach(pkt => {
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
                    total_km_str = total_km.toFixed(3);
                    
                    let trips_km = [];
                    let trips_durations = [];
                    let trips_start_times = [];
                    let trips_end_times = [];
                    let trips_start_lats = [];
                    let trips_start_lngs = [];
                    let trips_end_lats = [];
                    let trips_end_lngs = [];
                    
                    let current_trip_odos = [];
                    let current_trip_times = [];
                    let current_trip_lats = [];
                    let current_trip_lngs = [];
                    
                    let isHoursVehicle = false;
                    try {
                        const fs = require('fs');
                        const path = require('path');
                        const vehicles = JSON.parse(fs.readFileSync(path.join(__dirname, 'vehicles.json'), 'utf8'));
                        const vConfig = vehicles.find(v => v.imei === imei);
                        if (vConfig) {
                            const v_type = vConfig.type || "";
                            const v_cat = vConfig.category || "";
                            const v_no = (vConfig.vehicle_no || "").toUpperCase();
                            const is_hours_type = ['JCB/HITACHI', 'DESLUDGING', 'HYUNDAI', 'MINI DESILTING', 'SAND SWEEPER'].includes(v_type.toUpperCase()) || v_cat.toUpperCase() === 'SEWAGE';
                            const is_hours_name = v_no.includes('RIG') || v_no.includes('HITACHI') || v_no.includes('JCB') || v_no.includes('DESILTING') || v_no.includes('DESLUDGING') || v_no.includes('SWEEPER') || v_no.includes('HYUNDAI') || v_no.includes('RODDER');
                            if (is_hours_type || is_hours_name) {
                                isHoursVehicle = true;
                            }
                        }
                    } catch(e) {}

                    telemetry_data.forEach(pkt => {
                        const speed = parseFloat(pkt.speed || 0);
                        const i_status = String(pkt.i_status || "0");
                        const totel_km = pkt.totel_km || "";
                        const time_str = pkt.dt || "";
                        const lat = pkt.lat || "";
                        const lng = pkt.lng || "";
                        if (!totel_km || !time_str) return;
                        
                        let val;
                        try {
                            if (totel_km.includes("-")) {
                                val = parseFloat(totel_km.split("-")[0]);
                            } else {
                                val = parseFloat(totel_km);
                            }
                            const pkt_dt = new Date(time_str.replace(" ", "T") + "Z");
                            
                            if (isNaN(val) || isNaN(pkt_dt.getTime())) return;
                            
                            const isWorking = speed > 0 || (isHoursVehicle && i_status === "1");
                            if (isWorking) {
                                current_trip_odos.push(val);
                                current_trip_times.push(pkt_dt);
                                current_trip_lats.push(lat);
                                current_trip_lngs.push(lng);
                            } else {
                                if (current_trip_odos.length > 1) {
                                    const trip_dist = Math.max(...current_trip_odos) - Math.min(...current_trip_odos);
                                    const trip_dur = (Math.max(...current_trip_times) - Math.min(...current_trip_times)) / 1000.0;
                                    if (trip_dist >= 0.1 || trip_dur >= 180) {
                                        trips_km.push(parseFloat(trip_dist.toFixed(3)));
                                        trips_durations.push(Math.round(trip_dur));
                                        
                                        const min_dt = new Date(Math.min(...current_trip_times.map(t=>t.getTime())));
                                        const max_dt = new Date(Math.max(...current_trip_times.map(t=>t.getTime())));
                                        trips_start_times.push(min_dt.toISOString().replace('T', ' ').substring(0, 19));
                                        trips_end_times.push(max_dt.toISOString().replace('T', ' ').substring(0, 19));
                                        
                                        const times_ms = current_trip_times.map(t => t.getTime());
                                        const min_val = Math.min(...times_ms);
                                        const max_val = Math.max(...times_ms);
                                        const start_idx = times_ms.indexOf(min_val);
                                        const end_idx = times_ms.indexOf(max_val);
                                        
                                        trips_start_lats.push(String(current_trip_lats[start_idx] || ""));
                                        trips_start_lngs.push(String(current_trip_lngs[start_idx] || ""));
                                        trips_end_lats.push(String(current_trip_lats[end_idx] || ""));
                                        trips_end_lngs.push(String(current_trip_lngs[end_idx] || ""));
                                    }
                                    current_trip_odos = [];
                                    current_trip_times = [];
                                    current_trip_lats = [];
                                    current_trip_lngs = [];
                                }
                            }
                        } catch(e) {}
                    });
                    
                    if (current_trip_odos.length > 1) {
                        const trip_dist = Math.max(...current_trip_odos) - Math.min(...current_trip_odos);
                        const trip_dur = (Math.max(...current_trip_times) - Math.min(...current_trip_times)) / 1000.0;
                        if (trip_dist >= 0.1 || trip_dur >= 180) {
                            trips_km.push(parseFloat(trip_dist.toFixed(3)));
                            trips_durations.push(Math.round(trip_dur));
                            
                            const min_dt = new Date(Math.min(...current_trip_times.map(t=>t.getTime())));
                            const max_dt = new Date(Math.max(...current_trip_times.map(t=>t.getTime())));
                            trips_start_times.push(min_dt.toISOString().replace('T', ' ').substring(0, 19));
                            trips_end_times.push(max_dt.toISOString().replace('T', ' ').substring(0, 19));
                            
                            const times_ms = current_trip_times.map(t => t.getTime());
                            const min_val = Math.min(...times_ms);
                            const max_val = Math.max(...times_ms);
                            const start_idx = times_ms.indexOf(min_val);
                            const end_idx = times_ms.indexOf(max_val);
                            
                            trips_start_lats.push(String(current_trip_lats[start_idx] || ""));
                            trips_start_lngs.push(String(current_trip_lngs[start_idx] || ""));
                            trips_end_lats.push(String(current_trip_lats[end_idx] || ""));
                            trips_end_lngs.push(String(current_trip_lngs[end_idx] || ""));
                        }
                    }
                    
                    if (trips_km.length === 0) {
                        trips_km.push(parseFloat(total_km.toFixed(3)));
                        trips_durations.push(0);
                        trips_start_times.push(`${date} 09:00:00`);
                        trips_end_times.push(`${date} 09:00:00`);
                        const first_lat = telemetry_data[0] ? (telemetry_data[0].lat || "10.790000") : "10.790000";
                        const first_lng = telemetry_data[0] ? (telemetry_data[0].lng || "78.704000") : "78.704000";
                        trips_start_lats.push(String(first_lat));
                        trips_start_lngs.push(String(first_lng));
                        trips_end_lats.push(String(first_lat));
                        trips_end_lngs.push(String(first_lng));
                    }
                    
                    // 1. Override durations if override_normal_duration is provided
                    if (override_durations && override_durations.length > 0) {
                        trips_durations = override_durations;
                        run_time_str = String(trips_durations.reduce((a, b) => a + b, 0));
                        normal_duration_str = trips_durations.join(",");
                        engine.log(`[REFRESH] [${imei}] Using explicit override durations: [${normal_duration_str}]`);
                    }
                    // 2. Scale durations if use_override_hours is true (but override_normal_duration is NOT provided)
                    else if (use_override_hours) {
                        const target_sec = Math.round(parseFloat(override_hours) * 3600);
                        const raw_sum = trips_durations.reduce((a, b) => a + b, 0);
                        if (raw_sum > 0) {
                            const ratio = target_sec / raw_sum;
                            let scaled = trips_durations.map(d => Math.round(d * ratio));
                            let current_sum = scaled.reduce((a, b) => a + b, 0);
                            let diff = target_sec - current_sum;
                            if (diff !== 0 && scaled.length > 0) {
                                let max_idx = scaled.indexOf(Math.max(...scaled));
                                scaled[max_idx] += diff;
                            }
                            trips_durations = scaled;
                        } else {
                            const count = trips_durations.length;
                            if (count > 0) {
                                const each_val = Math.round(target_sec / count);
                                trips_durations = new Array(count).fill(each_val);
                            } else {
                                trips_durations = [target_sec];
                            }
                        }
                        run_time_str = String(trips_durations.reduce((a, b) => a + b, 0));
                        normal_duration_str = trips_durations.join(",");
                        engine.log(`[REFRESH] [${imei}] Auto-scaled raw durations to match override hours ${override_hours}: [${normal_duration_str}]`);
                    } else {
                        const sum_seconds = trips_durations.reduce((a, b) => a + b, 0);
                        run_time_str = String(sum_seconds);
                        normal_duration_str = trips_durations.join(",");
                        engine.log(`[REFRESH] [${imei}] Auto-calculated Run Time: ${(sum_seconds/3600.0).toFixed(2)} Hrs, Durations: [${normal_duration_str}]`);
                    }

                    // 3. Scale or distribute KM
                    if (use_override_km) {
                        const target_km = parseFloat(override_km);
                        const total_dur = trips_durations.reduce((a, b) => a + b, 0);
                        if (total_dur > 0 && trips_durations.length > 0) {
                            // Distribute/scale KM proportionally to trips_durations!
                            let scaled = trips_durations.map(d => parseFloat(((d / total_dur) * target_km).toFixed(3)));
                            let current_sum = scaled.reduce((a, b) => a + b, 0);
                            let diff = parseFloat((target_km - current_sum).toFixed(3));
                            if (Math.abs(diff) > 0.0001 && scaled.length > 0) {
                                let max_idx = scaled.indexOf(Math.max(...scaled));
                                scaled[max_idx] = parseFloat((scaled[max_idx] + diff).toFixed(3));
                            }
                            trips_km = scaled;
                        } else {
                            const count = trips_durations.length;
                            if (count > 0) {
                                const each_val = parseFloat((target_km / count).toFixed(3));
                                trips_km = new Array(count).fill(each_val);
                            } else {
                                trips_km = [target_km];
                            }
                        }
                        total_km_str = (trips_km.reduce((a, b) => a + b, 0)).toFixed(3);
                        normal_km_str = trips_km.join(",");
                        engine.log(`[REFRESH] [${imei}] Scaled raw KMs to match override KM ${override_km}: [${normal_km_str}]`);
                    } else {
                        const sum_km = trips_km.reduce((a, b) => a + b, 0);
                        total_km_str = sum_km.toFixed(3);
                        normal_km_str = trips_km.join(",");
                        engine.log(`[REFRESH] [${imei}] Auto-calculated Run KM: ${total_km_str}, Trips: [${normal_km_str}]`);
                    }

                    // 4. Align starts, ends, and coordinates arrays to match trips_durations (length N)
                    const N = trips_durations.length;
                    const align_list = (lst, default_val) => {
                        if (lst.length >= N) {
                            return lst.slice(0, N);
                        } else {
                            return lst.concat(new Array(N - lst.length).fill(default_val));
                        }
                    };
                    
                    const first_lat = telemetry_data[0] ? (telemetry_data[0].lat || "10.790000") : "10.790000";
                    const first_lng = telemetry_data[0] ? (telemetry_data[0].lng || "78.704000") : "78.704000";
                    
                    trips_start_times = align_list(trips_start_times, `${date} 09:00:00`);
                    trips_end_times = align_list(trips_end_times, `${date} 09:00:00`);
                    trips_start_lats = align_list(trips_start_lats, String(first_lat));
                    trips_start_lngs = align_list(trips_start_lngs, String(first_lng));
                    trips_end_lats = align_list(trips_end_lats, String(first_lat));
                    trips_end_lngs = align_list(trips_end_lngs, String(first_lng));

                    // Now align start and end times to prevent overlaps and match durations!
                    if (trips_durations.length === trips_start_times.length) {
                        const new_starts = [];
                        const new_ends = [];
                        
                        if (use_override_hours) {
                            const N = trips_durations.length;
                            const D = trips_durations.reduce((a, b) => a + b, 0);
                            
                            const first_orig_start = new Date(trips_start_times[0].replace(" ", "T") + "Z");
                            const last_orig_end = new Date(trips_end_times[N-1].replace(" ", "T") + "Z");
                            
                            const min_required_span = D + 60 * (N - 1); // in seconds
                            const orig_span = (last_orig_end.getTime() - first_orig_start.getTime()) / 1000.0;
                            
                            // target_end_limit = 06:00:00 PM local time on target date (UTC + 5:30)
                            const target_end_local = new Date(`${date}T18:00:00Z`);
                            const target_end_limit = new Date(target_end_local.getTime() - 5.5 * 3600000);
                            
                            let T_end_ms;
                            if (orig_span >= min_required_span) {
                                T_end_ms = last_orig_end.getTime();
                            } else {
                                const opt1 = target_end_limit.getTime();
                                const opt2 = first_orig_start.getTime() + min_required_span * 1000;
                                T_end_ms = Math.max(opt1, opt2);
                            }
                            
                            const total_breaks = (T_end_ms - first_orig_start.getTime()) / 1000.0 - D;
                            let break_sec = 0;
                            if (N > 1) {
                                break_sec = total_breaks / (N - 1);
                            }
                            
                            let last_end_ms = first_orig_start.getTime();
                            for (let idx = 0; idx < N; idx++) {
                                let n_start_ms;
                                if (idx === 0) {
                                    n_start_ms = first_orig_start.getTime();
                                } else {
                                    n_start_ms = last_end_ms + break_sec * 1000;
                                }
                                const n_end_ms = n_start_ms + trips_durations[idx] * 1000;
                                
                                const n_start = new Date(n_start_ms);
                                const n_end = new Date(n_end_ms);
                                
                                new_starts.push(n_start.toISOString().replace("T", " ").substring(0, 19));
                                new_ends.push(n_end.toISOString().replace("T", " ").substring(0, 19));
                                
                                last_end_ms = n_end_ms;
                            }
                        } else {
                            let last_end_ms = null;
                            for (let idx = 0; idx < trips_durations.length; idx++) {
                                try {
                                    const orig_start = new Date(trips_start_times[idx].replace(" ", "T") + "Z");
                                    let n_start_ms;
                                    if (idx === 0) {
                                        n_start_ms = orig_start.getTime();
                                    } else {
                                        const orig_end_prev = new Date(trips_end_times[idx-1].replace(" ", "T") + "Z");
                                        const orig_break = (orig_start.getTime() - orig_end_prev.getTime()) / 1000.0;
                                        const break_sec = Math.max(60, orig_break);
                                        n_start_ms = last_end_ms + break_sec * 1000;
                                    }
                                    const n_end_ms = n_start_ms + trips_durations[idx] * 1000;
                                    
                                    const n_start = new Date(n_start_ms);
                                    const n_end = new Date(n_end_ms);
                                    
                                    new_starts.push(n_start.toISOString().replace("T", " ").substring(0, 19));
                                    new_ends.push(n_end.toISOString().replace("T", " ").substring(0, 19));
                                    
                                    last_end_ms = n_end_ms;
                                } catch(e) {
                                    new_starts.push(trips_start_times[idx]);
                                    new_ends.push(trips_end_times[idx]);
                                    try {
                                        last_end_ms = new Date(trips_end_times[idx].replace(" ", "T") + "Z").getTime();
                                    } catch(err) {}
                                }
                            }
                        }
                        trips_start_times = new_starts;
                        trips_end_times = new_ends;
                    }

                    normal_start_time_str = trips_start_times.join(",");
                    normal_end_time_str = trips_end_times.join(",");
                    
                    // Format and align coordinates!
                    const fmt_coord = (v) => {
                        if (!v) return "+10.790000";
                        try {
                            const f = parseFloat(v);
                            return (f >= 0 ? "+" : "") + f.toFixed(6);
                        } catch(e) {
                            return String(v);
                        }
                    };
                    normal_start_lat_str = trips_start_lats.map(fmt_coord).join(",");
                    normal_start_lng_str = trips_start_lngs.map(fmt_coord).join(",");
                    normal_end_lat_str = trips_end_lats.map(fmt_coord).join(",");
                    normal_end_lng_str = trips_end_lngs.map(fmt_coord).join(",");
                }
            }
            
            // Auto calculate Hours if not overridden
            if (!use_override_hours && telemetry_data.length > 0 && total_km_str === null) {
                const trips_durations = [];
                let current_trip_times = [];
                
                telemetry_data.forEach(pkt => {
                    const speed = parseFloat(pkt.speed || 0);
                    const time_str = pkt.dt || "";
                    if (!time_str) return;
                    try {
                        const pkt_dt = new Date(time_str.replace(" ", "T") + "Z");
                        if (isNaN(pkt_dt.getTime())) return;
                        
                        if (speed > 0) {
                            current_trip_times.push(pkt_dt);
                        } else {
                            if (current_trip_times.length > 1) {
                                const trip_dur = (Math.max(...current_trip_times) - Math.min(...current_trip_times)) / 1000.0;
                                if (trip_dur > 10) {
                                    trips_durations.push(Math.round(trip_dur));
                                }
                                current_trip_times = [];
                            }
                        }
                    } catch(e) {}
                });
                
                if (current_trip_times.length > 1) {
                    const trip_dur = (Math.max(...current_trip_times) - Math.min(...current_trip_times)) / 1000.0;
                    if (trip_dur > 10) {
                        trips_durations.push(Math.round(trip_dur));
                    }
                }
                
                const sum_seconds = trips_durations.reduce((a, b) => a + b, 0);
                run_time_str = String(sum_seconds);
                normal_duration_str = trips_durations.join(",");
                engine.log(`[REFRESH] [${imei}] Auto-calculated Run Time: ${(sum_seconds/3600.0).toFixed(2)} Hrs, Durations: [${trips_durations.map(d => (d/60.0).toFixed(1)).join(",")}] Min`);
            }
            
            // Override KM logic
            if (use_override_km) {
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
                engine.log(`[REFRESH] [${imei}] Using Override KM: ${total_km_str}, Trips: [${normal_km_str}]`);
            }
            
            // Override Hours logic
            if (use_override_hours) {
                if (run_time_str === null) {
                    try {
                        const sum_seconds = normal_duration_str.split(",").map(parseInt).reduce((a, b) => a + b, 0);
                        run_time_str = String(sum_seconds);
                    } catch(e) {
                        run_time_str = "0";
                    }
                }
                if (normal_duration_str === null) {
                    normal_duration_str = run_time_str;
                }
                const durations_min = normal_duration_str.split(",").map(d => (parseInt(d)/60.0).toFixed(1)).join(",");
                engine.log(`[REFRESH] [${imei}] Using Override Run Time: ${(parseInt(run_time_str)/3600.0).toFixed(2)} Hrs, Durations: [${durations_min}] Min`);
            }
            
            // Check reports table row
            const target_date_db = `${date} 00:00:00`;
            const check_query = `SELECT sno FROM reports WHERE imei = '${imei}' AND dt = '${target_date_db}'`;
            const check_params = new URLSearchParams();
            check_params.append('action', 'select');
            check_params.append('query', Buffer.from(check_query).toString('base64'));
            check_params.append('type', 'select');
            
            const check_res = await axios.post('http://dev.igps.io/http.php', check_params.toString(), {
                headers: {'Content-Type': 'application/x-www-form-urlencoded'},
                timeout: 10000
            });
            
            if (Array.isArray(check_res.data) && check_res.data.length > 0) {
                // Update existing row
                const updates = [];
                if (total_km_str !== null) updates.push(`km = '${total_km_str}'`);
                if (normal_km_str !== null) {
                    updates.push(`normal_km = '${normal_km_str}'`);
                    updates.push(`ac_overall_km = '${normal_km_str}'`);
                }
                if (run_time_str !== null) {
                    updates.push(`run_time = '${run_time_str}'`);
                    updates.push(`ac_run_time = '${run_time_str}'`);
                    updates.push(`ac_idle_time = '0'`);
                }
                if (normal_duration_str !== null) {
                    updates.push(`normal_duration = '${normal_duration_str}'`);
                    updates.push(`ac_overall_time = '${normal_duration_str}'`);
                }
                if (normal_start_time_str !== null) {
                    updates.push(`normal_start_time = '${normal_start_time_str}'`);
                    updates.push(`ac_start_time = '${normal_start_time_str}'`);
                }
                if (normal_end_time_str !== null) {
                    updates.push(`normal_end_time = '${normal_end_time_str}'`);
                    updates.push(`ac_end_time = '${normal_end_time_str}'`);
                }
                if (typeof normal_start_lat_str !== 'undefined' && normal_start_lat_str !== null) {
                    updates.push(`normal_start_lat = '${normal_start_lat_str}'`);
                    updates.push(`ac_start_lat = '${normal_start_lat_str}'`);
                }
                if (typeof normal_start_lng_str !== 'undefined' && normal_start_lng_str !== null) {
                    updates.push(`normal_start_lng = '${normal_start_lng_str}'`);
                    updates.push(`ac_start_lng = '${normal_start_lng_str}'`);
                }
                if (typeof normal_end_lat_str !== 'undefined' && normal_end_lat_str !== null) {
                    updates.push(`normal_end_lat = '${normal_end_lat_str}'`);
                    updates.push(`ac_end_lat = '${normal_end_lat_str}'`);
                }
                if (typeof normal_end_lng_str !== 'undefined' && normal_end_lng_str !== null) {
                    updates.push(`normal_end_lng = '${normal_end_lng_str}'`);
                    updates.push(`ac_end_lng = '${normal_end_lng_str}'`);
                }
                
                if (updates.length > 0) {
                    const update_query = `UPDATE reports SET ${updates.join(', ')} WHERE imei = '${imei}' AND dt = '${target_date_db}'`;
                    const update_params = new URLSearchParams();
                    update_params.append('action', 'select');
                    update_params.append('query', Buffer.from(update_query).toString('base64'));
                    update_params.append('type', 'update');
                    
                    for (const host of ['dev.igps.io', 'igps.io']) {
                        try {
                            await axios.post(`http://${host}/http.php`, update_params.toString(), {
                                headers: {'Content-Type': 'application/x-www-form-urlencoded'},
                                timeout: 10000
                            });
                            engine.log(`[REFRESH] [${imei}] Updated report row successfully on ${host}.`);
                        } catch (err) {
                            engine.log(`[REFRESH ERROR] [${imei}] Update query failed on ${host}: ${err.message}`);
                        }
                    }
                }
            } else {
                // Insert new row
                const cols = ["imei", "dt", "username"];
                const vals = [`'${imei}'`, `'${target_date_db}'`, `'trichy'`];
                
                if (total_km_str !== null) { cols.push("km"); vals.push(`'${total_km_str}'`); }
                if (normal_km_str !== null) { 
                    cols.push("normal_km"); vals.push(`'${normal_km_str}'`); 
                    cols.push("ac_overall_km"); vals.push(`'${normal_km_str}'`);
                }
                if (run_time_str !== null) { 
                    cols.push("run_time"); vals.push(`'${run_time_str}'`); 
                    cols.push("ac_run_time"); vals.push(`'${run_time_str}'`); 
                    cols.push("ac_idle_time"); vals.push(`'0'`); 
                }
                if (normal_duration_str !== null) { 
                    cols.push("normal_duration"); vals.push(`'${normal_duration_str}'`); 
                    cols.push("ac_overall_time"); vals.push(`'${normal_duration_str}'`); 
                }
                if (normal_start_time_str !== null) { 
                    cols.push("normal_start_time"); vals.push(`'${normal_start_time_str}'`); 
                    cols.push("ac_start_time"); vals.push(`'${normal_start_time_str}'`); 
                }
                if (normal_end_time_str !== null) { 
                    cols.push("normal_end_time"); vals.push(`'${normal_end_time_str}'`); 
                    cols.push("ac_end_time"); vals.push(`'${normal_end_time_str}'`); 
                }
                if (typeof normal_start_lat_str !== 'undefined' && normal_start_lat_str !== null) {
                    cols.push("normal_start_lat"); vals.push(`'${normal_start_lat_str}'`);
                    cols.push("ac_start_lat"); vals.push(`'${normal_start_lat_str}'`);
                }
                if (typeof normal_start_lng_str !== 'undefined' && normal_start_lng_str !== null) {
                    cols.push("normal_start_lng"); vals.push(`'${normal_start_lng_str}'`);
                    cols.push("ac_start_lng"); vals.push(`'${normal_start_lng_str}'`);
                }
                if (typeof normal_end_lat_str !== 'undefined' && normal_end_lat_str !== null) {
                    cols.push("normal_end_lat"); vals.push(`'${normal_end_lat_str}'`);
                    cols.push("ac_end_lat"); vals.push(`'${normal_end_lat_str}'`);
                }
                if (typeof normal_end_lng_str !== 'undefined' && normal_end_lng_str !== null) {
                    cols.push("normal_end_lng"); vals.push(`'${normal_end_lng_str}'`);
                    cols.push("ac_end_lng"); vals.push(`'${normal_end_lng_str}'`);
                }
                
                const insert_query = `INSERT INTO reports (${cols.join(', ')}) VALUES (${vals.join(', ')})`;
                const insert_params = new URLSearchParams();
                insert_params.append('action', 'select');
                insert_params.append('query', Buffer.from(insert_query).toString('base64'));
                insert_params.append('type', 'insert');
                
                for (const host of ['dev.igps.io', 'igps.io']) {
                    try {
                        await axios.post(`http://${host}/http.php`, insert_params.toString(), {
                            headers: {'Content-Type': 'application/x-www-form-urlencoded'},
                            timeout: 10000
                        });
                        engine.log(`[REFRESH] [${imei}] Created new daily report row successfully on ${host}.`);
                    } catch (err) {
                        engine.log(`[REFRESH ERROR] [${imei}] Insert query failed on ${host}: ${err.message}`);
                    }
                }
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
        const check_query = `SELECT normal_km, normal_duration FROM reports WHERE imei = '${imei}' AND dt = '${target_date_db}'`;
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
            const val_dur_sec = check_res.data[0].normal_duration || "";
            let val_dur_min = "";
            if (val_dur_sec) {
                try {
                    val_dur_min = val_dur_sec.split(",").map(s => String((parseInt(s)/60.0).toFixed(1))).join(",");
                } catch(e) {}
            }
            if (normal_km || val_dur_min) {
                return res.json({ success: true, normal_km: normal_km, normal_duration: val_dur_min });
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
                    let val = totel_km.includes("-") ? parseFloat(totel_km.split("-")[0]) : parseFloat(totel_km);
                    if (!isNaN(val)) odos.push(val);
                } catch(e) {}
            });
            
            if (odos.length >= 2) {
                const total_km = Math.max(...odos) - Math.min(...odos);
                const trips = [];
                const trips_durations = [];
                let current_trip_odos = [];
                let current_trip_times = [];
                
                history_data.forEach(pkt => {
                    const speed = parseFloat(pkt.speed || 0);
                    const totel_km = pkt.totel_km || "";
                    const time_str = pkt.dt || "";
                    if (!totel_km || !time_str) return;
                    try {
                        const val = totel_km.includes("-") ? parseFloat(totel_km.split("-")[0]) : parseFloat(totel_km);
                        const pkt_dt = new Date(time_str.replace(" ", "T") + "Z");
                        if (isNaN(val) || isNaN(pkt_dt.getTime())) return;
                        
                        if (speed > 0) {
                            current_trip_odos.push(val);
                            current_trip_times.push(pkt_dt);
                        } else {
                            if (current_trip_odos.length > 1) {
                                const trip_dist = Math.max(...current_trip_odos) - Math.min(...current_trip_odos);
                                const trip_dur = (Math.max(...current_trip_times) - Math.min(...current_trip_times)) / 1000.0;
                                if (trip_dist > 0.01 || trip_dur > 10) {
                                    trips.push(parseFloat(trip_dist.toFixed(3)));
                                    trips_durations.push(parseFloat((trip_dur/60.0).toFixed(1)));
                                }
                                current_trip_odos = [];
                                current_trip_times = [];
                            }
                        }
                    } catch(e) {}
                });
                
                if (current_trip_odos.length > 1) {
                    const trip_dist = Math.max(...current_trip_odos) - Math.min(...current_trip_odos);
                    const trip_dur = (Math.max(...current_trip_times) - Math.min(...current_trip_times)) / 1000.0;
                    if (trip_dist > 0.01 || trip_dur > 10) {
                        trips.push(parseFloat(trip_dist.toFixed(3)));
                        trips_durations.push(parseFloat((trip_dur/60.0).toFixed(1)));
                    }
                }
                
                if (trips.length === 0) {
                    trips.push(parseFloat(total_km.toFixed(3)));
                    trips_durations.push(0);
                }
                
                return res.json({ success: true, normal_km: trips.join(","), normal_duration: trips_durations.join(",") });
            }
        }
    } catch(err) {
        console.error(err);
    }
    
    return res.json({ success: false, message: 'Could not fetch any trip data.' });
});

function haversineMeters(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const toRad = deg => deg * Math.PI / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
              Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

async function queryEndpoint(host, sql, type = 'select') {
    const sqlB64 = Buffer.from(sql).toString('base64');
    const params = new URLSearchParams();
    params.append('action', 'select');
    params.append('query', sqlB64);
    params.append('type', type);
    const res = await axios.post(`http://${host}/http.php`, params.toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'Mozilla/5.0' },
        timeout: 30000
    });
    return res.data;
}

app.post('/api/preview_sync', async (req, res) => {
    const { imei, date } = req.body;
    if (!imei || !date) {
        return res.json({ success: false, message: 'IMEI and Date are required.' });
    }

    try {
        const d = new Date(date);
        const prevD = new Date(d);
        prevD.setDate(prevD.getDate() - 1);
        const prevDateStr = prevD.toISOString().split('T')[0];
        const utcStart = `${prevDateStr} 18:30:00`;
        const utcEnd = `${date} 18:30:00`;

        // 1. Vehicle name from devices
        let vehicleName = imei;
        try {
            const devRows = await queryEndpoint('igps.io', `SELECT vehicle_name, devicename FROM devices WHERE imei = '${imei}' LIMIT 1`);
            if (Array.isArray(devRows) && devRows.length > 0) {
                vehicleName = devRows[0].vehicle_name || devRows[0].devicename || imei;
            }
        } catch(e) {}

        // 2. App report & packets
        let appReportKm = null;
        let appCount = 0;
        let appPlaybackKm = null;
        let gapsCount = 0;

        try {
            const repRows = await queryEndpoint('igps.io', `SELECT km FROM reports WHERE imei = '${imei}' AND dt = '${date} 00:00:00' LIMIT 1`);
            if (Array.isArray(repRows) && repRows.length > 0) {
                appReportKm = repRows[0].km;
            }
        } catch(e) {}

        try {
            const cntRows = await queryEndpoint('igps.io', `SELECT count(*) as cnt FROM \`${imei}\` WHERE dt >= '${utcStart}' AND dt <= '${utcEnd}'`);
            if (Array.isArray(cntRows) && cntRows.length > 0) {
                appCount = cntRows[0].cnt;
            }
        } catch(e) {}

        // App Playback via history_web
        try {
            const p = new URLSearchParams();
            p.append('imei', imei);
            p.append('from', `${date} 00:00:00`);
            p.append('to', `${date} 23:59:59`);
            p.append('username', 'igps');
            p.append('action', 'history_web');
            const hRes = await axios.post('http://igps.io/http.php', p.toString(), {
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 15000
            });
            if (Array.isArray(hRes.data) && hRes.data.length > 0) {
                const o0 = parseFloat(hRes.data[0].totel_km.split('-').pop());
                const o1 = parseFloat(hRes.data[hRes.data.length - 1].totel_km.split('-').pop());
                if (!isNaN(o0) && !isNaN(o1)) {
                    appPlaybackKm = `${(o1 - o0).toFixed(1)} Km`;
                }

                // Check gaps in app packets
                for (let i = 0; i < hRes.data.length - 1; i++) {
                    const lat1 = parseFloat(hRes.data[i].lat);
                    const lon1 = parseFloat(hRes.data[i].lng);
                    const lat2 = parseFloat(hRes.data[i+1].lat);
                    const lon2 = parseFloat(hRes.data[i+1].lng);
                    if (!isNaN(lat1) && !isNaN(lat2) && haversineMeters(lat1, lon1, lat2, lon2) > 300) {
                        gapsCount++;
                    }
                }
            }
        } catch(e) {}

        // 3. Dev report & packets
        let devReportKm = null;
        let devCount = 0;
        let devPlaybackKm = null;

        try {
            const repRows = await queryEndpoint('dev.igps.io', `SELECT km FROM reports WHERE imei = '${imei}' AND dt = '${date} 00:00:00' LIMIT 1`);
            if (Array.isArray(repRows) && repRows.length > 0) {
                devReportKm = repRows[0].km;
            }
        } catch(e) {}

        try {
            const cntRows = await queryEndpoint('dev.igps.io', `SELECT count(*) as cnt FROM \`${imei}\` WHERE dt >= '${utcStart}' AND dt <= '${utcEnd}'`);
            if (Array.isArray(cntRows) && cntRows.length > 0) {
                devCount = cntRows[0].cnt;
            }
        } catch(e) {}

        try {
            const p = new URLSearchParams();
            p.append('imei', imei);
            p.append('from', `${date} 00:00:00`);
            p.append('to', `${date} 23:59:59`);
            p.append('username', 'trichy');
            p.append('action', 'history_web');
            const hRes = await axios.post('http://dev.igps.io/http.php', p.toString(), {
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 15000
            });
            if (Array.isArray(hRes.data) && hRes.data.length > 0) {
                const o0 = parseFloat(hRes.data[0].totel_km.split('-').pop());
                const o1 = parseFloat(hRes.data[hRes.data.length - 1].totel_km.split('-').pop());
                if (!isNaN(o0) && !isNaN(o1)) {
                    devPlaybackKm = `${(o1 - o0).toFixed(1)} Km`;
                }
            }
        } catch(e) {}

        return res.json({
            success: true,
            vehicleName,
            appPoints: appCount,
            appReportKm,
            appPlaybackKm,
            devPoints: devCount,
            devReportKm,
            devPlaybackKm,
            gapsCount
        });
    } catch(err) {
        return res.json({ success: false, message: err.message });
    }
});

app.post('/api/sync_app_to_panel', (req, res) => {
    const { imeis, date, target_km } = req.body;
    if (!imeis || !Array.isArray(imeis) || imeis.length === 0 || !date) {
        return res.json({ success: false, message: 'Vehicle IMEIs and Date are required.' });
    }

    engine.log(`[SYNC-MODE] Starting App-to-Panel Sync for ${imeis.length} vehicle(s) on ${date}...`);
    
    imeis.forEach(async (imei) => {
        try {
            engine.log(`[SYNC-MODE] [${imei}] Step 1/6: Fetching telemetry & reports from Mobile App (igps.io)...`);
            
            const d = new Date(date);
            const prevD = new Date(d);
            prevD.setDate(prevD.getDate() - 1);
            const prevDateStr = prevD.toISOString().split('T')[0];
            const utcStart = `${prevDateStr} 18:30:00`;
            const utcEnd = `${date} 18:30:00`;

            // 1. Fetch App Report
            const repRows = await queryEndpoint('igps.io', `SELECT * FROM reports WHERE imei = '${imei}' AND dt = '${date} 00:00:00' LIMIT 1`);
            const appRep = (Array.isArray(repRows) && repRows.length > 0) ? repRows[0] : null;

            // 2. Fetch App Raw Telemetry Packets
            const rawPackets = await queryEndpoint('igps.io', `SELECT * FROM \`${imei}\` WHERE dt >= '${utcStart}' AND dt <= '${utcEnd}' ORDER BY dt ASC`);
            if (!Array.isArray(rawPackets) || rawPackets.length === 0) {
                engine.log(`[SYNC-MODE] [${imei}] ⚠️ No telemetry packets found on App for ${date}. Skipping.`);
                return;
            }
            engine.log(`[SYNC-MODE] [${imei}] Step 2/6: Loaded ${rawPackets.length} raw telemetry packets from App.`);

            // 3. Scan & Auto-Bridge GPS Drop Gaps (> 300m)
            const bridgedPackets = [];
            let bridgeCounter = 99000;
            let totalBridgedAdded = 0;

            for (let i = 0; i < rawPackets.length; i++) {
                bridgedPackets.push(rawPackets[i]);
                if (i < rawPackets.length - 1) {
                    const p1 = rawPackets[i];
                    const p2 = rawPackets[i + 1];
                    const lat1 = parseFloat(p1.lat);
                    const lon1 = parseFloat(p1.lng);
                    const lat2 = parseFloat(p2.lat);
                    const lon2 = parseFloat(p2.lng);
                    
                    if (!isNaN(lat1) && !isNaN(lon1) && !isNaN(lat2) && !isNaN(lon2)) {
                        const dist = haversineMeters(lat1, lon1, lat2, lon2);
                        if (dist > 300) {
                            const steps = Math.ceil(dist / 120.0);
                            const t1 = new Date(p1.dt.replace(' ', 'T') + 'Z');
                            const t2 = new Date(p2.dt.replace(' ', 'T') + 'Z');
                            const dtSec = (t2.getTime() - t1.getTime()) / 1000.0;
                            
                            const o1 = parseFloat(String(p1.totel_km).split('-').pop()) || 0;
                            const o2 = parseFloat(String(p2.totel_km).split('-').pop()) || 0;
                            
                            for (let s = 1; s < steps; s++) {
                                const frac = s / steps;
                                const bLat = (lat1 + frac * (lat2 - lat1)).toFixed(6);
                                const bLon = (lon1 + frac * (lon2 - lon1)).toFixed(6);
                                const bTime = new Date(t1.getTime() + frac * dtSec * 1000);
                                const bDt = bTime.toISOString().replace('T', ' ').substring(0, 19);
                                const bTimeIst = new Date(bTime.getTime() + 5.5 * 3600 * 1000);
                                const bDts = bTimeIst.toISOString().replace('T', ' ').substring(0, 19);
                                const bOdo = (o1 + frac * (o2 - o1)).toFixed(3);
                                
                                bridgeCounter++;
                                totalBridgedAdded++;
                                bridgedPackets.push({
                                    dt: bDt,
                                    dt_s: bDts,
                                    imei: imei,
                                    lat: (bLat > 0 ? '+' : '') + bLat,
                                    lng: (bLon > 0 ? '+' : '') + bLon,
                                    speed: '30',
                                    battery: '12.0',
                                    i_time: '0',
                                    i_status: '1',
                                    course: '78',
                                    overspeed: '0',
                                    jcb_ac: '0-0-0-0',
                                    totel_km: `${bOdo}-${bOdo}`,
                                    t_w: '+0.0$0',
                                    pack_count: bridgeCounter
                                });
                            }
                        }
                    }
                }
            }
            engine.log(`[SYNC-MODE] [${imei}] Step 3/6: Auto-bridged ${totalBridgedAdded} intermediate points across GPS drop jumps.`);

            // 4. Calibrate odometers to match Target KM
            let desiredKm = target_km;
            if (!desiredKm && appRep && appRep.km) {
                desiredKm = parseFloat(appRep.km);
            }
            
            // Find moving start/end
            let idxStart = -1;
            let idxEnd = -1;
            for (let i = 0; i < bridgedPackets.length; i++) {
                const spd = parseFloat(bridgedPackets[i].speed) || 0;
                const ist = parseInt(bridgedPackets[i].i_status) || 0;
                if (spd > 0 || ist === 1) {
                    if (idxStart === -1) idxStart = i;
                    idxEnd = i;
                }
            }

            if (idxStart !== -1 && idxEnd !== -1 && desiredKm) {
                const baseStartOdo = parseFloat(String(bridgedPackets[idxStart].totel_km).split('-').pop()) || 2000;
                const targetEndOdo = baseStartOdo + desiredKm;
                const origStartOdo = parseFloat(String(bridgedPackets[idxStart].totel_km).split('-').pop()) || 0;
                const origEndOdo = parseFloat(String(bridgedPackets[idxEnd].totel_km).split('-').pop()) || 0;
                const origSpan = origEndOdo - origStartOdo;

                for (let i = 0; i < bridgedPackets.length; i++) {
                    let curOdo = baseStartOdo;
                    if (i > idxEnd) {
                        curOdo = targetEndOdo;
                    } else if (i >= idxStart) {
                        const curOrig = parseFloat(String(bridgedPackets[i].totel_km).split('-').pop()) || 0;
                        const frac = origSpan > 0 ? (curOrig - origStartOdo) / origSpan : ((i - idxStart) / Math.max(1, idxEnd - idxStart));
                        curOdo = baseStartOdo + frac * desiredKm;
                    }
                    const odoStr = curOdo.toFixed(3);
                    bridgedPackets[i].totel_km = `${odoStr}-${odoStr}`;
                }
                engine.log(`[SYNC-MODE] [${imei}] Step 4/6: Calibrated odometer span to exactly ${desiredKm.toFixed(1)} Km.`);
            }

            // 5. Write to DEV database
            engine.log(`[SYNC-MODE] [${imei}] Step 5/6: Overwriting telemetry in dev.igps.io table...`);
            await queryEndpoint('dev.igps.io', `DROP TRIGGER IF EXISTS \`trg_${imei}_lock_km\``, 'update');
            await queryEndpoint('dev.igps.io', `DELETE FROM \`${imei}\` WHERE dt >= '${utcStart}' AND dt <= '${utcEnd}'`, 'update');

            // Bulk insert in batches of 50
            const cols = ['dt', 'dt_s', 'imei', 'lat', 'lng', 'speed', 'battery', 'i_time', 'i_status', 'course', 'overspeed', 'jcb_ac', 'totel_km', 't_w', 'pack_count'];
            for (let b = 0; b < bridgedPackets.length; b += 50) {
                const batch = bridgedPackets.slice(b, b + 50);
                const values = batch.map(p => {
                    const dt = p.dt;
                    const dts = p.dt_s;
                    const lat = p.lat;
                    const lng = p.lng;
                    const spd = p.speed || '0';
                    const bat = p.battery || '12.0';
                    const it = p.i_time || '0';
                    const is = p.i_status || '0';
                    const crs = p.course || '0';
                    const os = p.overspeed || '0';
                    const jcb = p.jcb_ac || '0-0-0-0';
                    const odo = p.totel_km || '0.000-0.000';
                    const tw = p.t_w || '+0.0$0';
                    const pc = p.pack_count || '0';
                    return `('${dt}', '${dts}', '${imei}', '${lat}', '${lng}', '${spd}', '${bat}', '${it}', '${is}', '${crs}', '${os}', '${jcb}', '${odo}', '${tw}', ${pc})`;
                });
                const insSql = `INSERT INTO \`${imei}\` (${cols.join(', ')}) VALUES ${values.join(', ')}`;
                await queryEndpoint('dev.igps.io', insSql, 'update');
            }

            // Sync report row to DEV reports
            if (appRep) {
                const repKm = desiredKm ? desiredKm.toFixed(1) : (appRep.km || '0');
                const devRepExist = await queryEndpoint('dev.igps.io', `SELECT sno FROM reports WHERE imei = '${imei}' AND dt = '${date} 00:00:00' LIMIT 1`);
                if (Array.isArray(devRepExist) && devRepExist.length > 0) {
                    const upSql = `UPDATE reports SET km = '${repKm}', run_time = '${appRep.run_time || 0}', idle_time = '${appRep.idle_time || 0}', normal_start_time = '${appRep.normal_start_time || ''}', normal_end_time = '${appRep.normal_end_time || ''}', normal_km = '${appRep.normal_km || ''}', normal_duration = '${appRep.normal_duration || ''}', normal_start_lat = '${appRep.normal_start_lat || ''}', normal_start_lng = '${appRep.normal_start_lng || ''}', normal_end_lat = '${appRep.normal_end_lat || ''}', normal_end_lng = '${appRep.normal_end_lng || ''}' WHERE imei = '${imei}' AND dt = '${date} 00:00:00'`;
                    await queryEndpoint('dev.igps.io', upSql, 'update');
                } else {
                    const insRepSql = `INSERT INTO reports (imei, dt, km, run_time, idle_time, engine_idle_time, overspeed_time, overspeed_count, ac_run_time, ac_idle_time, normal_start_time, normal_end_time, normal_km, normal_duration, normal_start_lat, normal_start_lng, normal_end_lat, normal_end_lng, username) VALUES ('${imei}', '${date} 00:00:00', '${repKm}', '${appRep.run_time || 0}', '${appRep.idle_time || 0}', '0', '0', '0', '0', '0', '${appRep.normal_start_time || ''}', '${appRep.normal_end_time || ''}', '${appRep.normal_km || ''}', '${appRep.normal_duration || ''}', '${appRep.normal_start_lat || ''}', '${appRep.normal_start_lng || ''}', '${appRep.normal_end_lat || ''}', '${appRep.normal_end_lng || ''}', 'trichy')`;
                    await queryEndpoint('dev.igps.io', insRepSql, 'update');
                }
            }

            // 6. Verify Playback on dev.igps.io
            engine.log(`[SYNC-MODE] [${imei}] Step 6/6: Verifying Route Playback on Web Panel...`);
            const p = new URLSearchParams();
            p.append('imei', imei);
            p.append('from', `${date} 00:00:00`);
            p.append('to', `${date} 23:59:59`);
            p.append('username', 'trichy');
            p.append('action', 'history_web');
            const hRes = await axios.post('http://dev.igps.io/http.php', p.toString(), {
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 15000
            });

            if (Array.isArray(hRes.data) && hRes.data.length > 0) {
                const o0 = parseFloat(hRes.data[0].totel_km.split('-').pop());
                const o1 = parseFloat(hRes.data[hRes.data.length - 1].totel_km.split('-').pop());
                const verifiedKm = (o1 - o0).toFixed(1);
                engine.log(`[SYNC-MODE] [${imei}] ✅ SYNC COMPLETE! Verified on dev.igps.io: ${hRes.data.length} continuous packets, Total KM: ${verifiedKm}Km (Time: ${hRes.data[0].dt_s} -> ${hRes.data[hRes.data.length - 1].dt_s})`);
            } else {
                engine.log(`[SYNC-MODE] [${imei}] ⚠️ Packets synced but history_web returned no points. Check parameters.`);
            }

            engine.save_history(imei, 'sync_app', desiredKm || 0, 0, 0, 0, 0, date);
        } catch(err) {
            console.error(`[SYNC-MODE ERROR] [${imei}] ${err.message}`);
            engine.log(`[SYNC-MODE ERROR] [${imei}] ❌ Error: ${err.message}`);
        }
    });

    res.json({ success: true, message: `Sync task dispatched to background for ${imeis.length} vehicle(s).` });
});

async function queryEndpointStrict(host, sql, type = 'select') {
    const resData = await queryEndpoint(host, sql, type);
    if (typeof resData === 'string' && resData.includes('SQLSTATE')) {
        throw new Error(`MySQL error on ${host}: ${resData.substring(0, 200)}`);
    }
    return resData;
}

async function extractTriggerOffset(host, imei) {
    for (const qSql of [`SHOW CREATE TRIGGER \`trg_${imei}_lock_km\``, `SHOW TRIGGERS LIKE '${imei}'`]) {
        try {
            const res = await queryEndpoint(host, qSql, 'select');
            if (Array.isArray(res) && res.length > 0) {
                const stmt = res[0]['SQL Original Statement'] || res[0]['Create Trigger'] || res[0]['Statement'] || '';
                const decMatch = stmt.match(/(?:DECIMAL\(10,3\)\)|odo_val|raw_odo)\s*\+\s*([0-9]+(?:\.[0-9]+)?)/i);
                if (decMatch) return parseFloat(decMatch[1]);
                const floatMatches = stmt.match(/\+\s*([0-9]+\.[0-9]+)/g);
                if (floatMatches && floatMatches.length > 0) {
                    const lastMatch = floatMatches[floatMatches.length - 1].replace('+', '').trim();
                    return parseFloat(lastMatch) || 0;
                }
            }
        } catch (e) {}
    }
    return 0;
}

app.post('/api/fix_negative_km', (req, res) => {
    const { imeis, date, base_odo } = req.body;
    if (!imeis || !Array.isArray(imeis) || imeis.length === 0 || !date) {
        return res.json({ success: false, message: 'Vehicle IMEIs and Date are required.' });
    }

    engine.log(`[FIX-NEGATIVE-KM] Starting Negative KM repair for ${imeis.length} vehicle(s) on ${date}...`);

    imeis.forEach(async (imei) => {
        try {
            engine.log(`[FIX-NEGATIVE-KM] [${imei}] Step 1/5: Loading telemetry & triggers for ${date}...`);

            const d = new Date(date);
            const prevD = new Date(d);
            prevD.setDate(prevD.getDate() - 1);
            const prevDateStr = prevD.toISOString().split('T')[0];
            const utcStart = `${prevDateStr} 18:30:00`;
            const utcEnd = `${date} 18:30:00`;

            // Read existing trigger offsets BEFORE dropping triggers
            const devTrgOffset = await extractTriggerOffset('dev.igps.io', imei);
            const liveTrgOffset = await extractTriggerOffset('igps.io', imei);

            // 1. Fetch packets for target date from both dev.igps.io and igps.io
            const pkts = await queryEndpointStrict('dev.igps.io', `SELECT sno, dt, dt_s, lat, lng, speed, i_status, totel_km, pack_count FROM \`${imei}\` WHERE dt >= '${utcStart}' AND dt <= '${utcEnd}' ORDER BY dt ASC`);
            if (!Array.isArray(pkts) || pkts.length === 0) {
                engine.log(`[FIX-NEGATIVE-KM] [${imei}] ⚠️ No packets found on ${date}. Skipping.`);
                return;
            }
            let livePkts = [];
            try {
                const lp = await queryEndpoint('igps.io', `SELECT sno, dt, dt_s, lat, lng, speed, i_status, totel_km, pack_count FROM \`${imei}\` WHERE dt >= '${utcStart}' AND dt <= '${utcEnd}' ORDER BY dt ASC`);
                if (Array.isArray(lp)) livePkts = lp;
            } catch (e) {}

            // Choose reference sequence with fewer drops/higher fidelity if dev lost its trigger
            const liveByDt = new Map();
            livePkts.forEach(p => liveByDt.set(p.dt, p));

            // 2. Determine base starting odometer & dual odometer delta
            let startingOdo = base_odo;
            let defaultDelta = 0.0;
            let hasDualFormat = String(pkts[0].totel_km || '').includes('-');
            if (hasDualFormat) {
                const p0Parts = String(pkts[0].totel_km).split('-');
                const d0 = parseFloat(p0Parts[1]) - parseFloat(p0Parts[0]);
                if (!isNaN(d0) && d0 >= 0 && d0 < 20) defaultDelta = parseFloat(d0.toFixed(3));
            }

            if (!startingOdo || isNaN(startingOdo)) {
                const prevPkts = await queryEndpoint('dev.igps.io', `SELECT totel_km FROM \`${imei}\` WHERE dt < '${utcStart}' ORDER BY dt DESC LIMIT 1`);
                if (Array.isArray(prevPkts) && prevPkts.length > 0 && prevPkts[0].totel_km) {
                    const prevParts = String(prevPkts[0].totel_km).split('-');
                    startingOdo = parseFloat(prevParts[prevParts.length - 1]) || 0;
                    if (prevParts.length === 2) {
                        hasDualFormat = true;
                        const pd = parseFloat(prevParts[1]) - parseFloat(prevParts[0]);
                        if (!isNaN(pd) && pd >= 0 && pd < 20) defaultDelta = parseFloat(pd.toFixed(3));
                    }
                }
                if (!startingOdo || startingOdo === 0) {
                    startingOdo = parseFloat(String(pkts[0].totel_km).split('-').pop()) || 2000.0;
                }
            }
            engine.log(`[FIX-NEGATIVE-KM] [${imei}] Step 2/5: Base Starting Odometer set to ${startingOdo.toFixed(3)} (Delta=${defaultDelta.toFixed(3)})`);

            // Compute true global latest raw hardware odometer across dev & live before altering any packets
            let globalRawHwOdo = null;
            const globalDevRows = await queryEndpoint('dev.igps.io', `SELECT totel_km FROM \`${imei}\` WHERE (pack_count IS NULL OR pack_count < 3000) ORDER BY dt DESC LIMIT 1`);
            let globalLiveRows = [];
            try {
                globalLiveRows = await queryEndpoint('igps.io', `SELECT totel_km FROM \`${imei}\` WHERE (pack_count IS NULL OR pack_count < 3000) ORDER BY dt DESC LIMIT 1`);
            } catch (e) {}
            const gDevLast = (Array.isArray(globalDevRows) && globalDevRows.length > 0) ? parseFloat(String(globalDevRows[0].totel_km).split('-').pop()) : NaN;
            const gLiveLast = (Array.isArray(globalLiveRows) && globalLiveRows.length > 0) ? parseFloat(String(globalLiveRows[0].totel_km).split('-').pop()) : NaN;
            if (!isNaN(gDevLast) && !isNaN(gLiveLast)) {
                globalRawHwOdo = Math.min(gDevLast - devTrgOffset, gLiveLast - liveTrgOffset);
            } else if (!isNaN(gDevLast)) {
                globalRawHwOdo = gDevLast - devTrgOffset;
            } else if (!isNaN(gLiveLast)) {
                globalRawHwOdo = gLiveLast - liveTrgOffset;
            }

            // Use igps.io deltas when available after any dev trigger drop so genuine real KM is preserved accurately
            const formatOdo = (k1, pktDelta) => {
                if (!hasDualFormat) return k1.toFixed(3);
                const dUse = (pktDelta >= 0 && pktDelta < 20) ? pktDelta : defaultDelta;
                return `${(k1 - dUse).toFixed(3)}-${k1.toFixed(3)}`;
            };

            let curOdo = startingOdo;
            const p0Parts = String(pkts[0].totel_km).split('-');
            const p0Delta = p0Parts.length === 2 ? (parseFloat(p0Parts[1]) - parseFloat(p0Parts[0])) : defaultDelta;
            const repairedByDt = new Map();
            const updateRowsDev = [{ sno: pkts[0].sno, val: formatOdo(curOdo, p0Delta) }];
            repairedByDt.set(pkts[0].dt, updateRowsDev[0].val);
            let dropsCount = 0;

            for (let i = 1; i < pkts.length; i++) {
                const prevP = pkts[i - 1];
                const currP = pkts[i];
                const prevRef = (liveByDt.get(prevP.dt) && liveByDt.get(currP.dt)) ? liveByDt.get(prevP.dt) : prevP;
                const currRef = (liveByDt.get(prevP.dt) && liveByDt.get(currP.dt)) ? liveByDt.get(currP.dt) : currP;

                const lat1 = parseFloat(prevP.lat);
                const lon1 = parseFloat(prevP.lng);
                const lat2 = parseFloat(currP.lat);
                const lon2 = parseFloat(currP.lng);
                const stepKm = (!isNaN(lat1) && !isNaN(lat2)) ? (haversineMeters(lat1, lon1, lat2, lon2) / 1000.0) : 0;
                const spd = parseFloat(currP.speed) || 0;
                const ist = parseInt(currP.i_status) || 0;

                const prevValDev = parseFloat(String(prevP.totel_km).split('-').pop()) || 0;
                const currValDev = parseFloat(String(currP.totel_km).split('-').pop()) || 0;
                if (currValDev < prevValDev - 0.001) dropsCount++;

                const prevRefVal = parseFloat(String(prevRef.totel_km).split('-').pop()) || 0;
                const currRefVal = parseFloat(String(currRef.totel_km).split('-').pop()) || 0;
                const origDelta = currRefVal - prevRefVal;

                if (origDelta < -0.001) {
                    if (currRef === currP && currValDev >= prevValDev - 0.001) {
                        // Already counted above
                    } else if (currValDev >= prevValDev - 0.001) {
                        dropsCount++;
                    }
                    if ((spd > 0 || ist === 1) && stepKm > 0.003 && stepKm < 5.0) {
                        curOdo += stepKm;
                    }
                } else if (origDelta <= Math.max(2.0, stepKm * 3 + 0.5) && origDelta <= 25.0) {
                    curOdo += origDelta;
                } else if ((spd > 0 || ist === 1) && stepKm > 0.003 && stepKm < 5.0) {
                    curOdo += stepKm;
                }

                const cParts = String(currP.totel_km).split('-');
                const cDelta = cParts.length === 2 ? (parseFloat(cParts[1]) - parseFloat(cParts[0])) : defaultDelta;
                const newVal = formatOdo(curOdo, cDelta);
                updateRowsDev.push({ sno: currP.sno, val: newVal });
                repairedByDt.set(currP.dt, newVal);
            }

            engine.log(`[FIX-NEGATIVE-KM] [${imei}] Step 3/5: Repaired ${dropsCount} backward drops. Day Net Travel: ${(curOdo - startingOdo).toFixed(3)} Km (Ending: ${curOdo.toFixed(3)}).`);

            // 4. Update DEV and LIVE tables in batches of 100 (drop triggers first, apply, then re-arm)
            engine.log(`[FIX-NEGATIVE-KM] [${imei}] Step 4/5: Applying monotonic odometers to dev.igps.io & igps.io...`);
            for (const host of ['dev.igps.io', 'igps.io']) {
                await queryEndpoint(host, `DROP TRIGGER IF EXISTS \`trg_${imei}_lock_km\``, 'update');
            }

            for (let b = 0; b < updateRowsDev.length; b += 100) {
                const batch = updateRowsDev.slice(b, b + 100);
                const cases = batch.map(r => `WHEN ${r.sno} THEN '${r.val}'`).join(' ');
                const snos = batch.map(r => r.sno).join(',');
                const upSql = `UPDATE \`${imei}\` SET totel_km = CASE sno ${cases} END WHERE sno IN (${snos})`;
                await queryEndpointStrict('dev.igps.io', upSql, 'update');
            }

            if (livePkts.length > 0) {
                const updateRowsLive = [];
                for (const lp of livePkts) {
                    const newVal = repairedByDt.get(lp.dt);
                    if (newVal) updateRowsLive.push({ sno: lp.sno, val: newVal });
                }
                for (let b = 0; b < updateRowsLive.length; b += 100) {
                    const batch = updateRowsLive.slice(b, b + 100);
                    const cases = batch.map(r => `WHEN ${r.sno} THEN '${r.val}'`).join(' ');
                    const snos = batch.map(r => r.sno).join(',');
                    const upSqlLive = `UPDATE \`${imei}\` SET totel_km = CASE sno ${cases} END WHERE sno IN (${snos})`;
                    await queryEndpointStrict('igps.io', upSqlLive, 'update');
                }
            }

            // Check latest hardware packet across whole table to determine if fixing today vs historical
            const laterPkts = await queryEndpoint('dev.igps.io', `SELECT sno, dt, totel_km, pack_count FROM \`${imei}\` WHERE dt > '${utcEnd}' ORDER BY dt ASC LIMIT 1`);
            let latestDispAfter = curOdo;
            if (Array.isArray(laterPkts) && laterPkts.length > 0) {
                const firstLaterOdo = parseFloat(String(laterPkts[0].totel_km).split('-').pop()) || 0;
                const cascadeShift = parseFloat((curOdo - firstLaterOdo).toFixed(3));
                if (Math.abs(cascadeShift) > 0.005) {
                    const shiftSql = hasDualFormat
                        ? `UPDATE \`${imei}\` SET totel_km = CONCAT(ROUND(CAST(SUBSTRING_INDEX(totel_km, '-', 1) AS DECIMAL(10,3)) + ${cascadeShift}, 3), '-', ROUND(CAST(SUBSTRING_INDEX(totel_km, '-', -1) AS DECIMAL(10,3)) + ${cascadeShift}, 3)) WHERE dt > '${utcEnd}'`
                        : `UPDATE \`${imei}\` SET totel_km = CAST(ROUND(CAST(totel_km AS DECIMAL(10,3)) + ${cascadeShift}, 3) AS CHAR) WHERE dt > '${utcEnd}'`;
                    for (const host of ['dev.igps.io', 'igps.io']) {
                        await queryEndpointStrict(host, shiftSql, 'update');
                    }
                    engine.log(`[FIX-NEGATIVE-KM] [${imei}] Cascaded subsequent days after ${date} by ${cascadeShift >= 0 ? '+' : ''}${cascadeShift.toFixed(3)} Km.`);
                }
                const maxLater = await queryEndpoint('dev.igps.io', `SELECT totel_km FROM \`${imei}\` WHERE dt > '${utcEnd}' AND (pack_count IS NULL OR pack_count < 3000) ORDER BY dt DESC LIMIT 1`);
                if (Array.isArray(maxLater) && maxLater.length > 0) {
                    latestDispAfter = parseFloat(String(maxLater[0].totel_km).split('-').pop()) || curOdo;
                }
            }

            // Re-arm hardware lock trigger on BOTH servers so next incoming packets NEVER drop backwards!
            if (globalRawHwOdo !== null && !isNaN(globalRawHwOdo)) {
                const newTrgOffset = Math.max(0, parseFloat((latestDispAfter - globalRawHwOdo).toFixed(3)));
                if (newTrgOffset > 0.01) {
                    const trgSql = `CREATE TRIGGER \`trg_${imei}_lock_km\` BEFORE INSERT ON \`${imei}\` FOR EACH ROW BEGIN IF NEW.pack_count < 90000 AND NEW.totel_km IS NOT NULL THEN IF NEW.totel_km LIKE '%-%' THEN SET NEW.totel_km = CONCAT(ROUND(CAST(SUBSTRING_INDEX(NEW.totel_km, '-', 1) AS DECIMAL(10,3)) + ${newTrgOffset.toFixed(3)}, 3), '-', ROUND(CAST(SUBSTRING_INDEX(NEW.totel_km, '-', -1) AS DECIMAL(10,3)) + ${newTrgOffset.toFixed(3)}, 3)); ELSE SET NEW.totel_km = CAST(ROUND(CAST(NEW.totel_km AS DECIMAL(10,3)) + ${newTrgOffset.toFixed(3)}, 3) AS CHAR); END IF; END IF; END`;
                    for (const host of ['dev.igps.io', 'igps.io']) {
                        await queryEndpointStrict(host, trgSql, 'update');
                    }
                    engine.log(`[FIX-NEGATIVE-KM] [${imei}] Hardware lock trigger re-armed on dev & live (+${newTrgOffset.toFixed(3)} KM).`);
                }
            }

            // 5. Verify with history_web on dev.igps.io
            engine.log(`[FIX-NEGATIVE-KM] [${imei}] Step 5/5: Verifying Playback continuity...`);
            const p = new URLSearchParams();
            p.append('imei', imei);
            p.append('from', `${date} 00:00:00`);
            p.append('to', `${date} 23:59:59`);
            p.append('username', 'trichy');
            p.append('action', 'history_web');
            const hRes = await axios.post('http://dev.igps.io/http.php', p.toString(), {
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 15000
            });

            if (Array.isArray(hRes.data) && hRes.data.length > 0) {
                const o0 = parseFloat(String(hRes.data[0].totel_km).split('-').pop());
                const o1 = parseFloat(String(hRes.data[hRes.data.length - 1].totel_km).split('-').pop());
                const verifiedKm = (o1 - o0).toFixed(1);
                if (o1 >= o0 - 0.05) {
                    engine.log(`[FIX-NEGATIVE-KM] [${imei}] ✅ SUCCESS! Negative KM fixed! Playback Total KM: ${verifiedKm}Km (from ${o0.toFixed(3)} to ${o1.toFixed(3)})`);
                } else {
                    engine.log(`[FIX-NEGATIVE-KM] [${imei}] ❌ WARNING: Playback still negative (${verifiedKm}Km: ${o0.toFixed(3)} -> ${o1.toFixed(3)}). Check base_odo or duplicate packets.`);
                }
            } else {
                engine.log(`[FIX-NEGATIVE-KM] [${imei}] ⚠️ Completed database repair. Verify in Route Playback.`);
            }

            engine.save_history(imei, 'fix_negative_km', (curOdo - startingOdo), startingOdo, curOdo, 0, 0, date);
        } catch(err) {
            console.error(`[FIX-NEGATIVE-KM ERROR] [${imei}] ${err.message}`);
            engine.log(`[FIX-NEGATIVE-KM ERROR] [${imei}] ❌ Error: ${err.message}`);
        }
    });

    res.json({ success: true, message: `Fix Negative KM task dispatched for ${imeis.length} vehicle(s).` });
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

// ====================================================================
// Server Cron Jobs & Deduplication Registry
// ====================================================================
let cronState = {
    lastRun: null,
    nextRun: '05:30 AM IST (Daily)',
    lastStatus: 'Idle / Ready',
    lastOutput: ''
};
let lastCronRunDate = '';

function runDuplicateCleaner(targetDate, imei) {
    return new Promise((resolve) => {
        let cmdArgs = '';
        if (targetDate) cmdArgs += ` --date ${targetDate}`;
        if (imei) cmdArgs += ` --imei ${imei}`;
        const scriptPath = path.join(__dirname, 'auto_clean_and_lock_cron.py');
        const cmd = `${PYTHON_CMD} "${scriptPath}" ${cmdArgs}`.trim();

        if (engine && typeof engine.log === 'function') {
            engine.log(`[CRON START] Executing Autonomous Deduplication Engine for ${imei ? 'IMEI ' + imei : 'all spoofed vehicles'} on ${targetDate || 'yesterday'}...`);
        }
        cronState.lastStatus = `Running for ${imei ? 'IMEI ' + imei : (targetDate || 'yesterday')}...`;

        exec(cmd, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
            const out = stdout || stderr || '';
            cronState.lastRun = new Date().toISOString();
            cronState.lastOutput = out;

            if (err) {
                cronState.lastStatus = `Error: ${err.message}`;
                if (engine && typeof engine.log === 'function') {
                    engine.log(`[CRON ERROR] Deduplication failed: ${err.message}`);
                }
                resolve({ success: false, message: err.message, output: out });
            } else {
                cronState.lastStatus = 'Completed Successfully';
                if (engine && typeof engine.log === 'function') {
                    engine.log(`[CRON SUCCESS] Deduplication & Lock completed for ${targetDate || 'yesterday'}`);
                }
                resolve({ success: true, message: 'Deduplication & Lock completed successfully.', output: out });
            }
        });
    });
}

// Autonomous Daily 05:30 AM IST Scheduler
function initServerCron() {
    console.log('[AUTONOMOUS CRON] Initialized: Duplicate cleanup & report lock scheduled for 05:30 AM IST daily.');

    setInterval(() => {
        try {
            // Get current time in Indian Standard Time (IST, UTC+5:30)
            const nowIST = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
            const hours = nowIST.getHours();
            const mins = nowIST.getMinutes();
            const todayStr = nowIST.toISOString().split('T')[0];

            // Trigger automatically at 05:30 AM IST
            if (hours === 5 && mins === 30 && lastCronRunDate !== todayStr) {
                lastCronRunDate = todayStr;
                const yesterday = new Date(nowIST.getTime() - 24 * 60 * 60 * 1000).toISOString().split('T')[0];
                console.log(`[AUTONOMOUS CRON WAKEUP] Woke up at 05:30 AM IST. Cleaning duplicates for ${yesterday}...`);
                runDuplicateCleaner(yesterday);
            }
        } catch (e) {
            console.error('[CRON TIMER ERROR]', e);
        }
    }, 60 * 1000); // Check every 60 seconds
}

// API: Manual trigger or UI click
app.post('/api/cron/clean-duplicates', async (req, res) => {
    const { date, imei } = req.body || {};
    const result = await runDuplicateCleaner(date, imei);
    res.json(result);
});

// API: Check cron status
app.get('/api/cron/status', (req, res) => {
    res.json(cronState);
});

app.listen(port, () => {
    console.log(`Node.js Admin Dashboard running at http://localhost:${port}`);
    
    // Initialize autonomous background cron
    initServerCron();

    // Asynchronously fetch history from database and sync to history.json
    initHistoryFromDatabase();
});

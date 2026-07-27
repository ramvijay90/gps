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

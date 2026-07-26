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
            if (override_normal_duration !== undefined && String(override_normal_duration).trim() !== "") {
                try {
                    const parts = override_normal_duration.split(",");
                    const sec_parts = parts.map(p => String(Math.floor(parseFloat(p.trim()) * 60)));
                    normal_duration_str = sec_parts.join(",");
                    use_override_hours = true;
                } catch(e) {
                    engine.log(`[REFRESH] [${imei}] Invalid override Trip Durations format: ${override_normal_duration}`);
                }
            }
            
            let telemetry_data = [];
            if (!use_override_km || !use_override_hours) {
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
                
                if (Array.isArray(history_res.data) && history_res.data.length > 0) {
                    telemetry_data = history_res.data;
                } else {
                    engine.log(`[REFRESH] [${imei}] No raw history packets found. Telemetry calculation skipped.`);
                    if (!use_override_km && !use_override_hours) {
                        return;
                    }
                }
            }
            
            // Auto calculate KM
            if (!use_override_km && telemetry_data.length > 0) {
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
                    
                    const trips_km = [];
                    const trips_durations = [];
                    const trips_start_times = [];
                    const trips_end_times = [];
                    let current_trip_odos = [];
                    let current_trip_times = [];
                    
                    telemetry_data.forEach(pkt => {
                        const speed = parseFloat(pkt.speed || 0);
                        const totel_km = pkt.totel_km || "";
                        const time_str = pkt.dt || "";
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
                            
                            if (speed > 0) {
                                current_trip_odos.push(val);
                                current_trip_times.push(pkt_dt);
                            } else {
                                if (current_trip_odos.length > 1) {
                                    const trip_dist = Math.max(...current_trip_odos) - Math.min(...current_trip_odos);
                                    const trip_dur = (Math.max(...current_trip_times) - Math.min(...current_trip_times)) / 1000.0;
                                    if (trip_dist > 0.01 || trip_dur > 10) {
                                        trips_km.push(parseFloat(trip_dist.toFixed(3)));
                                        trips_durations.push(Math.round(trip_dur));
                                        
                                        const min_dt = new Date(Math.min(...current_trip_times.map(t=>t.getTime())));
                                        const max_dt = new Date(Math.max(...current_trip_times.map(t=>t.getTime())));
                                        trips_start_times.push(min_dt.toISOString().replace('T', ' ').substring(0, 19));
                                        trips_end_times.push(max_dt.toISOString().replace('T', ' ').substring(0, 19));
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
                            trips_km.push(parseFloat(trip_dist.toFixed(3)));
                            trips_durations.push(Math.round(trip_dur));
                            
                            const min_dt = new Date(Math.min(...current_trip_times.map(t=>t.getTime())));
                            const max_dt = new Date(Math.max(...current_trip_times.map(t=>t.getTime())));
                            trips_start_times.push(min_dt.toISOString().replace('T', ' ').substring(0, 19));
                            trips_end_times.push(max_dt.toISOString().replace('T', ' ').substring(0, 19));
                        }
                    }
                    
                    if (trips_km.length === 0) {
                        trips_km.push(parseFloat(total_km.toFixed(3)));
                        trips_durations.push(0);
                        trips_start_times.push(`${date} 09:00:00`);
                        trips_end_times.push(`${date} 09:00:00`);
                    }
                    
                    normal_km_str = trips_km.join(",");
                    engine.log(`[REFRESH] [${imei}] Auto-calculated Run KM: ${total_km_str}, Trips: [${normal_km_str}]`);
                    
                    if (!use_override_hours) {
                        const sum_seconds = trips_durations.reduce((a, b) => a + b, 0);
                        run_time_str = String(sum_seconds);
                        normal_duration_str = trips_durations.join(",");
                        engine.log(`[REFRESH] [${imei}] Auto-calculated Run Time: ${(sum_seconds/3600.0).toFixed(2)} Hrs, Durations: [${trips_durations.map(d => (d/60.0).toFixed(1)).join(",")}] Min`);
                    } else {
                        if (normal_duration_str === null || normal_duration_str === undefined || normal_duration_str.trim() === "") {
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
                            engine.log(`[REFRESH] [${imei}] Auto-scaled raw durations to match override hours ${override_hours}: [${trips_durations.map(d => (d/60.0).toFixed(1)).join(",")}] Min`);
                        }
                    }

                    // Now align start and end times to prevent overlaps and match durations!
                    if (trips_durations.length === trips_start_times.length) {
                        const new_starts = [];
                        const new_ends = [];
                        for (let idx = 0; idx < trips_durations.length; idx++) {
                            try {
                                const orig_start = new Date(trips_start_times[idx].replace(" ", "T") + "Z");
                                let n_start;
                                if (idx === 0) {
                                    n_start = orig_start;
                                } else {
                                    const orig_end_prev = new Date(trips_end_times[idx-1].replace(" ", "T") + "Z");
                                    const orig_break_ms = orig_start.getTime() - orig_end_prev.getTime();
                                    const break_ms = Math.max(60000, orig_break_ms); // minimum 1 minute break
                                    n_start = new Date(new Date(new_ends[idx-1]).getTime() + break_ms);
                                }
                                const n_end = new Date(n_start.getTime() + trips_durations[idx] * 1000);
                                new_starts.push(n_start.toISOString().replace("T", " ").substring(0, 19));
                                new_ends.push(n_end.toISOString().replace("T", " ").substring(0, 19));
                            } catch(e) {
                                new_starts.push(trips_start_times[idx]);
                                new_ends.push(trips_end_times[idx]);
                            }
                        }
                        trips_start_times = new_starts;
                        trips_end_times = new_ends;
                    }

                    normal_start_time_str = trips_start_times.join(",");
                    normal_end_time_str = trips_end_times.join(",");
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
                
                if (updates.length > 0) {
                    const update_query = `UPDATE reports SET ${updates.join(', ')} WHERE imei = '${imei}' AND dt = '${target_date_db}'`;
                    const update_params = new URLSearchParams();
                    update_params.append('action', 'select');
                    update_params.append('query', Buffer.from(update_query).toString('base64'));
                    update_params.append('type', 'update');
                    
                    await axios.post('http://dev.igps.io/http.php', update_params.toString(), {
                        headers: {'Content-Type': 'application/x-www-form-urlencoded'},
                        timeout: 10000
                    });
                    engine.log(`[REFRESH] [${imei}] Updated report row successfully.`);
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
                
                const insert_query = `INSERT INTO reports (${cols.join(', ')}) VALUES (${vals.join(', ')})`;
                const insert_params = new URLSearchParams();
                insert_params.append('action', 'select');
                insert_params.append('query', Buffer.from(insert_query).toString('base64'));
                insert_params.append('type', 'insert');
                
                await axios.post('http://dev.igps.io/http.php', insert_params.toString(), {
                    headers: {'Content-Type': 'application/x-www-form-urlencoded'},
                    timeout: 10000
                });
                engine.log(`[REFRESH] [${imei}] Created new daily report row successfully.`);
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

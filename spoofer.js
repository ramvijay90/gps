const mqtt = require('mqtt');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
let vehicle_db = [];
try {
    vehicle_db = JSON.parse(fs.readFileSync(path.join(__dirname, 'vehicles.json'), 'utf8'));
} catch(e) {}

class SpooferEngine {
    constructor() {
        this.active_shields_list = {}; // { imei: { expiry_time, cancel, interval, client } }
        this.active_drives = 0;
        this.logs = [];
        this.MQTT_BROKER = "mqtt://igps.io:1883";
        this.is_scheduled = false;
        this.kill_all_drives = false;
    }
    
    get is_running() {
        return this.active_drives > 0 || Object.keys(this.active_shields_list).length > 0;
    }
    
    async runQuery(host, sql, type = "select", retries = 3) {
        for (let attempt = 1; attempt <= retries; attempt++) {
            try {
                const sqlB64 = Buffer.from(sql).toString('base64');
                const params = new URLSearchParams();
                params.append('action', 'select');
                params.append('query', sqlB64);
                params.append('type', type);

                const res = await axios.post(`http://${host}/http.php`, params.toString(), {
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded',
                        'User-Agent': 'Mozilla/5.0'
                    },
                    timeout: 40000
                });

                if (typeof res.data === 'string' && res.data.includes('SQLSTATE')) {
                    this.log(`[DB-ERR] (${host}) SQLSTATE: ${res.data.substring(0, 160)}`);
                    return null;
                }
                if (type === "select" && !Array.isArray(res.data)) {
                    if (attempt < retries) {
                        await new Promise(r => setTimeout(r, 600 * attempt));
                        continue;
                    }
                    this.log(`[DB-WARN] (${host}) Unexpected non-array select response.`);
                    return null;
                }
                return res.data;
            } catch (e) {
                if (attempt < retries) {
                    await new Promise(r => setTimeout(r, 600 * attempt));
                    continue;
                }
                this.log(`[DB-ERR] (${host}) Query failed after ${retries} attempts: ${e.message}`);
                return null;
            }
        }
        return null;
    }

    async executeDual(sql, type = "update") {
        const hosts = ['dev.igps.io', 'igps.io'];
        const results = await Promise.all(hosts.map(h => this.runQuery(h, sql, type)));
        return {
            devOk: results[0] !== null,
            liveOk: results[1] !== null,
            results
        };
    }

    async fetchDayPacketsSafe(imei, target_date_str) {
        const dayStartUtc = this.formatDateStr(new Date(new Date(`${target_date_str}T00:00:00Z`).getTime() - (330 * 60000)));
        const dayEndUtc = this.formatDateStr(new Date(new Date(`${target_date_str}T23:59:59Z`).getTime() - (330 * 60000)));
        const selSql = `SELECT sno, dt, dt_s, lat, lng, speed, battery, i_time, i_status, course, overspeed, totel_km, t_w, jcb_ac FROM \`${imei}\` WHERE dt >= '${dayStartUtc}' AND dt <= '${dayEndUtc}' ORDER BY dt ASC`;

        for (const host of ['dev.igps.io', 'igps.io']) {
            const rows = await this.runQuery(host, selSql, "select", 3);
            if (Array.isArray(rows) && rows.length > 0) {
                return { pkts: rows, source: `${host}:select` };
            }
        }

        // Fallback to compact history_web endpoint if large table select fails/times out
        for (const host of ['dev.igps.io', 'igps.io']) {
            for (let attempt = 1; attempt <= 2; attempt++) {
                try {
                    const params = new URLSearchParams();
                    params.append('imei', imei);
                    params.append('from', `${target_date_str} 00:00:00`);
                    params.append('to', `${target_date_str} 23:59:59`);
                    params.append('username', 'trichy');
                    params.append('action', 'history_web');
                    const res = await axios.post(`http://${host}/http.php`, params.toString(), {
                        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                        timeout: 25000
                    });
                    if (Array.isArray(res.data) && res.data.length > 0) {
                        const sorted = [...res.data].sort((a, b) => String(a.dt).localeCompare(String(b.dt)));
                        return { pkts: sorted, source: `${host}:history_web` };
                    }
                } catch (e) {
                    if (attempt < 2) await new Promise(r => setTimeout(r, 500));
                }
            }
        }

        return { pkts: [], source: 'none' };
    }
    
    log(message) {
        // Shift time by 5 hours 30 minutes for IST
        const istTime = new Date(Date.now() + (330 * 60000));
        const timestamp = istTime.toISOString().split('T')[1].substring(0, 8);
        this.logs.push(`[${timestamp}] ${message}`);
        if (this.logs.length > 100) {
            this.logs.shift();
        }
    }
    
    get_logs() {
        return this.logs;
    }
    
    get_active_shields() {
        return Object.keys(this.active_shields_list).map(imei => ({
            imei: imei,
            expiry_time: this.active_shields_list[imei].expiry_time
        }));
    }
    
    cancel_shield(imei) {
        if (this.active_shields_list[imei]) {
            this.active_shields_list[imei].cancel();
            return true;
        }
        return false;
    }
    
    save_history(imei, mode, added_km, start_odo, final_odo, target_hours, shield_hours, history_date = null) {
        try {
            const HISTORY_FILE = path.join(__dirname, '..', 'data_storage', 'history.json');
            let history = [];
            if (fs.existsSync(HISTORY_FILE)) {
                history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
            }
            const istTime = new Date(Date.now() + (330 * 60000));
            const recordDate = history_date ? history_date : istTime.toISOString().split('T')[0];
            
            const timestamp = istTime.toISOString().replace('T', ' ').substring(0, 19);
            const addedKmNum = parseFloat(parseFloat(added_km).toFixed(2)) || 0.0;
            const startOdoNum = parseFloat(parseFloat(start_odo).toFixed(2)) || 0.0;
            const finalOdoNum = parseFloat(parseFloat(final_odo).toFixed(2)) || 0.0;
            const targetHrsNum = parseFloat(target_hours) || 0.0;
            const shieldHrsNum = parseFloat(shield_hours) || 0.0;
            
            history.unshift({
                timestamp,
                date: recordDate,
                imei,
                mode,
                added_km: addedKmNum,
                start_odo: startOdoNum,
                final_odo: finalOdoNum,
                target_hours: targetHrsNum,
                shield_hours: shieldHrsNum
            });
            if (history.length > 1000) history = history.slice(0, 1000); // keep last 1000
            fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 4));
            
            // Asynchronously save history record to remote MySQL database
            const insertSql = `INSERT INTO \`gps_history_log\` (timestamp, date, imei, mode, added_km, start_odo, final_odo, target_hours, shield_hours) VALUES ('${timestamp}', '${recordDate}', '${imei}', '${mode}', ${addedKmNum}, ${startOdoNum}, ${finalOdoNum}, ${targetHrsNum}, ${shieldHrsNum})`;
            const sqlB64 = Buffer.from(insertSql).toString('base64');
            const params = new URLSearchParams();
            params.append('action', 'select');
            params.append('query', sqlB64);
            params.append('type', 'select');
            
            axios.post('http://dev.igps.io/http.php', params.toString(), {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
                },
                timeout: 5000
            }).catch(err => {
                console.error("[-] Failed to save history to MySQL database:", err.message);
            });
        } catch (e) {
            console.error("Failed to save history", e);
        }
    }
    
    async fetch_live_data_instant(imei, target_date = null) {
        try {
            let from_date_str, to_date_str;
            if (target_date) {
                from_date_str = target_date + " 00:00:00";
                to_date_str = target_date + " 23:59:59";
            } else {
                const today = new Date();
                const three_days_ago = new Date();
                three_days_ago.setDate(today.getDate() - 3);
                from_date_str = three_days_ago.toISOString().split('T')[0] + " 00:00:00";
                to_date_str = today.toISOString().split('T')[0] + " 23:59:59";
            }
            
            const params = new URLSearchParams();
            params.append('imei', imei);
            params.append('from', from_date_str);
            params.append('to', to_date_str);
            params.append('username', 'trichy');
            params.append('action', 'history_web');
            
            const res = await axios.post("http://dev.igps.io/http.php", params.toString(), {
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                timeout: 10000
            });
            
            const data = res.data;
            if (Array.isArray(data) && data.length > 0) {
                const last_record = data[data.length - 1];
                const lat = parseFloat(last_record.lat || 0);
                const lng = parseFloat(last_record.lng || 0);
                const totel_km = last_record.totel_km || "";
                
                let odo = 0.0, today_odo = 0.0;
                let is_dual = false;
                if (totel_km.includes("-")) {
                    is_dual = true;
                    const parts = totel_km.split("-");
                    odo = parseFloat(parts[0]) || 0.0;
                    today_odo = parseFloat(parts[1]) || 0.0;
                } else if (totel_km) {
                    odo = parseFloat(totel_km) || 0.0;
                    today_odo = odo;
                }
                
                return { success: true, lat, lng, odo, today_odo, is_dual, totel_km };
            }
            return { success: false, error: "No historical data found" };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }
    
    async fetch_historical_track_window(imei, from_date, to_date) {
        try {
            const from_str = this.formatDateStr(from_date);
            const to_str = this.formatDateStr(to_date);
            const date1 = from_str.substring(0, 10);
            const date2 = to_str.substring(0, 10);
            
            const params = new URLSearchParams();
            params.append('imei', imei);
            params.append('from', date1 + " 00:00:00");
            params.append('to', date2 + " 23:59:59");
            params.append('username', 'trichy');
            params.append('action', 'history_web');
            
            const res = await axios.post("http://dev.igps.io/http.php", params.toString(), {
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                timeout: 15000
            });
            
            const data = res.data;
            if (Array.isArray(data)) {
                return data.filter(p => {
                    const dt_str = p.dt;
                    return dt_str >= from_str && dt_str <= to_str;
                }).map(p => ({
                    dt: p.dt,
                    lat: parseFloat(p.lat || 0),
                    lng: parseFloat(p.lng || 0)
                }));
            }
        } catch (e) {
            this.log(`Error fetching historical track for ${imei}: ${e.message}`);
        }
        return [];
    }
    
    start(imeis, lat, lng, mode, history_date, target_hours, start_odo, speed, start_today_odo = 0.0, shield_hours = 0.0, target_trip = 'auto', initial_gap_mins = 4.2, halt_mins = 3.5) {
        const config = {
            lat: parseFloat(lat),
            lng: parseFloat(lng),
            mode: mode,
            history_date: history_date,
            target_hours: parseFloat(target_hours),
            start_odo: parseFloat(start_odo),
            start_today_odo: parseFloat(start_today_odo),
            speed: parseFloat(speed),
            shield_hours: parseFloat(shield_hours),
            target_trip: target_trip,
            initial_gap_mins: parseFloat(initial_gap_mins || 4.2),
            halt_mins: parseFloat(halt_mins || 3.5)
        };
        
        if (config.mode === "parked") config.speed = 0;
        
        this.log(`[+] Concurrent Spoofer started for ${imeis.length} vehicles in ${config.mode.toUpperCase()} mode.`);
        
        // Run asynchronously without blocking
        this._orchestrator(imeis, config);
        
        return true;
    }
    
    stop() {
        this.kill_all_drives = true;
        
        // Clear all shields explicitly
        Object.keys(this.active_shields_list).forEach(imei => {
            try { this.active_shields_list[imei].cancel(); } catch(e) {}
        });
        this.active_shields_list = {};
        
        this.log("[-] STOP ALL ISSUED: All Ghost Drives and Shields killed.");
        setTimeout(() => { this.kill_all_drives = false; }, 3000);
        return true;
    }
    
    _calculate_next_position(lat, lng, distance_m, bearing) {
        const R = 6378137;
        const lat1 = lat * Math.PI / 180;
        const lon1 = lng * Math.PI / 180;
        const lat2 = Math.asin(Math.sin(lat1)*Math.cos(distance_m/R) + Math.cos(lat1)*Math.sin(distance_m/R)*Math.cos(bearing));
        const lon2 = lon1 + Math.atan2(Math.sin(bearing)*Math.sin(distance_m/R)*Math.cos(lat1), Math.cos(distance_m/R)-Math.sin(lat1)*Math.sin(lat2));
        return { lat: lat2 * 180 / Math.PI, lng: lon2 * 180 / Math.PI };
    }
    
    async _orchestrator(imeis, config) {
        this.active_drives++;
        const batch_size = 100;
        for (let i = 0; i < imeis.length; i += batch_size) {
            if (this.kill_all_drives) break;
            const batch = imeis.slice(i, i + batch_size);
            
            const promises = batch.map(imei => this._process_vehicle(imei, config));
            await Promise.all(promises);
            
            await new Promise(r => setTimeout(r, 1000));
        }
        this.active_drives = Math.max(0, this.active_drives - 1);
        this.log(`[+] Batch completed.`);
    }
    
    formatDateStr(dateObj) {
        // GPS Payloads MUST be in UTC for the tracking server to accept them properly
        return dateObj.toISOString().replace('T', ' ').substring(0, 19);
    }
    
    formatDateStrIST(dateObj) {
        // UI and Logs should be in IST
        const istTime = new Date(dateObj.getTime() + (330 * 60000));
        return istTime.toISOString().replace('T', ' ').substring(0, 19);
    }
    
    engage_shield(imei, final_odo, final_lat, final_lng, hours_only, expiry_hours = 12) {
        if (this.active_shields_list[imei]) {
            try { this.active_shields_list[imei].cancel(); } catch(e) {}
        }
        
        const client = mqtt.connect(this.MQTT_BROKER, {
            username: "realiot",
            password: "realmqtt@123",
            clientId: `mqttjs_sh_${imei}_${Math.random().toString(16).substr(2, 4)}`,
            connectTimeout: 5000
        });
        
        const expiryDate = new Date(Date.now() + expiry_hours * 3600000);
        const topic = `BB/${imei}`;
        
        const odo_str = `${final_odo.toFixed(6)}-${final_odo.toFixed(6)}`;
        const coord_str = `+${parseFloat(final_lat).toFixed(6)},+${parseFloat(final_lng).toFixed(6)}`;
        
        let shield_interval_id = setInterval(() => {
            if (this.kill_all_drives) {
                clearInterval(shield_interval_id);
                client.end();
                delete this.active_shields_list[imei];
                return;
            }
            
            const time_str = this.formatDateStr(new Date());
            // Parked heartbeat: Ignition=0, Speed=0, JCB=0-0-0-0
            const payload = `##,${imei},0,${time_str},${coord_str},0,12.0,0,0,91.26,${odo_str},0-0,0-0,0-0,+0.0,0,0-0-0-0,2000-00-00 00:00:00,2000-00-00 00:00:00,12,3950,0,1-0-0-0-0,0,0,0-0,0,0,2782,0,0-26,3950,0,0,0,0,00000-00,$`;
            client.publish(topic, payload);
        }, 5000); // Heartbeat every 5 seconds
        
        this.active_shields_list[imei] = {
            expiry_time: expiryDate.toLocaleTimeString('en-US', { timeZone: 'Asia/Kolkata' }),
            cancel: () => {
                clearInterval(shield_interval_id);
                client.end();
            },
            interval: shield_interval_id,
            client: client
        };
        
        this.log(`[SHIELD ENGAGED] [${imei}] Protecting odometer at ${final_odo.toFixed(2)} KM until ${this.active_shields_list[imei].expiry_time} IST`);
    }
    
    async _process_vehicle(imei, config) {
        let v_voltage = 25.0;
        const matched = vehicle_db.find(v => v.imei === imei);
        if (matched && matched.voltage) {
            v_voltage = parseFloat(matched.voltage);
        }

        if (config.mode === "drive") {
            let target_date_str = config.history_date;
            if (!target_date_str) {
                target_date_str = this.formatDateStrIST(new Date()).split(' ')[0];
            }

            const inject_seconds = Math.round(config.target_hours * 3600);
            if (!inject_seconds || inject_seconds <= 0) {
                this.log(`[${imei}] ❌ Aborted Ghost Drive Hours: invalid duration (${config.target_hours} hrs).`);
                return;
            }
            this.log(`[${imei}] Starting Ghost Drive Hours (+${config.target_hours} hrs) for date ${target_date_str}...`);

            // 1. Fetch packets chronologically with retries and igps.io / history_web fallbacks
            const { pkts, source } = await this.fetchDayPacketsSafe(imei, target_date_str);
            if (!pkts || pkts.length === 0) {
                this.log(`[${imei}] ❌ ERROR: Could not load telemetry for ${target_date_str} (dev & live returned 0 packets). Aborting without logging fake hours!`);
                return;
            }
            this.log(`[${imei}] Loaded ${pkts.length} chronological packets (${source}).`);

            // 2. Dual Odometer & metadata preservation
            const last_pkt = pkts[pkts.length - 1];
            const raw_totel_km = last_pkt.totel_km || "";
            const battery_val = String(last_pkt.battery || '13.4').replace(/'/g, '');
            const tw_val = String(last_pkt.t_w || '+0.0$0').replace(/'/g, '');
            const course_val = String(last_pkt.course || '0').replace(/'/g, '');

            let is_dual = raw_totel_km.includes("-");
            let odo_0 = 0.0, odo_1 = 0.0;
            if (is_dual) {
                const parts = raw_totel_km.split("-");
                odo_0 = parseFloat(parts[0]) || 0.0;
                odo_1 = parseFloat(parts[1]) || 0.0;
            } else if (raw_totel_km) {
                odo_0 = parseFloat(raw_totel_km) || 0.0;
                odo_1 = odo_0;
            }
            const odo_str = is_dual ? `${odo_0.toFixed(6)}-${odo_1.toFixed(6)}` : `${odo_0.toFixed(6)}`;
            this.log(`[${imei}] Preserved Odometer: ${odo_str} (prevents negative KM).`);

            // 3. Segment trips chronologically
            const trips = [];
            let curr = [];
            const pushTripIfValid = (seg) => {
                if (seg.length <= 1) return;
                const t0 = String(seg[0].totel_km || '0');
                const t1 = String(seg[seg.length - 1].totel_km || '0');
                const o1 = parseFloat(t0.includes('-') ? t0.split('-')[1] : t0) || 0;
                const o2 = parseFloat(t1.includes('-') ? t1.split('-')[1] : t1) || 0;
                const dist = Math.max(0.0, o2 - o1);
                const t1_d = new Date(seg[0].dt.replace(' ', 'T') + 'Z');
                const t2_d = new Date(seg[seg.length - 1].dt.replace(' ', 'T') + 'Z');
                const dur = Math.round((t2_d.getTime() - t1_d.getTime()) / 1000);
                if (dist >= 0.05 || dur >= 60) {
                    const pEnd = String(seg[seg.length - 1].totel_km || '');
                    let endOdoFmt = odo_str;
                    if (pEnd.includes('-')) {
                        const ep = pEnd.split('-');
                        endOdoFmt = `${(parseFloat(ep[0]) || 0).toFixed(6)}-${(parseFloat(ep[1]) || 0).toFixed(6)}`;
                    } else if (pEnd) {
                        endOdoFmt = `${(parseFloat(pEnd) || 0).toFixed(6)}`;
                    }
                    trips.push({
                        start_time_utc: seg[0].dt,
                        end_time_utc: seg[seg.length - 1].dt,
                        start_time_ist: seg[0].dt_s,
                        end_time_ist: seg[seg.length - 1].dt_s,
                        dist_km: dist.toFixed(3),
                        dur_sec: dur,
                        start_lat: seg[0].lat,
                        start_lng: seg[0].lng,
                        end_lat: seg[seg.length - 1].lat,
                        end_lng: seg[seg.length - 1].lng,
                        end_odo_str: endOdoFmt,
                        gap_sec: 0
                    });
                }
            };

            for (let i = 0; i < pkts.length; i++) {
                const p = pkts[i];
                const spd = parseFloat(p.speed || 0);
                const ign = String(p.i_status || '0');
                if (spd > 0 || ign === '1') {
                    curr.push(p);
                } else {
                    pushTripIfValid(curr);
                    curr = [];
                }
            }
            pushTripIfValid(curr);

            // 4. Select target trip (or handle stationary day safely)
            let target_trip_idx = -1;
            if (config.target_trip && config.target_trip !== 'auto') {
                if (config.target_trip === 'last') {
                    target_trip_idx = trips.length - 1;
                } else {
                    const chosen = parseInt(config.target_trip, 10);
                    if (!isNaN(chosen) && chosen >= 1 && chosen <= trips.length) {
                        target_trip_idx = chosen - 1;
                    }
                }
            }
            if (target_trip_idx === -1 && trips.length > 0) {
                target_trip_idx = trips.length - 1;
            }

            let ext_start, ext_end, lat_val, lng_val, win_odo_str;
            const initial_gap_sec = Math.round((config.initial_gap_mins !== undefined ? parseFloat(config.initial_gap_mins) : 4.2) * 60);

            if (target_trip_idx >= 0) {
                const selected_trip = trips[target_trip_idx];
                const t_end = new Date(selected_trip.end_time_utc.replace(' ', 'T') + 'Z');
                ext_start = new Date(t_end.getTime() + (initial_gap_sec * 1000));
                ext_end = new Date(ext_start.getTime() + (inject_seconds * 1000));
                lat_val = selected_trip.end_lat;
                lng_val = selected_trip.end_lng;
                win_odo_str = (target_trip_idx === trips.length - 1) ? odo_str : (selected_trip.end_odo_str || odo_str);
            } else {
                // Vehicle had 0 moving trips all day: anchor in stationary window before 23:55 IST
                const anchorEnd = new Date(Math.min(
                    new Date(`${target_date_str}T18:25:00Z`).getTime(),
                    new Date(last_pkt.dt.replace(' ', 'T') + 'Z').getTime()
                ));
                ext_end = anchorEnd;
                ext_start = new Date(ext_end.getTime() - (inject_seconds * 1000));
                const validCoordPkt = [...pkts].reverse().find(p => Math.abs(parseFloat(p.lat || 0)) > 1 && Math.abs(parseFloat(p.lng || 0)) > 1) || last_pkt;
                lat_val = validCoordPkt.lat;
                lng_val = validCoordPkt.lng;
                win_odo_str = odo_str;
                trips.push({
                    start_time_utc: this.formatDateStr(ext_start),
                    end_time_utc: this.formatDateStr(ext_start),
                    start_time_ist: this.formatDateStrIST(ext_start),
                    end_time_ist: this.formatDateStrIST(ext_start),
                    dist_km: '0.000',
                    dur_sec: 0,
                    start_lat: lat_val,
                    start_lng: lng_val,
                    end_lat: lat_val,
                    end_lng: lng_val,
                    end_odo_str: win_odo_str,
                    gap_sec: 0
                });
                target_trip_idx = 0;
            }

            const win_start_utc = this.formatDateStr(ext_start);
            const win_end_utc = this.formatDateStr(ext_end);
            const final_off_utc = this.formatDateStr(new Date(ext_end.getTime() + 1000));
            const final_off_ist = this.formatDateStrIST(new Date(ext_end.getTime() + 1000));

            this.log(`[${imei}] Extending Trip ${target_trip_idx + 1} (${win_start_utc} -> ${win_end_utc} UTC, +${config.target_hours} hrs)...`);

            // Idempotent cleanup of prior synthetic heartbeats in this exact window
            const delPrevSql = `DELETE FROM \`${imei}\` WHERE dt >= '${win_start_utc}' AND dt <= '${final_off_utc}' AND pack_count = 2782`;
            await this.executeDual(delPrevSql, "update");

            // A. Update existing halt packets in window
            const updateSql = `UPDATE \`${imei}\` SET i_status = '1', jcb_ac = '1-0-0-0', totel_km = '${win_odo_str}' WHERE dt >= '${win_start_utc}' AND dt <= '${win_end_utc}' AND speed = '0'`;
            const upRes = await this.executeDual(updateSql, "update");

            // B. Insert 60s heartbeats including ALL NOT NULL columns (imei, battery, i_time, course, overspeed, t_w)
            const heartbeatRows = [];
            const total_heartbeats = Math.floor(inject_seconds / 60);
            for (let h = 1; h <= total_heartbeats; h++) {
                const pkt_date = new Date(ext_start.getTime() + (h * 60000));
                const dt_str = this.formatDateStr(pkt_date);
                const dt_s_str = this.formatDateStrIST(pkt_date);
                heartbeatRows.push(`('${dt_str}', '${dt_s_str}', '${imei}', '${lat_val}', '${lng_val}', '0', '${battery_val}', '0', '1', '${course_val}', '0-0', '1-0-0-0', '${win_odo_str}', '${tw_val}', 2782)`);
            }

            let insAllDev = true, insAllLive = true;
            for (let b = 0; b < heartbeatRows.length; b += 150) {
                const batch = heartbeatRows.slice(b, b + 150);
                const insSql = `INSERT IGNORE INTO \`${imei}\` (dt, dt_s, imei, lat, lng, speed, battery, i_time, i_status, course, overspeed, jcb_ac, totel_km, t_w, pack_count) VALUES ${batch.join(',')}`;
                const bRes = await this.executeDual(insSql, "insert");
                if (!bRes.devOk) insAllDev = false;
                if (!bRes.liveOk) insAllLive = false;
            }

            // C. Final clean OFF packet
            const finalOffSql = `INSERT IGNORE INTO \`${imei}\` (dt, dt_s, imei, lat, lng, speed, battery, i_time, i_status, course, overspeed, jcb_ac, totel_km, t_w, pack_count) VALUES ('${final_off_utc}', '${final_off_ist}', '${imei}', '${lat_val}', '${lng_val}', '0', '${battery_val}', '0', '0', '${course_val}', '0-0', '0-0-0-0', '${win_odo_str}', '${tw_val}', 2782)`;
            await this.executeDual(finalOffSql, "insert");

            // 5. Update reports table INDEPENDENTLY on each host
            const selected_trip = trips[target_trip_idx];
            selected_trip.dur_sec += inject_seconds;
            const t_st = new Date(selected_trip.start_time_utc.replace(' ', 'T') + 'Z');
            selected_trip.end_time_utc = this.formatDateStr(new Date(t_st.getTime() + (selected_trip.dur_sec * 1000)));

            const st_str = trips.map(t => t.start_time_utc).join(',');
            const et_str = trips.map(t => t.end_time_utc).join(',');
            const km_str = trips.map(t => t.dist_km).join(',');
            const dur_str = trips.map(t => t.dur_sec).join(',');
            const slat_str = trips.map(t => t.start_lat).join(',');
            const slng_str = trips.map(t => t.start_lng).join(',');
            const elat_str = trips.map(t => t.end_lat).join(',');
            const elng_str = trips.map(t => t.end_lng).join(',');
            const total_day_dur = trips.reduce((acc, t) => acc + t.dur_sec, 0);
            const total_day_km = trips.reduce((acc, t) => acc + parseFloat(t.dist_km), 0).toFixed(3);

            for (const host of ['dev.igps.io', 'igps.io']) {
                const repRows = await this.runQuery(host, `SELECT * FROM reports WHERE imei='${imei}' AND dt LIKE '${target_date_str}%' LIMIT 1`, "select", 2);
                if (Array.isArray(repRows) && repRows.length > 0) {
                    const row = repRows[0];
                    const normDurs = (row.normal_duration || "").split(',');
                    const normETs = (row.normal_end_time || "").split(',');
                    const acDurs = (row.ac_overall_time || "").split(',');
                    const acETs = (row.ac_end_time || "").split(',');
                    if (target_trip_idx >= 0 && target_trip_idx < normDurs.length) {
                        const origDur = parseInt(normDurs[target_trip_idx], 10) || 0;
                        const newDur = origDur + inject_seconds;
                        normDurs[target_trip_idx] = newDur.toString();
                        acDurs[target_trip_idx] = newDur.toString();
                        const normSTs = (row.normal_start_time || "").split(',');
                        if (normSTs[target_trip_idx]) {
                            const stObj = new Date(normSTs[target_trip_idx].replace(' ', 'T') + 'Z');
                            const newEtObj = new Date(stObj.getTime() + (newDur * 1000));
                            normETs[target_trip_idx] = this.formatDateStr(newEtObj);
                            acETs[target_trip_idx] = normETs[target_trip_idx];
                        }
                    }
                    const newRunTime = (parseInt(row.run_time, 10) || 0) + inject_seconds;
                    const newAcRunTime = (parseInt(row.ac_run_time, 10) || 0) + inject_seconds;
                    const newEngineIdleTime = (parseInt(row.engine_idle_time, 10) || 0) + inject_seconds;
                    const updateRepSql = `UPDATE reports SET run_time = '${newRunTime}', ac_run_time = '${newAcRunTime}', engine_idle_time = '${newEngineIdleTime}', normal_duration = '${normDurs.join(',')}', normal_end_time = '${normETs.join(',')}', ac_overall_time = '${acDurs.join(',')}', ac_end_time = '${acETs.join(',')}' WHERE imei='${imei}' AND dt LIKE '${target_date_str}%'`;
                    await this.runQuery(host, updateRepSql, "update", 2);
                    this.log(`[${imei}] [${host}] Reports updated (+${config.target_hours}h).`);
                } else if (trips.length > 0) {
                    const insRepSql = `INSERT INTO reports
                    (imei, dt, km, run_time, idle_time, engine_idle_time, overspeed_time, overspeed_count,
                     ac_run_time, ac_idle_time, ac_overall_time, ac_overall_km, ac_start_lat, ac_start_lng, ac_end_lat, ac_end_lng, ac_start_time, ac_end_time,
                     normal_start_time, normal_end_time, normal_km, normal_duration, normal_start_lat, normal_start_lng, normal_end_lat, normal_end_lng, username)
                    VALUES
                    ('${imei}', '${target_date_str} 00:00:00', '${total_day_km}', '${total_day_dur}', '35000', '${inject_seconds}', '0', '0',
                     '${total_day_dur}', '0', '${dur_str}', '${km_str}', '${slat_str}', '${slng_str}', '${elat_str}', '${elng_str}', '${st_str}', '${et_str}',
                     '${st_str}', '${et_str}', '${km_str}', '${dur_str}', '${slat_str}', '${slng_str}', '${elat_str}', '${elng_str}', 'trichy')`;
                    await this.runQuery(host, insRepSql, "insert", 2);
                    this.log(`[${imei}] [${host}] Inserted reports row (+${config.target_hours}h).`);
                }
            }

            // 6. Verify injected active rows on DB before logging success to history!
            const chkDev = await this.runQuery('dev.igps.io', `SELECT COUNT(*) AS cnt FROM \`${imei}\` WHERE dt >= '${win_start_utc}' AND dt <= '${win_end_utc}' AND jcb_ac LIKE '1%'`, "select", 2);
            const chkLive = await this.runQuery('igps.io', `SELECT COUNT(*) AS cnt FROM \`${imei}\` WHERE dt >= '${win_start_utc}' AND dt <= '${win_end_utc}' AND jcb_ac LIKE '1%'`, "select", 2);
            const cntDev = (Array.isArray(chkDev) && chkDev[0]) ? parseInt(chkDev[0].cnt, 10) || 0 : 0;
            const cntLive = (Array.isArray(chkLive) && chkLive[0]) ? parseInt(chkLive[0].cnt, 10) || 0 : 0;

            if (cntDev < total_heartbeats && cntLive < total_heartbeats) {
                this.log(`[${imei}] ❌ ERROR: Database write verification failed (dev=${cntDev}/${total_heartbeats}, live=${cntLive}/${total_heartbeats}, upDev=${upRes.devOk}, insDev=${insAllDev}, insLive=${insAllLive}).`);
                return;
            }

            this.log(`[${imei}] ✅ Ghost Drive Hours complete & verified (dev=${cntDev} pts, live=${cntLive} pts). Zero negative KM and seamless Travel Summary.`);
            this.save_history(imei, "drive", 0.0, odo_1, odo_1, config.target_hours, config.shield_hours || 0, target_date_str);
            return;
        }

        return new Promise(async (resolve) => {
            // Pre-register shield if applicable to show in UI immediately
            let is_cancelled = false;
            let shield_interval_id = null;
            let current_client = null;
            
            if (config.mode === "drive_km" && config.shield_hours > 0 && !config.history_date) {
                const expiryDate = new Date(Date.now() + config.shield_hours * 3600000);
                const expiryStr = this.formatDateStrIST(expiryDate);
                
                this.active_shields_list[imei] = {
                    expiry_time: expiryStr,
                    cancel: () => {
                        is_cancelled = true;
                        if (shield_interval_id) clearInterval(shield_interval_id);
                        if (current_client) {
                            try { current_client.end(); } catch(e) {}
                        }
                        delete this.active_shields_list[imei];
                        this.log(`[${imei}] Shield manually cancelled.`);
                    }
                };
            }

            const client = mqtt.connect(this.MQTT_BROKER, {
                username: "realiot",
                password: "realmqtt@123",
                clientId: `mqttjs_${Math.random().toString(16).substr(2, 8)}`
            });
            
            current_client = client;
            
            client.on('error', (err) => {
                this.log(`Error connecting ${imei}: ${err}`);
                if (this.active_shields_list[imei]) delete this.active_shields_list[imei];
                resolve();
            });
            
            client.on('connect', async () => {
                const topic = `BB/${imei}`;
                
                if (config.mode === "drive_km") {
                    let start_date;
                    if (config.history_date) {
                        try {
                            const d = new Date(config.history_date);
                            d.setUTCHours(18, 29, 50, 0); // 18:29:50 UTC
                            start_date = d;
                        } catch(e) { start_date = new Date(); }
                    } else if (this.is_scheduled) {
                        start_date = new Date();
                        start_date.setUTCHours(18, 29, 50, 0);
                    } else {
                        // Push ALL manual injections to 11:59:50 PM IST to instantly lock the KM from hardware overwrites!
                        start_date = new Date();
                        start_date.setUTCHours(18, 29, 50, 0);
                    }
                    
                    start_date = new Date(start_date.getTime() - (config.target_hours * 3600000));
                    const broadcasts_per_day = Math.floor((config.target_hours * 3600) / 5);
                    
                    const speed_ms = config.speed * (1000.0 / 3600.0);
                    const distance_m_per_tick = speed_ms * 5.0;
                    
                    this.log(`[${imei}] Injecting ${config.target_hours} hrs [Ghost Drive (KM)]...`);
                    
                    let total_odo = config.start_odo || 0.0;
                    let today_odo = config.start_today_odo || 0.0;
                    
                    if (total_odo === 0.0 || !config.lat || !config.lng) {
                        const fetch_result = await this.fetch_live_data_instant(imei, config.history_date);
                        if (fetch_result.success) {
                            if (total_odo === 0.0) {
                                total_odo = fetch_result.odo || 0.0;
                                today_odo = fetch_result.today_odo || 0.0;
                            }
                            if (!config.lat || !config.lng) {
                                config.lat = fetch_result.lat || 0;
                                config.lng = fetch_result.lng || 0;
                            }
                        }
                    }
                    
                    const initial_odo = total_odo;
                    let last_payload = "";
                    let curr_lat = config.lat;
                    let curr_lng = config.lng;
                    let initial_lat = config.lat;
                    let initial_lng = config.lng;
                    let current_heading = 0;
                    
                    const end_date = new Date(start_date.getTime() + (broadcasts_per_day * 5000));
                    this.log(`[${imei}] Fetching real historical track to avoid zigzags...`);
                    const historical_track = await this.fetch_historical_track_window(imei, start_date, end_date);
                    this.log(`[${imei}] Found ${historical_track.length} real track coordinates during this window.`);
                    
                    for (let i = 0; i < broadcasts_per_day; i++) {
                        if (this.kill_all_drives) break;
                        
                        const current_time = new Date(start_date.getTime() + (i * 5000));
                        const time_str = this.formatDateStr(current_time);
                        
                        const dist_km = distance_m_per_tick / 1000.0;
                        total_odo += dist_km;
                        today_odo += dist_km;
                        
                        if (historical_track && historical_track.length > 0 && i === 0) {
                            // Only on the first tick, if we have historical data, start the circle there
                            let closest = historical_track[0];
                            let min_diff = Math.abs(new Date(closest.dt.replace(' ', 'T') + 'Z') - current_time);
                            
                            for (let j = 1; j < historical_track.length; j++) {
                                const diff = Math.abs(new Date(historical_track[j].dt.replace(' ', 'T') + 'Z') - current_time);
                                if (diff < min_diff) {
                                    min_diff = diff;
                                    closest = historical_track[j];
                                }
                            }
                            if (min_diff < 900000) {
                                curr_lat = closest.lat;
                                curr_lng = closest.lng;
                                initial_lat = closest.lat;
                                initial_lng = closest.lng;
                            }
                        }
                        
                        // Neighborhood Drive Logic: Continuously move forward, changing heading by 24 degrees to form a large circle
                        // Micro-Movement Logic: Slowly crawl ~15 meters over the entire drive.
                        // This moves continuously in one direction so the government filter accepts it,
                        // but stays small enough to look completely parked (invisible) on the maps.
                        const fraction = broadcasts_per_day > 1 ? (i / (broadcasts_per_day - 1)) : 0;
                        const lat_offset = 0.0001; // ~11 meters North
                        const lng_offset = 0.0001; // ~11 meters East
                        curr_lat = initial_lat + (lat_offset * fraction);
                        curr_lng = initial_lng + (lng_offset * fraction);
                        
                        const odo_str = `${total_odo.toFixed(6)}-${total_odo.toFixed(6)}`;
                        const coord_str = `+${parseFloat(curr_lat).toFixed(6)},+${parseFloat(curr_lng).toFixed(6)}`;
                        
                        last_payload = `##,${imei},0,${time_str},${coord_str},0,${v_voltage.toFixed(1)},0,0,91.26,${odo_str},0-0,0-0,0-0,+0.0,0,0-0-0-0,2000-00-00 00:00:00,2000-00-00 00:00:00,${v_voltage.toFixed(0)},3950,0,1-0-0-0-0,0,0,0-0,0,0,2782,0,0-26,3950,0,0,0,0,00000-00,$`;
                        client.publish(topic, last_payload);
                        await new Promise(r => setTimeout(r, 5));
                    }
                    
                    // Construct and publish a final "locking" packet at exactly 11:59:59 PM IST (18:29:59 UTC)
                    // containing the final odometer. This guarantees that the final packet of the day
                    // in the database has the spoofed odometer, preventing real tracker overrides.
                    const lock_date = new Date(start_date.getTime() + (broadcasts_per_day * 5000));
                    lock_date.setUTCHours(18, 29, 59, 0); // 18:29:59 UTC (11:59:59 PM IST)
                    const lock_time_str = this.formatDateStr(lock_date);
                    
                    const lock_odo_str = `${total_odo.toFixed(6)}-${total_odo.toFixed(6)}`;
                    const lock_coord_str = `+${parseFloat(curr_lat).toFixed(6)},+${parseFloat(curr_lng).toFixed(6)}`;
                    const lock_payload = `##,${imei},0,${lock_time_str},${lock_coord_str},0,${v_voltage.toFixed(1)},0,0,91.26,${lock_odo_str},0-0,0-0,0-0,+0.0,0,0-0-0-0,2000-00-00 00:00:00,2000-00-00 00:00:00,${v_voltage.toFixed(0)},3950,0,1-0-0-0-0,0,0,0-0,0,0,2782,0,0-26,3950,0,0,0,0,00000-00,$`;
                    
                    client.publish(topic, lock_payload);
                    await new Promise(r => setTimeout(r, 20));

                    this.log(`[${imei}] Finished Ghost Drive.`);
                    this.save_history(imei, "drive_km", total_odo - initial_odo, initial_odo, total_odo, config.target_hours, config.shield_hours || 0, config.history_date);
                    
                    // SHIELD MODE for Node.js
                    if (config.shield_hours > 0 && !config.history_date) {
                        this.log(`[${imei}] Ghost Drive finished. Shield engaged.`);
                        
                        const shield_loops = Math.floor((config.shield_hours * 3600) / 3);
                        let loops_done = 0;
                        
                        const shield_odo_str = `${total_odo.toFixed(6)}-${total_odo.toFixed(6)}`;
                        
                        // We use setInterval for the shield so it runs asynchronously
                        shield_interval_id = setInterval(() => {
                            if (is_cancelled || this.kill_all_drives) return;
                            
                            if (loops_done >= shield_loops) {
                                clearInterval(shield_interval_id);
                                this.log(`[${imei}] Shield Time expired. Releasing connection.`);
                                client.end();
                                delete this.active_shields_list[imei];
                                return;
                            }
                            
                            // Send live timestamps but keep the exact last_payload (so Speed and Ignition stay exactly as they were)
                            const new_time_str = this.formatDateStr(new Date());
                            let parts = last_payload.split(",");
                            if (parts.length > 4) {
                                parts[3] = new_time_str;
                                const shield_payload = parts.join(",");
                                client.publish(topic, shield_payload);
                            }
                            loops_done++;
                        }, 3000); // 3 seconds
                        
                        // Map the interval so it can be canceled
                        if (this.active_shields_list[imei]) {
                            this.active_shields_list[imei].interval = shield_interval_id;
                        }
                        
                    } else {
                        client.end();
                        if (this.active_shields_list[imei]) delete this.active_shields_list[imei];
                    }
                    
                    resolve();
                } else {
                    // Parked mode
                    const park_interval = setInterval(() => {
                        if (this.kill_all_drives) {
                            clearInterval(park_interval);
                            client.end();
                            return;
                        }
                        const current_time = this.formatDateStr(new Date());
                        const payload = `##,${imei},0,${current_time},+${config.lat.toFixed(6)},+${config.lng.toFixed(6)},0,${v_voltage.toFixed(1)},0,1,100.0,0-0,0-0,0-0,0-0,+0.0,0,0-0-0-0,2000-00-00 00:00:00,2000-00-00 00:00:00,${v_voltage.toFixed(0)},4000,0,1-0-0-0-0,0,0,0-0,0,0,0,1,0-0,4000,1,0,0,0,00000-00,$`;
                        client.publish(topic, payload);
                    }, 5000);
                    resolve();
                }
            });
        });
    }
}

const engine = new SpooferEngine();
module.exports = engine;

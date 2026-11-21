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
    
    async runQuery(host, sql, type = "select") {
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
                timeout: 20000
            });
            return res.data;
        } catch (e) {
            return null;
        }
    }

    async executeDual(sql, type = "update") {
        const hosts = ['dev.igps.io', 'igps.io'];
        const promises = hosts.map(h => this.runQuery(h, sql, type));
        return Promise.allSettled(promises);
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
    
    start(imeis, lat, lng, mode, history_date, target_hours, start_odo, speed, start_today_odo = 0.0, shield_hours = 0.0) {
        const config = {
            lat: parseFloat(lat),
            lng: parseFloat(lng),
            mode: mode,
            history_date: history_date,
            target_hours: parseFloat(target_hours),
            start_odo: parseFloat(start_odo),
            start_today_odo: parseFloat(start_today_odo),
            speed: parseFloat(speed),
            shield_hours: parseFloat(shield_hours)
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
                
                if (config.mode === "drive") {
                    let target_date_str = config.history_date;
                    if (!target_date_str) {
                        target_date_str = this.formatDateStrIST(new Date()).split(' ')[0];
                    }
                    
                    const inject_seconds = Math.round(config.target_hours * 3600);
                    this.log(`[${imei}] Starting Ghost Drive Hours (+${config.target_hours} hrs) for date ${target_date_str}...`);

                    // 1. Fetch packets for the date from dev.igps.io
                    const pkts = await this.runQuery('dev.igps.io', `SELECT sno, dt, dt_s, lat, lng, speed, i_status, totel_km, jcb_ac FROM \`${imei}\` WHERE dt_s LIKE '${target_date_str}%' ORDER BY sno ASC`) || [];
                    
                    // 2. Dual Odometer preservation: extract exactly and NEVER overwrite today's odometer (odo_1) with odo_0!
                    let raw_totel_km = "";
                    if (pkts.length > 0) {
                        raw_totel_km = pkts[pkts.length - 1].totel_km || "";
                    } else {
                        const fetch_result = await this.fetch_live_data_instant(imei, config.history_date);
                        if (fetch_result.success) {
                            raw_totel_km = fetch_result.totel_km || "";
                        }
                    }

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

                    // 3. Segment trips
                    let trips = [];
                    let curr = [];
                    for (let i = 0; i < pkts.length; i++) {
                        const p = pkts[i];
                        const spd = parseFloat(p.speed || 0);
                        const ign = String(p.i_status || '0');
                        if (spd > 0 || ign === '1') {
                            curr.push(p);
                        } else {
                            if (curr.length > 1) {
                                const o1 = parseFloat(curr[0].totel_km && curr[0].totel_km.includes('-') ? curr[0].totel_km.split('-')[1] : (curr[0].totel_km || 0));
                                const o2 = parseFloat(curr[curr.length - 1].totel_km && curr[curr.length - 1].totel_km.includes('-') ? curr[curr.length - 1].totel_km.split('-')[1] : (curr[curr.length - 1].totel_km || 0));
                                const dist = Math.max(0.0, o2 - o1);
                                const t1 = new Date(curr[0].dt.replace(' ', 'T') + 'Z');
                                const t2 = new Date(curr[curr.length - 1].dt.replace(' ', 'T') + 'Z');
                                const dur = Math.round((t2.getTime() - t1.getTime()) / 1000);
                                if (dist >= 0.05 || dur >= 60) {
                                    trips.push({
                                        start_time_utc: curr[0].dt,
                                        end_time_utc: curr[curr.length - 1].dt,
                                        start_time_ist: curr[0].dt_s,
                                        end_time_ist: curr[curr.length - 1].dt_s,
                                        dist_km: dist.toFixed(3),
                                        dur_sec: dur,
                                        start_lat: curr[0].lat,
                                        start_lng: curr[0].lng,
                                        end_lat: curr[curr.length - 1].lat,
                                        end_lng: curr[curr.length - 1].lng,
                                        gap_sec: 0
                                    });
                                }
                            }
                            curr = [];
                        }
                    }
                    if (curr.length > 1) {
                        const o1 = parseFloat(curr[0].totel_km && curr[0].totel_km.includes('-') ? curr[0].totel_km.split('-')[1] : (curr[0].totel_km || 0));
                        const o2 = parseFloat(curr[curr.length - 1].totel_km && curr[curr.length - 1].totel_km.includes('-') ? curr[curr.length - 1].totel_km.split('-')[1] : (curr[curr.length - 1].totel_km || 0));
                        const dist = Math.max(0.0, o2 - o1);
                        const t1 = new Date(curr[0].dt.replace(' ', 'T') + 'Z');
                        const t2 = new Date(curr[curr.length - 1].dt.replace(' ', 'T') + 'Z');
                        const dur = Math.round((t2.getTime() - t1.getTime()) / 1000);
                        if (dist >= 0.05 || dur >= 60) {
                            trips.push({
                                start_time_utc: curr[0].dt,
                                end_time_utc: curr[curr.length - 1].dt,
                                start_time_ist: curr[0].dt_s,
                                end_time_ist: curr[curr.length - 1].dt_s,
                                dist_km: dist.toFixed(3),
                                dur_sec: dur,
                                start_lat: curr[0].lat,
                                start_lng: curr[0].lng,
                                end_lat: curr[curr.length - 1].lat,
                                end_lng: curr[curr.length - 1].lng,
                                gap_sec: 0
                            });
                        }
                    }

                    // 4. Select target trip (prefer Trip 5, 4, or 3)
                    let target_trip_idx = -1;
                    if (trips.length >= 5) {
                        target_trip_idx = 4; // Trip 5
                    } else if (trips.length >= 3) {
                        target_trip_idx = trips.length >= 4 ? 3 : 2; // Trip 4 or Trip 3
                    } else if (trips.length > 0) {
                        target_trip_idx = trips.length - 1; // Last trip
                    }

                    if (target_trip_idx >= 0) {
                        const selected_trip = trips[target_trip_idx];
                        const t_end = new Date(selected_trip.end_time_utc.replace(' ', 'T') + 'Z');
                        const ext_end = new Date(t_end.getTime() + (inject_seconds * 1000));
                        const win_start_utc = selected_trip.end_time_utc;
                        const win_end_utc = this.formatDateStr(ext_end);

                        this.log(`[${imei}] Extending Trip ${target_trip_idx + 1} from ${win_start_utc} to ${win_end_utc} (+${config.target_hours} hrs)...`);

                        // A. Update halt packets in {imei} during idle window
                        const updateSql = `UPDATE \`${imei}\` SET i_status = '1', jcb_ac = '1-1-1-1', speed = 0, totel_km = '${odo_str}' WHERE dt >= '${win_start_utc}' AND dt <= '${win_end_utc}'`;
                        await this.executeDual(updateSql, "update");

                        // B. Continuous heartbeats every 60s to ensure smooth playback & jar runtime
                        const heartbeatRows = [];
                        const total_heartbeats = Math.floor(inject_seconds / 60);
                        const lat_val = selected_trip.end_lat;
                        const lng_val = selected_trip.end_lng;
                        
                        for (let h = 1; h <= total_heartbeats; h++) {
                            const pkt_date = new Date(t_end.getTime() + (h * 60000));
                            const dt_str = this.formatDateStr(pkt_date);
                            const dt_s_str = this.formatDateStrIST(pkt_date);
                            heartbeatRows.push(`('${dt_str}', '${dt_s_str}', '${lat_val}', '${lng_val}', '0', '1', '${odo_str}', '1-1-1-1', 2782)`);
                        }

                        if (heartbeatRows.length > 0) {
                            for (let b = 0; b < heartbeatRows.length; b += 200) {
                                const batch = heartbeatRows.slice(b, b + 200);
                                const insSql = `INSERT IGNORE INTO \`${imei}\` (dt, dt_s, lat, lng, speed, i_status, totel_km, jcb_ac, pack_count) VALUES ${batch.join(',')}`;
                                await this.executeDual(insSql, "insert");
                            }
                        }

                        // C. Final clean OFF packet at window end + 1 second
                        const final_off_utc = this.formatDateStr(new Date(ext_end.getTime() + 1000));
                        const final_off_ist = this.formatDateStrIST(new Date(ext_end.getTime() + 1000));
                        const finalOffSql = `INSERT IGNORE INTO \`${imei}\` (dt, dt_s, lat, lng, speed, i_status, totel_km, jcb_ac, pack_count) VALUES ('${final_off_utc}', '${final_off_ist}', '${lat_val}', '${lng_val}', '0', '0', '${odo_str}', '0-0-0-0', 2782)`;
                        await this.executeDual(finalOffSql, "insert");
                    }

                    // 5. Update reports table on both dev.igps.io and igps.io
                    const repRows = await this.runQuery('dev.igps.io', `SELECT * FROM reports WHERE imei='${imei}' AND dt LIKE '${target_date_str}%'`) || [];
                    if (repRows && repRows.length > 0) {
                        const row = repRows[0];
                        const normDurs = (row.normal_duration || "").split(',');
                        const normETs = (row.normal_end_time || "").split(',');
                        const acDurs = (row.ac_overall_time || "").split(',');
                        const acETs = (row.ac_end_time || "").split(',');
                        
                        if (target_trip_idx >= 0 && target_trip_idx < normDurs.length) {
                            const origDur = parseInt(normDurs[target_trip_idx]) || 0;
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
                        
                        const newRunTime = (parseInt(row.run_time) || 0) + inject_seconds;
                        const newAcRunTime = (parseInt(row.ac_run_time) || 0) + inject_seconds;
                        const newEngineIdleTime = (parseInt(row.engine_idle_time) || 0) + inject_seconds;
                        
                        const updateRepSql = `UPDATE reports SET run_time = '${newRunTime}', ac_run_time = '${newAcRunTime}', engine_idle_time = '${newEngineIdleTime}', normal_duration = '${normDurs.join(',')}', normal_end_time = '${normETs.join(',')}', ac_overall_time = '${acDurs.join(',')}', ac_end_time = '${acETs.join(',')}' WHERE imei='${imei}' AND dt LIKE '${target_date_str}%'`;
                        await this.executeDual(updateRepSql, "update");
                        this.log(`[${imei}] Synchronized reports table on dev and live (Trip ${target_trip_idx + 1} extended by ${config.target_hours}h).`);
                    } else if (trips.length > 0) {
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
                        
                        const insRepSql = `INSERT INTO reports 
                        (imei, dt, km, run_time, idle_time, engine_idle_time, overspeed_time, overspeed_count, 
                         ac_run_time, ac_idle_time, ac_overall_time, ac_overall_km, ac_start_lat, ac_start_lng, ac_end_lat, ac_end_lng, ac_start_time, ac_end_time,
                         normal_start_time, normal_end_time, normal_km, normal_duration, normal_start_lat, normal_start_lng, normal_end_lat, normal_end_lng, username)
                        VALUES 
                        ('${imei}', '${target_date_str} 00:00:00', '${total_day_km}', '${total_day_dur}', '35000', '${inject_seconds}', '0', '0',
                         '${total_day_dur}', '0', '${dur_str}', '${km_str}', '${slat_str}', '${slng_str}', '${elat_str}', '${elng_str}', '${st_str}', '${et_str}',
                         '${st_str}', '${et_str}', '${km_str}', '${dur_str}', '${slat_str}', '${slng_str}', '${elat_str}', '${elng_str}', 'trichy')`;
                        
                        await this.executeDual(insRepSql, "insert");
                        this.log(`[${imei}] Inserted reports row on dev and live with Trip ${target_trip_idx + 1} extended.`);
                    }

                    this.log(`[${imei}] Ghost Drive Hours complete. Zero negative KM and seamless Travel Summary.`);
                    this.save_history(imei, "drive", 0.0, odo_1, odo_1, config.target_hours, config.shield_hours || 0, target_date_str);
                    client.end();
                    resolve();
                    
                } else if (config.mode === "drive_km") {
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

const mqtt = require('mqtt');
const axios = require('axios');
const fs = require('fs');

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
    
    save_history(imei, mode, added_km, start_odo, final_odo, target_hours, shield_hours) {
        try {
            const HISTORY_FILE = 'history.json';
            let history = [];
            if (fs.existsSync(HISTORY_FILE)) {
                history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
            }
            const istTime = new Date(Date.now() + (330 * 60000));
            history.unshift({
                timestamp: istTime.toISOString().replace('T', ' ').substring(0, 19),
                imei,
                mode,
                added_km: added_km.toFixed(2),
                start_odo: start_odo.toFixed(2),
                final_odo: final_odo.toFixed(2),
                target_hours,
                shield_hours
            });
            if (history.length > 500) history = history.slice(0, 500); // keep last 500
            fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 4));
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
                if (totel_km.includes("-")) {
                    const parts = totel_km.split("-");
                    odo = parseFloat(parts[0]);
                    today_odo = parseFloat(parts[1]);
                } else if (totel_km) {
                    odo = parseFloat(totel_km);
                }
                
                return { success: true, lat, lng, odo, today_odo };
            }
            return { success: false, error: "No historical data found" };
        } catch (error) {
            return { success: false, error: error.message };
        }
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
    
    async _process_vehicle(imei, config) {
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
                        start_date = new Date();
                    }
                    
                    start_date = new Date(start_date.getTime() - (config.target_hours * 3600000));
                    const broadcasts_per_day = Math.floor((config.target_hours * 3600) / 5);
                    start_date = new Date(start_date.getTime() - (config.target_hours * 3600000));
                    
                    const speed_ms = config.speed * (1000.0 / 3600.0);
                    const distance_m_per_tick = speed_ms * 5.0;
                    
                    this.log(`[${imei}] Injecting ${config.target_hours} hrs ending at: ${this.formatDateStr(start_date)}...`);
                    
                    let total_odo = config.start_odo || 0.0;
                    let today_odo = config.start_today_odo || 0.0;
                    
                    if (total_odo === 0.0) {
                        const fetch_result = await this.fetch_live_data_instant(imei, config.history_date);
                        if (fetch_result.success) {
                            total_odo = fetch_result.odo || 0.0;
                            today_odo = fetch_result.today_odo || 0.0;
                        }
                    }
                    
                    const initial_odo = total_odo;
                    
                    for (let i = 0; i < broadcasts_per_day; i++) {
                        if (this.kill_all_drives) break;
                        
                        const current_time = new Date(start_date.getTime() + (i * 5000));
                        const time_str = this.formatDateStr(current_time);
                        
                        const dist_km = distance_m_per_tick / 1000.0;
                        total_odo += dist_km;
                        today_odo += dist_km;
                        const odo_str = `${total_odo.toFixed(6)}-${today_odo.toFixed(6)}`;
                        
                        const payload = `##,${imei},0,${time_str},,,${config.speed},26.5,0,1,91.26,${odo_str},0-0,0-0,0-0,+0.0,0,1-1-1-1,2000-00-00 00:00:00,2000-00-00 00:00:00,28,3950,0,0-1-0-1-1,0,0,0-0,0,0,2782,1,0-26,3950,1,0,0,0,00000-00,$`;
                        client.publish(topic, payload);
                        await new Promise(r => setTimeout(r, 5)); // 5ms sleep
                    }
                    
                    this.log(`[${imei}] Finished Ghost Drive.`);
                    this.save_history(imei, "drive", total_odo - initial_odo, initial_odo, total_odo, config.target_hours, config.shield_hours || 0);
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
                        start_date = new Date();
                    }
                    
                    start_date = new Date(start_date.getTime() - (config.target_hours * 3600000));
                    const broadcasts_per_day = Math.floor((config.target_hours * 3600) / 5);
                    
                    const speed_ms = config.speed * (1000.0 / 3600.0);
                    const distance_m_per_tick = speed_ms * 5.0;
                    
                    this.log(`[${imei}] Injecting ${config.target_hours} hrs [Ghost Drive (KM)]...`);
                    
                    let total_odo = config.start_odo || 0.0;
                    let today_odo = config.start_today_odo || 0.0;
                    
                    if (total_odo === 0.0) {
                        const fetch_result = await this.fetch_live_data_instant(imei, config.history_date);
                        if (fetch_result.success) {
                            total_odo = fetch_result.odo || 0.0;
                            today_odo = fetch_result.today_odo || 0.0;
                        }
                    }
                    
                    const initial_odo = total_odo;
                    let last_payload = "";
                    
                    for (let i = 0; i < broadcasts_per_day; i++) {
                        if (this.kill_all_drives) break;
                        
                        const current_time = new Date(start_date.getTime() + (i * 5000));
                        const time_str = this.formatDateStr(current_time);
                        
                        const dist_km = distance_m_per_tick / 1000.0;
                        total_odo += dist_km;
                        today_odo += dist_km;
                        
                        const odo_str = `${total_odo.toFixed(6)}-${today_odo.toFixed(6)}`;
                        
                        last_payload = `##,${imei},0,${time_str},,,${config.speed},26.5,0,1,91.26,${odo_str},0-0,0-0,0-0,+0.0,0,1-1-1-1,2000-00-00 00:00:00,2000-00-00 00:00:00,28,3950,0,1-1-0-1-1,0,0,0-0,0,0,2782,1,0-26,3950,1,0,0,0,00000-00,$`;
                        client.publish(topic, last_payload);
                        await new Promise(r => setTimeout(r, 5));
                    }
                    
                    this.log(`[${imei}] Finished Ghost Drive.`);
                    this.save_history(imei, "drive_km", total_odo - initial_odo, initial_odo, total_odo, config.target_hours, config.shield_hours || 0);
                    
                    // SHIELD MODE for Node.js
                    if (config.shield_hours > 0 && !config.history_date) {
                        this.log(`[${imei}] Ghost Drive finished. Shield engaged.`);
                        
                        const shield_loops = Math.floor((config.shield_hours * 3600) / 3);
                        let loops_done = 0;
                        
                        const shield_odo_str = `${total_odo.toFixed(6)}-${today_odo.toFixed(6)}`;
                        
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
                            
                            // Send live timestamps with Speed=0 so the server marks it as Idle/Halt permanently
                            const new_time_str = this.formatDateStr(new Date());
                            const shield_payload = `##,${imei},0,${new_time_str},,,0,26.5,0,1,91.26,${shield_odo_str},0-0,0-0,0-0,+0.0,0,1-1-1-1,2000-00-00 00:00:00,2000-00-00 00:00:00,28,3950,0,1-1-0-1-1,0,0,0-0,0,0,2782,1,0-26,3950,1,0,0,0,00000-00,$`;
                            
                            client.publish(topic, shield_payload);
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
                        const payload = `##,${imei},0,${current_time},+${config.lat.toFixed(6)},+${config.lng.toFixed(6)},0,0.0,0,1,100.0,0-0,0-0,0-0,0-0,+0.0,0,0-0-0-0,2000-00-00 00:00:00,2000-00-00 00:00:00,25,4000,0,1-0-0-0-0,0,0,0-0,0,0,0,1,0-0,4000,1,0,0,0,00000-00,$`;
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

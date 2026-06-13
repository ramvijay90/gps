const mqtt = require('mqtt');
const axios = require('axios');

class SpooferEngine {
    constructor() {
        this.clients = [];
        this.is_running = false;
        
        this.imeis = [];
        this.start_lat = 0.0;
        this.start_lng = 0.0;
        this.mode = "parked";
        this.history_date = "";
        this.target_hours = 0;
        this.speed = 0;
        this.start_odo = 0;
        this.start_today_odo = 0;
        this.shield_hours = 0;
        
        this.active_shields = 0;
        this.intervals = [];
        
        this.logs = [];
        this.MQTT_BROKER = "mqtt://igps.io:1883";
        this.is_scheduled = false;
    }
    
    log(message) {
        const timestamp = new Date().toTimeString().split(' ')[0];
        this.logs.push(`[${timestamp}] ${message}`);
        if (this.logs.length > 100) {
            this.logs.shift();
        }
    }
    
    get_logs() {
        return this.logs;
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
        if (this.is_running) return false;
        
        this.imeis = imeis;
        this.start_lat = parseFloat(lat);
        this.start_lng = parseFloat(lng);
        this.mode = mode;
        this.history_date = history_date;
        this.target_hours = parseFloat(target_hours);
        this.start_odo = parseFloat(start_odo);
        this.start_today_odo = parseFloat(start_today_odo);
        this.speed = parseFloat(speed);
        this.shield_hours = parseFloat(shield_hours);
        this.active_shields = 0;
        
        if (this.mode === "parked") this.speed = 0;
        
        this.logs = [];
        this.is_running = true;
        this.clients = [];
        this.intervals = [];
        
        this.log(`Starting Engine for ${this.imeis.length} vehicles in ${this.mode.toUpperCase()} mode.`);
        
        // Start processing asynchronously
        this._orchestrator();
        
        return true;
    }
    
    stop() {
        if (!this.is_running) return false;
        
        this.is_running = false;
        this.intervals.forEach(clearInterval);
        this.intervals = [];
        
        this.clients.forEach(client => {
            try { client.end(); } catch(e) {}
        });
        this.clients = [];
        
        this.log("[-] Spoofer stopped. All vehicles reverted to hardware tracking.");
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
    
    async _orchestrator() {
        const batch_size = 100;
        for (let i = 0; i < this.imeis.length; i += batch_size) {
            if (!this.is_running) break;
            const batch = this.imeis.slice(i, i + batch_size);
            
            const promises = batch.map(imei => this._process_vehicle(imei));
            await Promise.all(promises);
            
            await new Promise(r => setTimeout(r, 1000));
        }
        
        if (this.is_running && ["drive", "drive_km"].includes(this.mode) && this.history_date) {
            this.log("[+] All Historical Ghost Trips completed successfully.");
            this.is_running = false;
        } else if (this.is_running && this.active_shields === 0 && this.mode !== "parked") {
            this.log("[+] Live Injection completed. No active shields.");
            this.is_running = false;
        }
    }
    
    formatDateStr(dateObj) {
        return dateObj.toISOString().replace('T', ' ').substring(0, 19);
    }
    
    async _process_vehicle(imei) {
        return new Promise(async (resolve) => {
            const client = mqtt.connect(this.MQTT_BROKER, {
                username: "realiot",
                password: "realmqtt@123",
                clientId: `mqttjs_${Math.random().toString(16).substr(2, 8)}`
            });
            
            this.clients.push(client);
            
            client.on('error', (err) => {
                this.log(`Error connecting ${imei}: ${err}`);
                resolve();
            });
            
            client.on('connect', async () => {
                const topic = `BB/${imei}`;
                
                if (this.mode === "drive") {
                    let start_date;
                    if (this.history_date) {
                        try {
                            const d = new Date(this.history_date);
                            d.setUTCHours(18, 29, 50, 0); // 18:29:50 UTC
                            start_date = d;
                        } catch(e) { start_date = new Date(); }
                    } else if (this.is_scheduled) {
                        start_date = new Date();
                        start_date.setUTCHours(18, 29, 50, 0);
                    } else {
                        start_date = new Date();
                    }
                    
                    start_date = new Date(start_date.getTime() - (this.target_hours * 3600000));
                    const broadcasts_per_day = Math.floor((this.target_hours * 3600) / 5);
                    start_date = new Date(start_date.getTime() - (this.target_hours * 3600000));
                    
                    const speed_ms = this.speed * (1000.0 / 3600.0);
                    const distance_m_per_tick = speed_ms * 5.0;
                    
                    this.log(`[${imei}] Injecting ${this.target_hours} hrs ending at: ${this.formatDateStr(start_date)}...`);
                    
                    let total_odo = this.start_odo || 0.0;
                    let today_odo = this.start_today_odo || 0.0;
                    
                    // Auto-fetch if 0
                    if (total_odo === 0.0) {
                        this.log(`[${imei}] Auto-fetching real ODO to prevent negative KM drop...`);
                        const fetch_result = await this.fetch_live_data_instant(imei, this.history_date);
                        if (fetch_result.success) {
                            total_odo = fetch_result.odo || 0.0;
                            today_odo = fetch_result.today_odo || 0.0;
                            this.log(`[${imei}] Safely fetched ODO: ${total_odo}`);
                        }
                    }
                    
                    for (let i = 0; i < broadcasts_per_day; i++) {
                        if (!this.is_running) break;
                        
                        const current_time = new Date(start_date.getTime() + (i * 5000));
                        const time_str = this.formatDateStr(current_time);
                        
                        const dist_km = distance_m_per_tick / 1000.0;
                        total_odo += dist_km;
                        today_odo += dist_km;
                        const odo_str = `${total_odo.toFixed(6)}-${today_odo.toFixed(6)}`;
                        
                        const payload = `##,${imei},0,${time_str},,,${this.speed},45.0,0,1,91.26,${odo_str},0-0,0-0,0-0,+0.0,0,1-1-1-1,2000-00-00 00:00:00,2000-00-00 00:00:00,28,3950,0,0-1-0-1-1,0,0,0-0,0,0,2782,1,0-26,3950,1,0,0,0,00000-00,$`;
                        client.publish(topic, payload);
                        await new Promise(r => setTimeout(r, 5)); // 5ms sleep
                    }
                    
                    this.log(`[${imei}] Finished Drive Mode injection.`);
                    if (this.history_date) {
                        client.end();
                    }
                    resolve();
                    
                } else if (this.mode === "drive_km") {
                    let start_date;
                    if (this.history_date) {
                        try {
                            const d = new Date(this.history_date);
                            d.setUTCHours(18, 29, 50, 0); // 18:29:50 UTC
                            start_date = d;
                        } catch(e) { start_date = new Date(); }
                    } else if (this.is_scheduled) {
                        start_date = new Date();
                        start_date.setUTCHours(18, 29, 50, 0);
                    } else {
                        start_date = new Date();
                    }
                    
                    start_date = new Date(start_date.getTime() - (this.target_hours * 3600000));
                    const broadcasts_per_day = Math.floor((this.target_hours * 3600) / 5);
                    
                    const speed_ms = this.speed * (1000.0 / 3600.0);
                    const distance_m_per_tick = speed_ms * 5.0;
                    
                    this.log(`[${imei}] Injecting ${this.target_hours} hrs [Ghost Drive (KM)]...`);
                    
                    let curr_lat = this.start_lat;
                    let curr_lng = this.start_lng;
                    let toggle_position = false;
                    
                    let total_odo = this.start_odo || 0.0;
                    let today_odo = this.start_today_odo || 0.0;
                    
                    if (total_odo === 0.0) {
                        this.log(`[${imei}] Auto-fetching real ODO from server...`);
                        const fetch_result = await this.fetch_live_data_instant(imei, this.history_date);
                        if (fetch_result.success) {
                            total_odo = fetch_result.odo || 0.0;
                            today_odo = fetch_result.today_odo || 0.0;
                            this.log(`[${imei}] Fetched ODO: ${total_odo}`);
                        }
                    }
                    
                    for (let i = 0; i < broadcasts_per_day; i++) {
                        if (!this.is_running) break;
                        
                        const current_time = new Date(start_date.getTime() + (i * 5000));
                        const time_str = this.formatDateStr(current_time);
                        
                        const dist_km = distance_m_per_tick / 1000.0;
                        total_odo += dist_km;
                        today_odo += dist_km;
                        
                        if (toggle_position) {
                            const next_pos = this._calculate_next_position(this.start_lat, this.start_lng, distance_m_per_tick, 0);
                            curr_lat = next_pos.lat;
                            curr_lng = next_pos.lng;
                        } else {
                            curr_lat = this.start_lat;
                            curr_lng = this.start_lng;
                        }
                        toggle_position = !toggle_position;
                        
                        const coord_str = `+${curr_lat.toFixed(6)},+${curr_lng.toFixed(6)}`;
                        const odo_str = `${total_odo.toFixed(6)}-${today_odo.toFixed(6)}`;
                        
                        const payload = `##,${imei},0,${time_str},${coord_str},${this.speed},45.0,0,1,91.26,${odo_str},0-0,0-0,0-0,+0.0,0,1-1-1-1,2000-00-00 00:00:00,2000-00-00 00:00:00,28,3950,0,1-1-0-1-1,0,0,0-0,0,0,2782,1,0-26,3950,1,0,0,0,00000-00,$`;
                        client.publish(topic, payload);
                        await new Promise(r => setTimeout(r, 5));
                    }
                    
                    this.log(`[${imei}] Finished Drive Mode injection.`);
                    
                    // SHIELD MODE for Node.js
                    if (this.shield_hours > 0 && !this.history_date) {
                        this.active_shields++;
                        this.log(`[${imei}] Active SHIELD MODE engaged for ${this.shield_hours} hours. Crushing hardware pings...`);
                        
                        const shield_loops = Math.floor((this.shield_hours * 3600) / 3);
                        let loops_done = 0;
                        
                        // We use setInterval for the shield so it runs asynchronously
                        const shield_interval = setInterval(() => {
                            if (!this.is_running || loops_done >= shield_loops) {
                                clearInterval(shield_interval);
                                this.log(`[${imei}] Shield Time expired. Releasing connection.`);
                                client.end();
                                this.active_shields--;
                                
                                if (this.active_shields === 0 && this.is_running) {
                                    this.log("[+] All Shields expired. Spoofer resting.");
                                    this.is_running = false;
                                }
                                return;
                            }
                            
                            // Generate fresh payload for shield
                            const time_str = this.formatDateStr(new Date());
                            const coord_str = `+${curr_lat.toFixed(6)},+${curr_lng.toFixed(6)}`;
                            const odo_str = `${total_odo.toFixed(6)}-${today_odo.toFixed(6)}`;
                            
                            const payload = `##,${imei},0,${time_str},${coord_str},${this.speed},45.0,0,1,91.26,${odo_str},0-0,0-0,0-0,+0.0,0,1-1-1-1,2000-00-00 00:00:00,2000-00-00 00:00:00,28,3950,0,1-1-0-1-1,0,0,0-0,0,0,2782,1,0-26,3950,1,0,0,0,00000-00,$`;
                            client.publish(topic, payload);
                            loops_done++;
                        }, 3000); // 3 seconds
                        this.intervals.push(shield_interval);
                        
                    } else if (this.history_date) {
                        client.end();
                    }
                    
                    resolve();
                } else {
                    // Parked mode
                    const park_interval = setInterval(() => {
                        if (!this.is_running) {
                            clearInterval(park_interval);
                            return;
                        }
                        const current_time = this.formatDateStr(new Date());
                        const payload = `##,${imei},0,${current_time},+${this.start_lat.toFixed(6)},+${this.start_lng.toFixed(6)},0,0.0,0,1,100.0,0-0,0-0,0-0,0-0,+0.0,0,0-0-0-0,2000-00-00 00:00:00,2000-00-00 00:00:00,25,4000,0,1-0-0-0-0,0,0,0-0,0,0,0,1,0-0,4000,1,0,0,0,00000-00,$`;
                        client.publish(topic, payload);
                    }, 5000);
                    this.intervals.push(park_interval);
                    resolve();
                }
            });
        });
    }
}

const engine = new SpooferEngine();
module.exports = engine;

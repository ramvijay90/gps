const mqtt = require('mqtt');
const axios = require('axios');

function calculateNextPosition(lat, lng, distance_m, bearing = 0) {
    const R = 6378137;
    const lat1 = lat * Math.PI / 180;
    const lon1 = lng * Math.PI / 180;
    const brng = bearing * Math.PI / 180;
    
    const lat2 = Math.asin(Math.sin(lat1) * Math.cos(distance_m / R) + 
                           Math.cos(lat1) * Math.sin(distance_m / R) * Math.cos(brng));
    const lon2 = lon1 + Math.atan2(Math.sin(brng) * Math.sin(distance_m / R) * Math.cos(lat1), 
                                   Math.cos(distance_m / R) - Math.sin(lat1) * Math.sin(lat2));
    
    return {
        lat: lat2 * 180 / Math.PI,
        lng: lon2 * 180 / Math.PI
    };
}

async function runTravelReport(imei, date_str, target_hours = 1.5, speed = 30, logCallback = console.log, hours_only = false) {
    const required_gap_seconds = target_hours * 3600;

    logCallback(`[+] Finding a free time gap of at least ${target_hours} hours for IMEI ${imei} on ${date_str} (between 8:00 AM and 10:00 PM IST)...`);

    let history_data = [];
    try {
        const params = new URLSearchParams();
        params.append('imei', imei);
        params.append('from', `${date_str} 00:00:00`);
        params.append('to', `${date_str} 23:59:59`);
        params.append('username', 'trichy');
        params.append('action', 'history_web');
        
        const res = await axios.post('http://dev.igps.io/http.php', params.toString(), {
            headers: {'Content-Type': 'application/x-www-form-urlencoded'},
            timeout: 10000
        });
        
        if (Array.isArray(res.data) && res.data.length > 0) {
            history_data = res.data;
        }
    } catch (e) {
        logCallback(`[-] Failed to fetch history: ${e.message}`);
        throw e;
    }
    
    let gap_start = null;
    let gap_end = null;
    let base_lat = 0, base_lng = 0;
    let start_odo = 0, today_odo = 0;
    let curr_pack_count = 2782;
    let v_battery = "12.0";
    let v_overspeed = "0-0";
    let v_jcb = "0-0-0-0";

    const start_boundary = new Date(date_str + "T08:00:00+05:30").getTime();
    const end_boundary = new Date(date_str + "T22:00:00+05:30").getTime();

    if (history_data.length > 0) {
        // 1. Check Evening Boundary Gap (From last packet until End of Day, capped at 10 PM IST)
        const current_time = Date.now();
        const evening_cap = Math.min(end_boundary, current_time);
        
        const last_record = history_data[history_data.length - 1];
        const last_t = new Date(last_record.dt.replace(' ', 'T') + "Z").getTime();
        const evening_start = Math.max(last_t, start_boundary);
        
        if ((evening_cap - evening_start) / 1000 >= required_gap_seconds + 120) {
            gap_start = new Date(evening_start);
            gap_end = new Date(evening_cap);
            base_lat = parseFloat(last_record.lat || 0);
            base_lng = parseFloat(last_record.lng || 0);
            if (last_record.pack_count) curr_pack_count = parseInt(last_record.pack_count) + 1;
            if (last_record.battery) v_battery = parseFloat(last_record.battery).toFixed(1);
            if (last_record.overspeed) v_overspeed = last_record.overspeed;
            if (last_record.jcb_ac) v_jcb = last_record.jcb_ac;
            
            const totel_km = last_record.totel_km || "0-0";
            if (totel_km.includes("-")) {
                start_odo = parseFloat(totel_km.split("-")[0]);
                today_odo = parseFloat(totel_km.split("-")[1]);
            } else {
                start_odo = parseFloat(totel_km);
                today_odo = parseFloat(totel_km);
            }
        }

        // 2. Scan backwards between recorded packets for a Daytime gap (within 8 AM to 10 PM)
        if (!gap_start) {
            for (let i = history_data.length - 1; i > 0; i--) {
                const t1 = new Date(history_data[i-1].dt.replace(' ', 'T') + "Z").getTime();
                const t2 = new Date(history_data[i].dt.replace(' ', 'T') + "Z").getTime();
                
                const valid_t1 = Math.max(t1, start_boundary);
                const valid_t2 = Math.min(t2, end_boundary);
                
                if (valid_t2 > valid_t1) {
                    const diff_sec = (valid_t2 - valid_t1) / 1000;
                    if (diff_sec >= required_gap_seconds + 120) {
                        gap_start = new Date(valid_t1);
                        gap_end = new Date(valid_t2);
                        base_lat = parseFloat(history_data[i-1].lat || 0);
                        base_lng = parseFloat(history_data[i-1].lng || 0);
                        
                        if (history_data[i-1].pack_count) curr_pack_count = parseInt(history_data[i-1].pack_count) + 1;
                        if (history_data[i-1].battery) v_battery = parseFloat(history_data[i-1].battery).toFixed(1);
                        if (history_data[i-1].overspeed) v_overspeed = history_data[i-1].overspeed;
                        if (history_data[i-1].jcb_ac) v_jcb = history_data[i-1].jcb_ac;
                        
                        const totel_km = history_data[i-1].totel_km || "0-0";
                        if (totel_km.includes("-")) {
                            start_odo = parseFloat(totel_km.split("-")[0]);
                            today_odo = parseFloat(totel_km.split("-")[1]);
                        } else {
                            start_odo = parseFloat(totel_km);
                            today_odo = parseFloat(totel_km);
                        }
                        break;
                    }
                }
            }
        }
        
        // 3. Fallback: Find the longest continuous parked window (speed=0, ignition=0) between 8 AM and 10 PM
        if (!gap_start) {
            logCallback(`[!] Could not find any free time gap of ${target_hours} hours. Scanning for longest parked window between 8 AM and 10 PM...`);
            
            let best_start = null;
            let best_end = null;
            let max_duration = 0;
            
            let current_parked_start = null;
            let current_parked_end = null;
            
            const filtered_history = history_data.filter(p => {
                const t = new Date(p.dt.replace(' ', 'T') + "Z").getTime();
                return t >= start_boundary && t <= end_boundary;
            });
            
            if (filtered_history.length > 0) {
                for (let i = 0; i < filtered_history.length; i++) {
                    const p = filtered_history[i];
                    const is_parked = (parseFloat(p.speed || 0) === 0 && p.i_status === '0');
                    const t = new Date(p.dt.replace(' ', 'T') + "Z").getTime();
                    
                    if (is_parked) {
                        if (current_parked_start === null) {
                            current_parked_start = t;
                        }
                        current_parked_end = t;
                    } else {
                        if (current_parked_start !== null) {
                            const duration = current_parked_end - current_parked_start;
                            if (duration > max_duration) {
                                max_duration = duration;
                                best_start = current_parked_start;
                                best_end = current_parked_end;
                            }
                            current_parked_start = null;
                            current_parked_end = null;
                        }
                    }
                }
                
                if (current_parked_start !== null) {
                    const duration = current_parked_end - current_parked_start;
                    if (duration > max_duration) {
                        max_duration = duration;
                        best_start = current_parked_start;
                        best_end = current_parked_end;
                    }
                }
            }
            
            if (best_start !== null && max_duration / 1000 >= required_gap_seconds) {
                gap_start = new Date(best_start);
                gap_end = new Date(best_end);
                logCallback(`[+] Found parked window: ${new Date(best_start).toLocaleString('en-US', { timeZone: 'Asia/Kolkata' })} to ${new Date(best_end).toLocaleString('en-US', { timeZone: 'Asia/Kolkata' })}`);
            } else {
                // Secondary Fallback: Inject at the end of the day after the last active packet
                logCallback(`[!] No parked window was long enough. Adding at the end of the day after last active packet...`);
                let last_active_t = start_boundary;
                for (let i = history_data.length - 1; i >= 0; i--) {
                    const p = history_data[i];
                    const is_active = (parseFloat(p.speed || 0) > 0 || p.i_status === '1');
                    if (is_active) {
                        last_active_t = new Date(p.dt.replace(' ', 'T') + "Z").getTime();
                        break;
                    }
                }
                
                gap_start = new Date(Math.max(last_active_t + 600000, start_boundary)); // 10 mins after last active
                
                // Ensure it fits within the 10 PM IST boundary
                if (gap_start.getTime() + (required_gap_seconds * 1000) > end_boundary) {
                    gap_start = new Date(end_boundary - (required_gap_seconds * 1000) - 120000);
                    if (gap_start.getTime() < start_boundary) {
                        gap_start = new Date(start_boundary);
                    }
                }
                gap_end = new Date(gap_start.getTime() + (required_gap_seconds * 1000) + 120000);
            }
            
            // Find closest record to gap_start to align odo and coordinates
            let closest_record = history_data[0];
            let min_diff = Math.abs(new Date(closest_record.dt.replace(' ', 'T') + "Z") - gap_start);
            for (let i = 1; i < history_data.length; i++) {
                const diff = Math.abs(new Date(history_data[i].dt.replace(' ', 'T') + "Z") - gap_start);
                if (diff < min_diff) {
                    min_diff = diff;
                    closest_record = history_data[i];
                }
            }
            
            base_lat = parseFloat(closest_record.lat || 0);
            base_lng = parseFloat(closest_record.lng || 0);
            if (closest_record.pack_count) curr_pack_count = parseInt(closest_record.pack_count) + 1;
            if (closest_record.battery) v_battery = parseFloat(closest_record.battery).toFixed(1);
            if (closest_record.overspeed) v_overspeed = closest_record.overspeed;
            if (closest_record.jcb_ac) v_jcb = closest_record.jcb_ac;
            
            const totel_km = closest_record.totel_km || "0-0";
            if (totel_km.includes("-")) {
                start_odo = parseFloat(totel_km.split("-")[0]);
                today_odo = parseFloat(totel_km.split("-")[1]);
            } else {
                start_odo = parseFloat(totel_km);
                today_odo = parseFloat(totel_km);
            }
        }
    } else {
        logCallback("[!] No history found for this date. The whole day is free!");
        gap_start = new Date(date_str + "T08:00:00+05:30"); // Default 8 AM
        gap_end = new Date(date_str + "T22:00:00+05:30");
        base_lat = 10.822819; // Default fallback coord
        base_lng = 78.681126;
    }
    
    function formatIST(date) {
        return date.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' });
    }
    
    logCallback(`[+] Selected Injection Window: ${formatIST(gap_start)} to ${formatIST(gap_end)}`);
    
    const inject_start = new Date(gap_start.getTime() + 60000);
    logCallback(`[+] Will inject fake Travel Report trip starting exactly at: ${formatIST(inject_start)}`);
    
    return new Promise((resolve, reject) => {
        const client = mqtt.connect("mqtt://igps.io:1883", {
            username: "realiot",
            password: "realmqtt@123",
            clientId: `mqttjs_tr_${Math.random().toString(16).substr(2, 8)}`,
            connectTimeout: 5000
        });

        client.on('error', (err) => {
            logCallback(`[-] MQTT Connection error: ${err.message}`);
            reject(err);
        });

        client.on('connect', async () => {
            logCallback("[+] Connected to MQTT server.");
            const topic = `BB/${imei}`;
            
            const broadcasts = Math.floor(required_gap_seconds / 5);
            
            // If hours_only is true: speed is 0 and distance is 0
            const active_speed = hours_only ? 0 : speed;
            const speed_ms = active_speed * (1000.0 / 3600.0);
            const dist_per_tick = hours_only ? 0 : ((speed_ms * 5.0) / 1000.0);
            
            let curr_odo = start_odo;
            let curr_today_odo = today_odo;
            
            try {
                for (let i = 0; i < broadcasts; i++) {
                    const curr_time = new Date(inject_start.getTime() + (i * 5000));
                    curr_odo += dist_per_tick;
                    curr_today_odo += dist_per_tick;
                    
                    const time_str = curr_time.toISOString().replace('T', ' ').substring(0, 19);
                    
                    let lat = base_lat;
                    let lng = base_lng;
                    if (!hours_only && i % 2 !== 0) {
                        const next_pos = calculateNextPosition(base_lat, base_lng, speed_ms * 5.0, 0); // Move North by tick distance
                        lat = next_pos.lat;
                        lng = next_pos.lng;
                    }
                    
                    const coord_str = `+${lat.toFixed(6)},+${lng.toFixed(6)}`;
                    const odo_str = `${curr_odo.toFixed(3)}-${curr_today_odo.toFixed(3)}`;
                    
                    // Injection parameters:
                    // Ignition=1 (Ignition ON), speed = active_speed, jcb_ac = 1-1-1-1
                    const payload = `##,${imei},0,${time_str},${coord_str},${active_speed},${v_battery},0,1,91.26,${odo_str},${v_overspeed},0-0,0-0,+0.0,0,1-1-1-1,2000-00-00 00:00:00,2000-00-00 00:00:00,12,3950,0,0-1-0-1-1,0,0,0-0,0,0,${curr_pack_count},1,0-26,3950,1,0,0,0,00000-00,$`;
                    
                    client.publish(topic, payload);
                    curr_pack_count++;
                    
                    await new Promise(r => setTimeout(r, 100)); // 100ms safe interval
                }
                
                const final_time = new Date(inject_start.getTime() + (broadcasts * 5000) + 1000);
                const final_time_str = final_time.toISOString().replace('T', ' ').substring(0, 19);
                const final_odo_str = `${curr_odo.toFixed(3)}-${curr_today_odo.toFixed(3)}`;
                const final_coord = `+${base_lat.toFixed(6)},+${base_lng.toFixed(6)}`;
                
                // Final packet ends the trip: Ignition=0, JCB=0-0-0-0
                const end_payload = `##,${imei},0,${final_time_str},${final_coord},0,${v_battery},0,0,91.26,${final_odo_str},${v_overspeed},0-0,0-0,+0.0,0,0-0-0-0,2000-00-00 00:00:00,2000-00-00 00:00:00,12,3950,0,1-0-0-0-0,0,0,0-0,0,0,${curr_pack_count},1,0-26,3950,1,0,0,0,00000-00,$`;
                client.publish(topic, end_payload);
                
                logCallback(`[+] Successfully injected Travel Report Trip!`);
                logCallback(`[+] Sent final Ignition OFF packet to conclude the trip.`);
                logCallback(`[+] Total KM generated for Travel Report: ${(curr_odo - start_odo).toFixed(2)} KM`);
                
                setTimeout(() => {
                    client.end();
                    resolve();
                }, 1000);
            } catch (err) {
                client.end();
                reject(err);
            }
        });
    });
}

if (require.main === module) {
    const imei = process.argv[2];
    const date_str = process.argv[3];
    const target_hours = parseFloat(process.argv[4] || "1.5");
    const speed = parseFloat(process.argv[5] || "30");
    const hours_only_cli = process.argv[6] === "true";

    if (!imei || !date_str) {
        console.error("Usage: node travel_report_spoofer.js <IMEI> <YYYY-MM-DD> [HOURS] [SPEED] [HOURS_ONLY]");
        process.exit(1);
    }
    runTravelReport(imei, date_str, target_hours, speed, console.log, hours_only_cli)
        .then(() => process.exit(0))
        .catch(err => {
            console.error(err);
            process.exit(1);
        });
}

module.exports = { runTravelReport };

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
        logCallback("[!] No history found for this date. Fetching last known state from previous 5 days...");
        const targetDate = new Date(date_str);
        const fiveDaysAgo = new Date(targetDate.getTime() - (5 * 24 * 3600 * 1000));
        const prev_from = fiveDaysAgo.toISOString().split('T')[0] + " 00:00:00";
        const prev_to = new Date(targetDate.getTime() - (1 * 24 * 3600 * 1000)).toISOString().split('T')[0] + " 23:59:59";
        
        try {
            const params = new URLSearchParams();
            params.append('imei', imei);
            params.append('from', prev_from);
            params.append('to', prev_to);
            params.append('username', 'trichy');
            params.append('action', 'history_web');
            
            const res = await axios.post('http://dev.igps.io/http.php', params.toString(), {
                headers: {'Content-Type': 'application/x-www-form-urlencoded'},
                timeout: 10000
            });
            
            if (Array.isArray(res.data) && res.data.length > 0) {
                const last_record = res.data[res.data.length - 1];
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
                logCallback(`[+] Found last known odometer: ${start_odo} KM and position (${base_lat}, ${base_lng})`);
            } else {
                logCallback("[-] No previous history found in last 5 days. Using defaults.");
                base_lat = 10.822819;
                base_lng = 78.681126;
                start_odo = 0.0;
                today_odo = 0.0;
            }
        } catch (e) {
            logCallback(`[-] Failed to fetch previous history: ${e.message}. Using defaults.`);
            base_lat = 10.822819;
            base_lng = 78.681126;
            start_odo = 0.0;
            today_odo = 0.0;
        }
        
        gap_start = new Date(date_str + "T08:00:00+05:30");
        gap_end = new Date(date_str + "T22:00:00+05:30");
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
            
            const broadcasts = Math.floor(required_gap_seconds / 30);
            
            // Ignition must be 1 (ON) for both modes so it registers as a playback segment in the list
            // JCB accessory runtime (SPV Hours) is only enabled if hours_only is true
            const active_speed = hours_only ? 0 : speed;
            const speed_ms = active_speed * (1000.0 / 3600.0);
            
            const ignition_val = 1;
            const jcb_ac_val = hours_only ? "1-1-1-1" : "0-0-0-0";
            const jcb_bit_val = hours_only ? 1 : 0;
            const status_bit_val = "0-1-0-1-1";
            
            const final_time = new Date(inject_start.getTime() + (broadcasts * 30000) + 1000);
            
            // Build the chronological list of target timestamps to publish
            const target_timestamps = [];
            
            // Helper to add/replace timestamps cleanly (prevents duplicates at same second)
            function addOrReplaceTimestamp(entry) {
                const target_ms = entry.time.getTime();
                const idx = target_timestamps.findIndex(item => Math.abs(item.time.getTime() - target_ms) < 1000);
                if (idx !== -1) {
                    // Replace/Merge: If new entry is a regular interval (Ignition ON) or original, overwrite it
                    // We prioritize preserving is_before_start = true if it matches that phase
                    target_timestamps[idx] = {
                        time: entry.time,
                        is_original: entry.is_original || target_timestamps[idx].is_original,
                        is_before_start: entry.is_before_start || target_timestamps[idx].is_before_start,
                        pack_count: entry.pack_count
                    };
                } else {
                    target_timestamps.push(entry);
                }
            }
            
            // 1. Add regular 30-second intervals
            for (let i = 0; i < broadcasts; i++) {
                addOrReplaceTimestamp({
                    time: new Date(inject_start.getTime() + (i * 30000)),
                    is_original: false,
                    is_before_start: false,
                    pack_count: curr_pack_count + i
                });
            }
            
            // 2. Add any pre-existing real packets inside the window to overwrite them at their exact timestamps
            history_data.forEach(r => {
                const t = new Date(r.dt.replace(' ', 'T') + "Z");
                const t_ms = t.getTime();
                if (t_ms >= inject_start.getTime() && t_ms < final_time.getTime()) {
                    addOrReplaceTimestamp({
                        time: t,
                        is_original: true,
                        is_before_start: false,
                        pack_count: r.pack_count ? parseInt(r.pack_count) : (curr_pack_count + broadcasts)
                    });
                }
            });
            
            // 2.5 Add any parked packets (Ignition OFF) up to 20 minutes BEFORE the start of the window
            history_data.forEach(r => {
                const t = new Date(r.dt.replace(' ', 'T') + "Z");
                const t_ms = t.getTime();
                const is_parked = (r.i_status === '0' || parseInt(r.ignition) === 0);
                if (is_parked && t_ms >= inject_start.getTime() - 20 * 60 * 1000 && t_ms < inject_start.getTime()) {
                    addOrReplaceTimestamp({
                        time: t,
                        is_original: true,
                        is_before_start: true,
                        pack_count: r.pack_count ? parseInt(r.pack_count) : curr_pack_count
                    });
                }
            });
            
            // 3. Sort chronologically
            target_timestamps.sort((a, b) => a.time.getTime() - b.time.getTime());
            
            let curr_odo = start_odo;
            let curr_today_odo = today_odo;
            
            try {
                for (let i = 0; i < target_timestamps.length; i++) {
                    const item = target_timestamps[i];
                    const curr_time = item.time;
                    
                    if (item.is_before_start) {
                        // Pre-start overwrite: Lock to starting odometer
                        curr_odo = start_odo;
                        curr_today_odo = today_odo;
                    } else {
                        const elapsed_seconds = (curr_time.getTime() - inject_start.getTime()) / 1000.0;
                        const elapsed_hours = elapsed_seconds / 3600.0;
                        curr_odo = start_odo + (elapsed_hours * active_speed);
                        curr_today_odo = today_odo + (elapsed_hours * active_speed);
                    }
                    
                    const time_str = curr_time.toISOString().replace('T', ' ').substring(0, 19);
                    
                    let lat = base_lat;
                    let lng = base_lng;
                    if (!hours_only && i % 2 !== 0) {
                        const next_pos = calculateNextPosition(base_lat, base_lng, speed_ms * 30.0, 0); // Move North by tick distance
                        lat = next_pos.lat;
                        lng = next_pos.lng;
                    }
                    
                    const coord_str = `+${lat.toFixed(6)},+${lng.toFixed(6)}`;
                    const odo_str = `${curr_odo.toFixed(3)}-${curr_today_odo.toFixed(3)}`;
                    const p_count = item.pack_count;
                    
                    // Injection parameters:
                    const payload = `##,${imei},0,${time_str},${coord_str},${active_speed},${v_battery},0,${ignition_val},91.26,${odo_str},${v_overspeed},0-0,0-0,+0.0,0,${jcb_ac_val},2000-00-00 00:00:00,2000-00-00 00:00:00,12,3950,0,${status_bit_val},0,0,0-0,0,0,${p_count},${jcb_bit_val},0-26,3950,${jcb_bit_val},0,0,0,00000-00,$`;
                    
                    client.publish(topic, payload);
                    await new Promise(r => setTimeout(r, 100)); // 100ms safe interval
                }
                
                const final_time_str = final_time.toISOString().replace('T', ' ').substring(0, 19);
                const final_elapsed_seconds = (final_time.getTime() - inject_start.getTime()) / 1000.0;
                curr_odo = start_odo + (final_elapsed_seconds / 3600.0) * active_speed;
                curr_today_odo = today_odo + (final_elapsed_seconds / 3600.0) * active_speed;
                const final_odo_str = `${curr_odo.toFixed(3)}-${curr_today_odo.toFixed(3)}`;
                const final_coord = `+${base_lat.toFixed(6)},+${base_lng.toFixed(6)}`;
                const end_pack_count = curr_pack_count + target_timestamps.length;
                
                // Final packet ends the trip: Ignition=0, JCB=0-0-0-0, JCB bits=0
                const end_payload = `##,${imei},0,${final_time_str},${final_coord},0,${v_battery},0,0,91.26,${final_odo_str},${v_overspeed},0-0,0-0,+0.0,0,0-0-0-0,2000-00-00 00:00:00,2000-00-00 00:00:00,12,3950,0,1-0-0-0-0,0,0,0-0,0,0,${end_pack_count},0,0-26,3950,0,0,0,0,00000-00,$`;
                client.publish(topic, end_payload);
                
                // Overwrite subsequent original packets to prevent odometer drops
                 const final_time_ms = final_time.getTime();
                 const subsequent_records = history_data.filter(r => {
                     const t = new Date(r.dt.replace(' ', 'T') + "Z").getTime();
                     return t > final_time_ms;
                 });
                 
                 if (subsequent_records.length > 0) {
                     logCallback(`[+] Overwriting ${subsequent_records.length} subsequent packets to prevent odometer drops...`);
                     for (const r of subsequent_records) {
                         const time_str = r.dt;
                         const lat = parseFloat(r.lat || 0);
                         const lng = parseFloat(r.lng || 0);
                         const coord_str = `+${lat.toFixed(6)},+${lng.toFixed(6)}`;
                         
                         const odo_str = `${curr_odo.toFixed(3)}-${curr_today_odo.toFixed(3)}`;
                         
                         const p_count = r.pack_count ? parseInt(r.pack_count) : curr_pack_count;
                         const p_bat = r.battery ? parseFloat(r.battery).toFixed(1) : v_battery;
                         const p_overspeed = r.overspeed || v_overspeed;
                         const p_jcb = r.jcb_ac || "0-0-0-0";
                         const p_speed = parseFloat(r.speed || 0);
                         const p_ign = parseInt(r.ignition !== undefined ? r.ignition : 0);
                         const p_status = p_ign === 1 ? "0-1-0-1-1" : "1-0-0-0-0";
                         const p_jcb_bit = p_jcb === "1-1-1-1" ? 1 : 0;
                         
                         const payload = `##,${imei},0,${time_str},${coord_str},${p_speed},${p_bat},0,${p_ign},91.26,${odo_str},${p_overspeed},0-0,0-0,+0.0,0,${p_jcb},2000-00-00 00:00:00,2000-00-00 00:00:00,12,3950,0,${p_status},0,0,0-0,0,0,${p_count},${p_jcb_bit},0-26,3950,${p_jcb_bit},0,0,0,00000-00,$`;
                         
                         client.publish(topic, payload);
                         await new Promise(res => setTimeout(res, 50));
                     }
                 }
                
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
        .then(() => {
            try {
                const engine = require('./spoofer');
                const added_km = hours_only_cli ? 0 : (target_hours * speed);
                engine.save_history(imei, hours_only_cli ? "travel_hours" : "travel_report", added_km, 0, 0, target_hours, 0, date_str);
                console.log("[+] Auto-saved trip to history.json");
            } catch(e) {
                console.error("[-] Failed to auto-save to history:", e.message);
            }
            process.exit(0);
        })
        .catch(err => {
            console.error(err);
            process.exit(1);
        });
}

module.exports = { runTravelReport };

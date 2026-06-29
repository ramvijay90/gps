const mqtt = require('mqtt');
const axios = require('axios');

async function runTravelReport(imei, date_str, target_hours = 1.5, speed = 30, logCallback = console.log) {
    const required_gap_seconds = target_hours * 3600;

    logCallback(`[+] Finding a free time gap of at least ${target_hours} hours for IMEI ${imei} on ${date_str}...`);

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

    if (history_data.length > 0) {
        // 1. Check Evening Boundary Gap (From last packet until NOW or End of Day)
        const end_of_day = new Date(date_str + "T23:59:59+05:30").getTime();
        const current_time = Date.now();
        const evening_cap = Math.min(end_of_day, current_time);
        
        const last_record = history_data[history_data.length - 1];
        const last_t = new Date(last_record.dt.replace(' ', 'T') + "Z").getTime();
        
        if ((evening_cap - last_t) / 1000 >= required_gap_seconds + 120) {
            gap_start = new Date(last_t);
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

        // 2. Scan backwards between recorded packets for a Daytime gap
        if (!gap_start) {
            for (let i = history_data.length - 1; i > 0; i--) {
                const t1 = new Date(history_data[i-1].dt.replace(' ', 'T') + "Z").getTime();
                const t2 = new Date(history_data[i].dt.replace(' ', 'T') + "Z").getTime();
                
                const diff_sec = (t2 - t1) / 1000;
                if (diff_sec >= required_gap_seconds + 120) {
                    gap_start = new Date(t1);
                    gap_end = new Date(t2);
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
        
        if (!gap_start) {
            const err_msg = `[-] Could not find any free time gap of ${target_hours} hours on ${date_str} even when scanning backwards!`;
            logCallback(err_msg);
            throw new Error(err_msg);
        }
    } else {
        logCallback("[!] No history found for this date. The whole day is free!");
        gap_start = new Date(date_str + "T08:00:00+05:30"); // Default 8 AM
        gap_end = new Date(date_str + "T23:59:59+05:30");
        base_lat = 10.822819; // Default fallback coord
        base_lng = 78.681126;
    }
    
    logCallback(`[+] Found Free Time Gap: ${gap_start.toLocaleString()} to ${gap_end.toLocaleString()}`);
    
    const inject_start = new Date(gap_start.getTime() + 60000);
    logCallback(`[+] Will inject fake Travel Report trip starting exactly at: ${inject_start.toLocaleString()}`);
    
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
            const speed_ms = speed * (1000.0 / 3600.0);
            const dist_per_tick = (speed_ms * 5.0) / 1000.0;
            
            let curr_odo = start_odo;
            let curr_today_odo = today_odo;
            
            try {
                for (let i = 0; i < broadcasts; i++) {
                    const curr_time = new Date(inject_start.getTime() + (i * 5000));
                    curr_odo += dist_per_tick;
                    curr_today_odo += dist_per_tick;
                    
                    const time_str = curr_time.toISOString().replace('T', ' ').substring(0, 19);
                    
                    let jitter = (i % 2 === 0) ? 0.00001 : -0.00001;
                    let lat = base_lat + jitter;
                    let lng = base_lng + jitter;
                    
                    const coord_str = `+${lat.toFixed(6)},+${lng.toFixed(6)}`;
                    const odo_str = `${curr_odo.toFixed(3)}-${curr_today_odo.toFixed(3)}`;
                    
                    const payload = `##,${imei},0,${time_str},${coord_str},${speed},${v_battery},0,1,91.26,${odo_str},${v_overspeed},0-0,0-0,+0.0,0,${v_jcb},2000-00-00 00:00:00,2000-00-00 00:00:00,12,3950,0,0-1-0-1-1,0,0,0-0,0,0,${curr_pack_count},1,0-26,3950,1,0,0,0,00000-00,$`;
                    
                    client.publish(topic, payload);
                    curr_pack_count++;
                    
                    await new Promise(r => setTimeout(r, 100)); // 100ms safe interval
                }
                
                const final_time = new Date(inject_start.getTime() + (broadcasts * 5000) + 1000);
                const final_time_str = final_time.toISOString().replace('T', ' ').substring(0, 19);
                const final_odo_str = `${curr_odo.toFixed(3)}-${curr_today_odo.toFixed(3)}`;
                const final_coord = `+${base_lat.toFixed(6)},+${base_lng.toFixed(6)}`;
                
                const end_payload = `##,${imei},0,${final_time_str},${final_coord},0,${v_battery},0,0,91.26,${final_odo_str},${v_overspeed},0-0,0-0,+0.0,0,${v_jcb},2000-00-00 00:00:00,2000-00-00 00:00:00,12,3950,0,1-0-0-0-0,0,0,0-0,0,0,${curr_pack_count},1,0-26,3950,1,0,0,0,00000-00,$`;
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

    if (!imei || !date_str) {
        console.error("Usage: node travel_report_spoofer.js <IMEI> <YYYY-MM-DD> [HOURS] [SPEED]");
        process.exit(1);
    }
    runTravelReport(imei, date_str, target_hours, speed, console.log)
        .then(() => process.exit(0))
        .catch(err => {
            console.error(err);
            process.exit(1);
        });
}

module.exports = { runTravelReport };

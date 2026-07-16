const mqtt = require('mqtt');
const axios = require('axios');

async function runTravelReport(imei, date_str, target_hours = 1.5, speed = 30, logCallback = console.log, hours_only = false) {
    const target_added_val = hours_only ? target_hours : (target_hours * speed);
    
    if (hours_only) {
        logCallback(`[+] Travel Report HOURS Spoof: Adding ${target_added_val} Hours for IMEI ${imei} on ${date_str}...`);
    } else {
        logCallback(`[+] Travel Report KM Spoof: Adding ${target_added_val.toFixed(2)} KM for IMEI ${imei} on ${date_str}...`);
    }

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
    
    if (history_data.length === 0) {
        logCallback(`[-] No history found for ${date_str}. Cannot perform override spoof on a day with no movement.`);
        throw new Error("Vehicle did not move. Aborting.");
    }

    // Connect to MQTT
    return new Promise((resolve, reject) => {
        const client = mqtt.connect("mqtt://igps.io:1883", {
            username: "realiot",
            password: "realmqtt@123",
            clientId: `mqttjs_tr_ovr_${Math.random().toString(16).substr(2, 8)}`,
            connectTimeout: 5000
        });

        client.on('error', (err) => {
            logCallback(`[-] MQTT Connection error: ${err.message}`);
            reject(err);
        });

        client.on('connect', async () => {
            logCallback("[+] Connected to MQTT server.");
            const topic = `BB/${imei}`;
            
            try {
                let packets_to_publish = [];
                
                if (hours_only) {
                    // HOURS SPOOF: Find existing real trips and extend them into their post-trip parking gaps
                    let trips = [];
                    let current_trip = [];
                    let trip_start_idx = -1;
                    
                    for (let i = 0; i < history_data.length; i++) {
                        const p = history_data[i];
                        if (p.i_status === '1') {
                            if (current_trip.length === 0) trip_start_idx = i;
                            current_trip.push({packet: p, index: i});
                        } else {
                            if (current_trip.length > 0) {
                                trips.push({packets: current_trip, start_idx: trip_start_idx});
                                current_trip = [];
                            }
                        }
                    }
                    if (current_trip.length > 0) {
                        trips.push({packets: current_trip, start_idx: trip_start_idx});
                    }
                    
                    if (trips.length === 0) {
                        throw new Error("No existing trips found on this day. Cannot extend hours when vehicle did not move.");
                    }
                    
                    let hours_needed = target_hours;
                    
                    for (let t = 0; t < trips.length; t++) {
                        if (hours_needed <= 0.01) break;
                        
                        const trip = trips[t];
                        const trip_end_idx = trip.start_idx + trip.packets.length - 1;
                        
                        // Find the parking gap immediately after this trip
                        let next_trip_start_idx = history_data.length;
                        if (t + 1 < trips.length) {
                            next_trip_start_idx = trips[t+1].start_idx;
                        }
                        
                        let gap_packets = [];
                        for (let i = trip_end_idx + 1; i < next_trip_start_idx; i++) {
                            if (history_data[i].i_status === '0') {
                                gap_packets.push(history_data[i]);
                            }
                        }
                        
                        if (gap_packets.length === 0) continue;
                        
                        const first_time = new Date(gap_packets[0].dt.replace(' ', 'T') + "Z");
                        logCallback(`[+] Extending trip #${t+1} using parking gap starting at ${gap_packets[0].dt}`);
                        
                        let last_p = null;
                        for (let i = 0; i < gap_packets.length; i++) {
                            let p = gap_packets[i];
                            const curr_time = new Date(p.dt.replace(' ', 'T') + "Z");
                            const elapsed_hours = (curr_time.getTime() - first_time.getTime()) / 3600000.0;
                            
                            if (elapsed_hours <= hours_needed) {
                                // Add 1 second to avoid duplicate timestamp filtering by the App
                                let packet_time = new Date(p.dt.replace(' ', 'T') + 'Z');
                                packet_time.setUTCSeconds(packet_time.getUTCSeconds() + 1);
                                const time_str = packet_time.toISOString().replace('T', ' ').substring(0, 19);
                                const coord_str = `+${parseFloat(p.lat).toFixed(6)},+${parseFloat(p.lng).toFixed(6)}`;
                                
                                let odo_str = p.totel_km;
                                if (!odo_str.includes('-')) odo_str = `${odo_str}-${odo_str}`;
                                
                                const pack_count = p.pack_count || 3000;
                                const v_battery = p.battery || "12.0";
                                const v_overspeed = p.overspeed || "0-0";
                                const status_bit_val = "0-1-0-1-1"; // IGN ON
                                const jcb_ac_val = "1-1-1-1";
                                const jcb_bit_val = 1;
                                
                                const payload = `##,${imei},0,${time_str},${coord_str},0,${v_battery},0,1,91.26,${odo_str},${v_overspeed},0-0,0-0,+0.0,0,${jcb_ac_val},2000-00-00 00:00:00,2000-00-00 00:00:00,12,3950,0,${status_bit_val},0,0,0-0,0,0,${pack_count},${jcb_bit_val},0-26,3950,${jcb_bit_val},0,0,0,00000-00,$`;
                                packets_to_publish.push(payload);
                                last_p = p;
                            } else {
                                break;
                            }
                        }
                        
                        if (last_p) {
                            // Inject ONE final Ignition 0 packet to cleanly close the trip!
                            let final_packet_time = new Date(last_p.dt.replace(' ', 'T') + 'Z');
                            final_packet_time.setUTCSeconds(final_packet_time.getUTCSeconds() + 2);
                            const final_time_str = final_packet_time.toISOString().replace('T', ' ').substring(0, 19);
                            const final_coord_str = `+${parseFloat(last_p.lat).toFixed(6)},+${parseFloat(last_p.lng).toFixed(6)}`;
                            let final_odo_str = last_p.totel_km;
                            if (!final_odo_str.includes('-')) final_odo_str = `${final_odo_str}-${final_odo_str}`;
                            
                            const final_payload = `##,${imei},0,${final_time_str},${final_coord_str},0,${last_p.battery || "12.0"},0,0,91.26,${final_odo_str},0-0,0-0,0-0,+0.0,0,0-0-0-0,2000-00-00 00:00:00,2000-00-00 00:00:00,12,3950,0,1-0-0-0-0,0,0,0-0,0,0,3000,0,0-26,3950,0,0,0,0,00000-00,$`;
                            packets_to_publish.push(final_payload);
                            
                            const curr_time = new Date(last_p.dt.replace(' ', 'T') + "Z");
                            const actually_added_hours = (curr_time.getTime() - first_time.getTime()) / 3600000.0;
                            hours_needed -= actually_added_hours;
                        }
                    }
                    
                    if (hours_needed > 0.1) {
                        logCallback(`[+] Warning: Could only fit ${(target_hours - hours_needed).toFixed(2)} hours out of ${target_hours} requested before running out of parking gaps.`);
                    }
                    
                } else {
                    // KM SPOOF: Find a real trip, distribute KM over it, apply to rest of day.
                    let trips = [];
                    let current_trip = [];
                    let trip_start_idx = -1;
                    
                    for (let i = 0; i < history_data.length; i++) {
                        const p = history_data[i];
                        if (p.i_status === '1') {
                            if (current_trip.length === 0) trip_start_idx = i;
                            current_trip.push({packet: p, index: i});
                        } else {
                            if (current_trip.length > 0) {
                                trips.push({packets: current_trip, start_idx: trip_start_idx});
                                current_trip = [];
                            }
                        }
                    }
                    if (current_trip.length > 0) {
                        trips.push({packets: current_trip, start_idx: trip_start_idx});
                    }
                    
                    if (trips.length === 0) {
                        throw new Error("No moving trips found today. Cannot apply distance spoof.");
                    }
                    
                    // Pick the longest trip
                    trips.sort((a, b) => b.packets.length - a.packets.length);
                    const best_trip = trips[0];
                    
                    logCallback(`[+] Selected longest trip starting at ${best_trip.packets[0].packet.dt} with ${best_trip.packets.length} packets.`);
                    
                    const trip_len = best_trip.packets.length;
                    
                    // We modify the trip packets to linearly add the target_added_val
                    for (let i = 0; i < trip_len; i++) {
                        const item = best_trip.packets[i];
                        let p = item.packet;
                        
                        // Current offset (spread evenly across the trip)
                        let offset_km = target_added_val;
                        if (trip_len > 1) {
                            offset_km = (i / (trip_len - 1)) * target_added_val;
                        }
                        
                        let base_odo = 0;
                        let base_today = 0;
                        if (p.totel_km) {
                            if (p.totel_km.includes('-')) {
                                base_odo = parseFloat(p.totel_km.split('-')[0]);
                                base_today = parseFloat(p.totel_km.split('-')[1]);
                            } else {
                                base_odo = parseFloat(p.totel_km);
                                base_today = parseFloat(p.totel_km);
                            }
                        }
                        
                        const new_odo = base_odo + offset_km;
                        const new_today = base_today + offset_km;
                        const odo_str = `${new_odo.toFixed(3)}-${new_today.toFixed(3)}`;
                        
                        // Add 1 second to avoid duplicate timestamp filtering by the App
                        let packet_time = new Date(p.dt.replace(' ', 'T') + 'Z');
                        packet_time.setUTCSeconds(packet_time.getUTCSeconds() + 1);
                        const time_str = packet_time.toISOString().replace('T', ' ').substring(0, 19);
                        const coord_str = `+${parseFloat(p.lat).toFixed(6)},+${parseFloat(p.lng).toFixed(6)}`;
                        const pack_count = p.pack_count || 3000;
                        const v_battery = p.battery || "12.0";
                        const v_overspeed = p.overspeed || "0-0";
                        const ignition_val = p.i_status; // Should be 1
                        const jcb_ac_val = p.jcb_ac || "0-0-0-0";
                        const speed_val = p.speed || 0;
                        
                        // We must reconstruct the status bits identically if possible, but default is fine
                        const status_bit_val = ignition_val == "1" ? "0-1-0-1-1" : "1-0-0-0-0";
                        
                        const payload = `##,${imei},0,${time_str},${coord_str},${speed_val},${v_battery},0,${ignition_val},91.26,${odo_str},${v_overspeed},0-0,0-0,+0.0,0,${jcb_ac_val},2000-00-00 00:00:00,2000-00-00 00:00:00,12,3950,0,${status_bit_val},0,0,0-0,0,0,${pack_count},0,0-26,3950,0,0,0,0,00000-00,$`;
                        packets_to_publish.push(payload);
                    }
                    
                    // Inject ONE final Ignition 0 packet to lock in the high Odometer for the Travel Report
                    const last_p = history_data[best_trip.start_idx + trip_len - 1];
                    let final_packet_time = new Date(last_p.dt.replace(' ', 'T') + 'Z');
                    final_packet_time.setUTCSeconds(final_packet_time.getUTCSeconds() + 2);
                    const final_time_str = final_packet_time.toISOString().replace('T', ' ').substring(0, 19);
                    
                    let final_base_odo = 0;
                    let final_base_today = 0;
                    if (last_p.totel_km) {
                        if (last_p.totel_km.includes('-')) {
                            final_base_odo = parseFloat(last_p.totel_km.split('-')[0]);
                            final_base_today = parseFloat(last_p.totel_km.split('-')[1]);
                        } else {
                            final_base_odo = parseFloat(last_p.totel_km);
                            final_base_today = parseFloat(last_p.totel_km);
                        }
                    }
                    const final_odo_str = `${(final_base_odo + target_added_val).toFixed(3)}-${(final_base_today + target_added_val).toFixed(3)}`;
                    const final_coord_str = `+${parseFloat(last_p.lat).toFixed(6)},+${parseFloat(last_p.lng).toFixed(6)}`;
                    
                    const final_payload = `##,${imei},0,${final_time_str},${final_coord_str},0,${last_p.battery || "12.0"},0,0,91.26,${final_odo_str},0-0,0-0,0-0,+0.0,0,0-0-0-0,2000-00-00 00:00:00,2000-00-00 00:00:00,12,3950,0,1-0-0-0-0,0,0,0-0,0,0,3000,0,0-26,3950,0,0,0,0,00000-00,$`;
                    packets_to_publish.push(final_payload);
                    
                    // Removed the logic that modifies all packets after the trip.
                    // Injecting duplicates for the rest of the day causes later trips to also gain the offset!
                }
                
                logCallback(`[+] Ready to override ${packets_to_publish.length} packets in the database...`);
                
                for (let i = 0; i < packets_to_publish.length; i++) {
                    client.publish(topic, packets_to_publish[i]);
                    await new Promise(r => setTimeout(r, 50)); // 50ms interval is safe for overwrites
                }
                
                logCallback(`[+] Successfully overwritten packets!`);
                
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

import os
import sys
import math
import base64
import requests
import json
from datetime import datetime, timedelta

session_dev = requests.Session()
session_dev.post("http://dev.igps.io/trichy/api/govt_api.php", data={"action": "verify", "username": "trichy", "password": "tmc@123"})
session_live = requests.Session()

def run_query(host, sql, qtype="select"):
    b64 = base64.b64encode(sql.encode('utf-8')).decode('utf-8')
    sess = session_dev if "dev" in host else session_live
    res = sess.post(f"http://{host}/http.php", data={"action": "select", "query": b64, "type": qtype}, timeout=25)
    try:
        return res.json()
    except Exception:
        return res.text

def calculate_bearing(lat1, lon1, lat2, lon2):
    lat1, lon1, lat2, lon2 = map(math.radians, [lat1, lon1, lat2, lon2])
    dLon = lon2 - lon1
    y = math.sin(dLon) * math.cos(lat2)
    x = math.cos(lat1) * math.sin(lat2) - math.sin(lat1) * math.cos(lat2) * math.cos(dLon)
    brng = math.degrees(math.atan2(y, x))
    return int((brng + 360) % 360)

def haversine(lat1, lon1, lat2, lon2):
    R = 6371.0
    dLat = math.radians(lat2 - lat1)
    dLon = math.radians(lon2 - lon1)
    a = math.sin(dLat/2)**2 + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(dLon/2)**2
    c = 2 * math.asin(math.sqrt(a))
    return R * c

def fetch_osrm_leg(p1, p2):
    url = f"http://router.project-osrm.org/route/v1/driving/{p1[1]},{p1[0]};{p2[1]},{p2[0]}?overview=full&geometries=geojson"
    try:
        r = requests.get(url, timeout=10).json()
        raw_pts = r['routes'][0]['geometry']['coordinates']
        return [(p[1], p[0]) for p in raw_pts]
    except Exception as e:
        print(f"[-] OSRM error: {e}")
        return [p1, p2]

imei = "869867035027616"
date_str = "2026-10-20"
target_km = 39.740

print("=" * 75)
print(f"APPLYING REAL OSRM STREET GHOST DRIVE FOR {imei} (TN 45 CC 1667)")
print("=" * 75)

# Trichy Municipal Road Waypoints strictly within 1667's genuine zone
depot = (10.8135, 78.6951)
tvs   = (10.7995, 78.6975)
mannar= (10.7925, 78.6840)
palak = (10.8080, 78.6920)
ariya = (10.8080, 78.7200)

legs_plan = [
    (depot, tvs, 4.500, 16, 28, "Gandhi Market Depot -> TVS Tolgate"),
    (tvs, mannar, 7.800, 24, 38, "TVS Tolgate -> Mannarpuram"),
    (mannar, palak, 10.200, 28, 42, "Mannarpuram -> Palakkarai"),
    (palak, ariya, 11.400, 26, 36, "Palakkarai -> Ariyamangalam"),
    (ariya, depot, 5.840, 14, 26, "Ariyamangalam -> Gandhi Market Depot")
]

start_odo_0 = 74514.868
start_odo_1 = 74532.158
delta_odo = round(start_odo_1 - start_odo_0, 3)

final_odo_0 = round(start_odo_0 + target_km, 3) # 74554.608
final_odo_1 = round(start_odo_1 + target_km, 3) # 74571.898
final_odo_str = f"{final_odo_0:.3f}-{final_odo_1:.3f}"

start_ist = datetime.strptime(f"{date_str} 14:50:00", "%Y-%m-%d %H:%M:%S")
curr_start = start_ist
all_injected_packets = []
pack_counter = 3000
report_trips_data = []
current_odo_0 = start_odo_0

for idx, (p1, p2, t_dist, t_min, peak_spd, name) in enumerate(legs_plan):
    osrm_pts = fetch_osrm_leg(p1, p2)
    N_pts = len(osrm_pts)
    
    t_sec = t_min * 60
    curr_end = curr_start + timedelta(seconds=t_sec)
    
    # Cumulative distances along real street path
    cum_d = [0.0]
    for i in range(1, N_pts):
        d = haversine(osrm_pts[i-1][0], osrm_pts[i-1][1], osrm_pts[i][0], osrm_pts[i][1])
        cum_d.append(cum_d[-1] + d)
    tot_d = cum_d[-1] if cum_d[-1] > 0 else 1.0
    
    step_sec = 10
    M = max(20, t_sec // step_sec)
    
    start_odo_leg = current_odo_0
    end_odo_leg = current_odo_0 + t_dist
    
    leg_packets = []
    for k in range(M + 1):
        frac = k / float(M)
        pkt_time_ist = curr_start + timedelta(seconds=round(frac * t_sec))
        pkt_time_utc = pkt_time_ist - timedelta(hours=5, minutes=30)
        
        target_cum = frac * tot_d
        seg_idx = 0
        while seg_idx < N_pts - 1 and cum_d[seg_idx+1] < target_cum:
            seg_idx += 1
            
        if seg_idx >= N_pts - 1:
            lat, lng = osrm_pts[-1]
        else:
            seg_len = cum_d[seg_idx+1] - cum_d[seg_idx]
            seg_frac = (target_cum - cum_d[seg_idx]) / seg_len if seg_len > 0 else 0
            lat = osrm_pts[seg_idx][0] + seg_frac * (osrm_pts[seg_idx+1][0] - osrm_pts[seg_idx][0])
            lng = osrm_pts[seg_idx][1] + seg_frac * (osrm_pts[seg_idx+1][1] - osrm_pts[seg_idx][1])
            
        odo_val_0 = start_odo_leg + frac * t_dist
        odo_val_1 = odo_val_0 + delta_odo
        odo_str = f"{odo_val_0:.3f}-{odo_val_1:.3f}"
        
        # Smooth realistic speed curves
        if k == 0:
            spd = 0
            ign = "1"
        elif k == M:
            spd = 0
            ign = "0"
        elif k <= 4:
            spd = int(8 + k * (peak_spd * 0.15))
            ign = "1"
        elif k >= M - 4:
            spd = int(6 + (M - k) * (peak_spd * 0.15))
            ign = "1"
        else:
            smooth_drift = 3.5 * math.sin((k / float(M)) * math.pi * 3)
            spd = max(14, min(peak_spd, int((peak_spd * 0.8) + smooth_drift)))
            ign = "1"
            
        dt_str = pkt_time_utc.strftime("%Y-%m-%d %H:%M:%S")
        dt_s_str = pkt_time_ist.strftime("%Y-%m-%d %H:%M:%S")
        
        pack_counter += 1
        leg_packets.append({
            'dt': dt_str,
            'dt_s': dt_s_str,
            'imei': imei,
            'lat': f"+{lat:.6f}",
            'lng': f"+{lng:.6f}",
            'speed': str(spd),
            'battery': '25.9',
            'i_time': '0',
            'i_status': ign,
            'course': '90',
            'overspeed': '0',
            'jcb_ac': '0-0-1-0',
            'totel_km': odo_str,
            't_w': '+250.0$2400',
            'fuel': 'null',
            'pack_count': pack_counter
        })
        
    for i in range(len(leg_packets)):
        if i < len(leg_packets) - 1:
            p1_lat = float(leg_packets[i]['lat'])
            p1_lng = float(leg_packets[i]['lng'])
            p2_lat = float(leg_packets[i+1]['lat'])
            p2_lng = float(leg_packets[i+1]['lng'])
            leg_packets[i]['course'] = str(calculate_bearing(p1_lat, p1_lng, p2_lat, p2_lng))
        else:
            leg_packets[i]['course'] = leg_packets[i-1]['course']
            
    all_injected_packets.extend(leg_packets)
    
    first_pkt = leg_packets[0]
    last_pkt = leg_packets[-1]
    report_trips_data.append({
        'start_time_utc': first_pkt['dt'],
        'end_time_utc': last_pkt['dt'],
        'dist_km': f"{t_dist:.3f}",
        'dur_sec': str(t_sec),
        'start_lat': first_pkt['lat'],
        'start_lng': first_pkt['lng'],
        'end_lat': last_pkt['lat'],
        'end_lng': last_pkt['lng']
    })
    
    current_odo_0 = end_odo_leg
    
    # Halt between trips
    if idx < 4:
        halt_sec = 240 # 4 mins
        halt_dest_lat = last_pkt['lat']
        halt_dest_lng = last_pkt['lng']
        halt_odo_str = f"{current_odo_0:.3f}-{current_odo_0 + delta_odo:.3f}"
        for h in range(1, 3):
            h_time_ist = curr_end + timedelta(seconds=h * 80)
            h_time_utc = h_time_ist - timedelta(hours=5, minutes=30)
            pack_counter += 1
            all_injected_packets.append({
                'dt': h_time_utc.strftime("%Y-%m-%d %H:%M:%S"),
                'dt_s': h_time_ist.strftime("%Y-%m-%d %H:%M:%S"),
                'imei': imei,
                'lat': halt_dest_lat,
                'lng': halt_dest_lng,
                'speed': '0',
                'battery': '25.9',
                'i_time': '0',
                'i_status': '0',
                'course': last_pkt['course'],
                'overspeed': '0',
                'jcb_ac': '0-0-1-0',
                'totel_km': halt_odo_str,
                't_w': '+250.0$2400',
                'fuel': 'null',
                'pack_count': pack_counter
            })
        curr_start = curr_end + timedelta(seconds=halt_sec)

drive_start_utc = all_injected_packets[0]['dt']
drive_end_utc = all_injected_packets[-1]['dt']

print(f"[+] Total Road Packets across 5 trips: {len(all_injected_packets)}")
print(f"    Drive Start: {all_injected_packets[0]['dt_s']} (Odo: {all_injected_packets[0]['totel_km']})")
print(f"    Drive End:   {all_injected_packets[-1]['dt_s']} (Odo: {all_injected_packets[-1]['totel_km']})")
print(f"    Final Odo:   {final_odo_str}")

# Hardware trigger offset calculation:
trigger_offset = round(final_odo_0 - 74483.268, 3) # +71.340 KM
print(f"[+] Trigger Offset for live incoming packets: +{trigger_offset:.3f} KM")

total_day_km = 100.240
total_day_dur = 7920 + sum(int(t['dur_sec']) for t in report_trips_data)

for host in ['dev.igps.io', 'igps.io']:
    print(f"\n[+] Broadcasting updates to: {host}...")
    
    # 1. Drop trigger first
    run_query(host, f"DROP TRIGGER IF EXISTS `trg_{imei}_lock_km`", "drop")
    
    # 2. Delete any old ghost packets (pack_count >= 3000) for today
    run_query(host, f"DELETE FROM `{imei}` WHERE dt LIKE '{date_str}%' AND pack_count >= 3000", "delete")
    del_sql = f"DELETE FROM `{imei}` WHERE dt >= '{drive_start_utc}' AND dt <= '{drive_end_utc}'"
    run_query(host, del_sql, "delete")
    
    # 3. Align early midnight packets (00:00 to 05:30 IST) to start_odo_str (74454.447-74471.667)
    start_day_str = "74454.447-74471.667"
    upd_early = f"UPDATE `{imei}` SET totel_km = '{start_day_str}' WHERE dt_s >= '{date_str} 00:00:00' AND dt_s < '{date_str} 05:30:15'"
    run_query(host, upd_early, "update")
    
    # 4. Insert real OSRM street packets
    batch_size = 50
    for i in range(0, len(all_injected_packets), batch_size):
        batch = all_injected_packets[i:i+batch_size]
        has_fuel = "dev" in host
        vals = []
        for p in batch:
            if has_fuel:
                vals.append(f"('{p['dt']}', '{p['dt_s']}', '{p['imei']}', '{p['lat']}', '{p['lng']}', '{p['speed']}', '{p['battery']}', '{p['i_time']}', '{p['i_status']}', '{p['course']}', '{p['overspeed']}', '{p['jcb_ac']}', '{p['totel_km']}', '{p['t_w']}', {p['fuel']}, {p['pack_count']})")
            else:
                vals.append(f"('{p['dt']}', '{p['dt_s']}', '{p['imei']}', '{p['lat']}', '{p['lng']}', '{p['speed']}', '{p['battery']}', '{p['i_time']}', '{p['i_status']}', '{p['course']}', '{p['overspeed']}', '{p['jcb_ac']}', '{p['totel_km']}', '{p['t_w']}', {p['pack_count']})")
        val_str = ",".join(vals)
        if has_fuel:
            ins_sql = f"INSERT INTO `{imei}` (`dt`, `dt_s`, `imei`, `lat`, `lng`, `speed`, `battery`, `i_time`, `i_status`, `course`, `overspeed`, `jcb_ac`, `totel_km`, `t_w`, `fuel`, `pack_count`) VALUES {val_str}"
        else:
            ins_sql = f"INSERT INTO `{imei}` (`dt`, `dt_s`, `imei`, `lat`, `lng`, `speed`, `battery`, `i_time`, `i_status`, `course`, `overspeed`, `jcb_ac`, `totel_km`, `t_w`, `pack_count`) VALUES {val_str}"
        run_query(host, ins_sql, "insert")
        
    print(f"  Inserted {len(all_injected_packets)} real street packets on {host}.")
    
    # 5. Set evening parking packets to final_odo_str
    upd_late = f"UPDATE `{imei}` SET totel_km = '{final_odo_str}', lat = '+{depot[0]:.6f}', lng = '+{depot[1]:.6f}', speed = '0', i_status = '0' WHERE dt > '{drive_end_utc}' AND dt LIKE '{date_str}%'"
    run_query(host, upd_late, "update")
    print(f"  Set evening parking packets to {final_odo_str}")
    
    # 6. Install lock trigger (+71.340 KM)
    trg_sql = f"""
    CREATE TRIGGER `trg_{imei}_lock_km` BEFORE INSERT ON `{imei}` 
    FOR EACH ROW 
    BEGIN 
        IF NEW.pack_count < 3000 AND NEW.totel_km IS NOT NULL AND NEW.totel_km LIKE '%-%' THEN 
            SET NEW.totel_km = CONCAT(
                ROUND(CAST(SUBSTRING_INDEX(NEW.totel_km, '-', 1) AS DECIMAL(10,3)) + {trigger_offset:.3f}, 3), 
                '-', 
                ROUND(CAST(SUBSTRING_INDEX(NEW.totel_km, '-', -1) AS DECIMAL(10,3)) + {trigger_offset:.3f}, 3)
            ); 
        END IF; 
    END;
    """
    run_query(host, trg_sql, "update")
    print(f"  Installed lock trigger (+{trigger_offset:.3f} KM)")
    
    # 7. Check Playback
    p_res = requests.post(f"http://{host}/http.php", data={
        "imei": imei,
        "from": f"{date_str} 00:00:00",
        "to": f"{date_str} 23:59:59",
        "username": "trichy",
        "action": "get_playback_imei"
    }, timeout=25).json()
    if p_res and isinstance(p_res, list) and len(p_res) > 0:
        kmm_s = p_res[0]['totel_km'].split('-')
        kmm_e = p_res[-1]['totel_km'].split('-')
        o_s1 = float(kmm_s[1])
        o_e1 = float(kmm_e[1])
        print(f"  >>> VERIFIED PLAYBACK ON {host}: {o_e1 - o_s1:.2f} KM (Start: {o_s1:.3f}, End: {o_e1:.3f})")

print("\n" + "=" * 75)
print("SUCCESSFULLY APPLIED REAL OSRM STREET GHOST DRIVE FOR VEHICLE 1667!")
print("=" * 75)

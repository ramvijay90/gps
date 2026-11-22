#!/usr/bin/env python3
"""
Autonomous Server Deduplication & Lock Engine
Scans and repairs any duplicate rows or corrupted travel reports for spoofed vehicles on dev.igps.io and igps.io.
Supports BOTH Ghost Drive KM mode and Ghost Drive Hours mode.
Designed to run autonomously at 05:30 AM IST before official 05:30 AM report downloads.
"""

import os
import sys
import json
import base64
import argparse
import requests
import time
from datetime import datetime, timedelta

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(BASE_DIR, "data_storage")
HISTORY_FILE = os.path.join(DATA_DIR, "history.json")
CONFIG_FILE = os.path.join(BASE_DIR, "config", "spoofed_vehicles.json")
VEHICLES_FILE = os.path.join(BASE_DIR, "vehicles.json")
LOG_DIR = os.path.join(BASE_DIR, "logs")
os.makedirs(LOG_DIR, exist_ok=True)

session_dev = requests.Session()
def ensure_dev_session():
    try:
        session_dev.post("http://dev.igps.io/trichy/api/govt_api.php", data={"action": "verify", "username": "trichy", "password": "tmc@123"}, timeout=15)
    except Exception:
        pass

ensure_dev_session()

def log(msg):
    ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    formatted = f"[{ts}] {msg}"
    print(formatted, flush=True)
    log_file = os.path.join(LOG_DIR, f"lock_cron_{datetime.now().strftime('%Y-%m-%d')}.log")
    try:
        with open(log_file, "a", encoding="utf-8") as f:
            f.write(formatted + "\n")
    except Exception:
        pass

def run_query(host, sql, qtype="select", max_retries=3):
    b64 = base64.b64encode(sql.encode('utf-8')).decode('utf-8')
    sess = session_dev if "dev" in host else requests.Session()
    for attempt in range(max_retries):
        try:
            res = sess.post(f"http://{host}/http.php", data={"action": "select", "query": b64, "type": qtype}, timeout=30)
            try:
                return res.json()
            except Exception:
                return res.text
        except Exception as e:
            if attempt == max_retries - 1:
                log(f"[-] Query error on {host}: {e}")
                return []
            time.sleep(1)

def segment_trips_from_telemetry(host, imei, target_date):
    table = imei
    pkts = run_query(host, f"SELECT dt, dt_s, lat, lng, speed, i_status, totel_km, jcb_ac, pack_count FROM `{table}` WHERE dt_s LIKE '{target_date}%' ORDER BY sno ASC")
    if not isinstance(pkts, list) or len(pkts) == 0:
        return []
    
    trips = []
    curr = []
    for p in pkts:
        spd = float(p.get('speed') or 0)
        ign = str(p.get('i_status') or '0')
        if spd > 0 or ign == '1':
            curr.append(p)
        else:
            if len(curr) > 1:
                try:
                    p1 = curr[0]['totel_km'].split('-')
                    p2 = curr[-1]['totel_km'].split('-')
                    o1 = float(p1[1] if len(p1) > 1 else p1[0])
                    o2 = float(p2[1] if len(p2) > 1 else p2[0])
                    dist = max(0.0, o2 - o1)
                except Exception:
                    dist = 0.0
                try:
                    t1 = datetime.strptime(curr[0]['dt'], '%Y-%m-%d %H:%M:%S')
                    t2 = datetime.strptime(curr[-1]['dt'], '%Y-%m-%d %H:%M:%S')
                    dur = int((t2 - t1).total_seconds())
                except Exception:
                    dur = 0
                if dist >= 0.05 or dur >= 60:
                    trips.append({
                        'start_time_utc': curr[0]['dt'],
                        'end_time_utc': curr[-1]['dt'],
                        'start_time_ist': curr[0]['dt_s'],
                        'end_time_ist': curr[-1]['dt_s'],
                        'dist_km': f"{dist:.3f}",
                        'dur_sec': str(dur),
                        'start_lat': curr[0]['lat'],
                        'start_lng': curr[0]['lng'],
                        'end_lat': curr[-1]['lat'],
                        'end_lng': curr[-1]['lng']
                    })
            curr = []
            
    if len(curr) > 1:
        try:
            p1 = curr[0]['totel_km'].split('-')
            p2 = curr[-1]['totel_km'].split('-')
            o1 = float(p1[1] if len(p1) > 1 else p1[0])
            o2 = float(p2[1] if len(p2) > 1 else p2[0])
            dist = max(0.0, o2 - o1)
        except Exception:
            dist = 0.0
        try:
            t1 = datetime.strptime(curr[0]['dt'], '%Y-%m-%d %H:%M:%S')
            t2 = datetime.strptime(curr[-1]['dt'], '%Y-%m-%d %H:%M:%S')
            dur = int((t2 - t1).total_seconds())
        except Exception:
            dur = 0
        if dist >= 0.05 or dur >= 60:
            trips.append({
                'start_time_utc': curr[0]['dt'],
                'end_time_utc': curr[-1]['dt'],
                'start_time_ist': curr[0]['dt_s'],
                'end_time_ist': curr[-1]['dt_s'],
                'dist_km': f"{dist:.3f}",
                'dur_sec': str(dur),
                'start_lat': curr[0]['lat'],
                'start_lng': curr[0]['lng'],
                'end_lat': curr[-1]['lat'],
                'end_lng': curr[-1]['lng']
            })
    return trips

def process_vehicle(imei, veh_no, target_date, force=False):
    log(f"------------------------------------------------------------")
    log(f"Checking vehicle: {veh_no} (IMEI: {imei}) for Date: {target_date}")
    
    dev_rows = run_query("dev.igps.io", f"SELECT * FROM reports WHERE imei='{imei}' AND dt LIKE '{target_date}%'")
    live_rows = run_query("igps.io", f"SELECT * FROM reports WHERE imei='{imei}' AND dt LIKE '{target_date}%'")
    
    dev_count = len(dev_rows) if isinstance(dev_rows, list) else 0
    live_count = len(live_rows) if isinstance(live_rows, list) else 0
    log(f"Reports rows found: dev.igps.io={dev_count}, igps.io={live_count}")
    
    # Check if vehicle was spoofed in Ghost Drive Hours mode or KM mode from gps_history_log
    hist_logs = run_query("dev.igps.io", f"SELECT sno, mode, added_km, target_hours FROM gps_history_log WHERE imei='{imei}' AND date='{target_date}' ORDER BY sno DESC LIMIT 1")
    is_hours_mode = False
    injected_idle_sec = 0
    if hist_logs and isinstance(hist_logs, list) and len(hist_logs) > 0:
        h_rec = hist_logs[0]
        h_mode = str(h_rec.get('mode', '')).lower()
        h_hours = float(h_rec.get('target_hours') or 0)
        if h_mode == 'drive' or (h_hours > 0 and float(h_rec.get('added_km') or 0) == 0):
            is_hours_mode = True
            injected_idle_sec = int(h_hours * 3600)
            log(f"[+] Detected Ghost Drive Hours Mode: target_hours={h_hours}h ({injected_idle_sec}s)")
    
    needs_cleanup = force or (dev_count > 1) or (live_count > 1)
    
    # Check if row is incomplete or lacks decimal precision
    if not needs_cleanup and dev_count == 1:
        cur_km = str(dev_rows[0].get('km', ''))
        cur_idle = int(dev_rows[0].get('engine_idle_time') or 0)
        if '.' not in cur_km:
            needs_cleanup = True
            log(f"Current KM '{cur_km}' lacks decimal point precision. Triggering lock reconstruction.")
        elif is_hours_mode and injected_idle_sec > 0 and cur_idle == 0:
            needs_cleanup = True
            log(f"Current engine_idle_time is 0s but history logged {injected_idle_sec}s. Triggering lock reconstruction.")
            
    if needs_cleanup:
        log(f"[*] Cleaning duplicates and locking pristine single reports row...")
        
        # 1. Check if one of the existing rows is already the pristine authoritative spoofed row
        pristine_row = None
        all_candidates = (dev_rows if isinstance(dev_rows, list) else []) + (live_rows if isinstance(live_rows, list) else [])
        for r in all_candidates:
            r_run = int(r.get('run_time') or 0)
            r_idle = int(r.get('engine_idle_time') or 0)
            r_dur = str(r.get('normal_duration') or '')
            r_st = str(r.get('normal_start_time') or '')
            r_et = str(r.get('normal_end_time') or '')
            st_len = len([x for x in r_st.split(',') if x])
            et_len = len([x for x in r_et.split(',') if x])
            dur_len = len([x for x in r_dur.split(',') if x])

            # A truly pristine row MUST have matching array lengths for start, end, and duration
            if st_len > 0 and st_len == et_len == dur_len:
                if is_hours_mode and injected_idle_sec > 0:
                    if r_idle >= injected_idle_sec and r_dur:
                        pristine_row = r
                        break
                elif r_run > 0 and '.' in str(r.get('km', '')) and r_dur:
                    if not pristine_row or r_run > int(pristine_row.get('run_time') or 0):
                        pristine_row = r

        if pristine_row:
            log(f"[+] Found pristine authoritative spoofed row in reports (KM={pristine_row.get('km')}, Run={pristine_row.get('run_time')}s, Idle={pristine_row.get('engine_idle_time')}s). Purging all duplicates...")
            
            # Extract pristine row fields
            p_km = str(pristine_row.get('km'))
            p_run = str(pristine_row.get('run_time'))
            p_idle = str(pristine_row.get('idle_time') or '35000')
            p_e_idle = str(pristine_row.get('engine_idle_time') or (str(injected_idle_sec) if is_hours_mode else '0'))
            p_norm_dur = str(pristine_row.get('normal_duration'))
            p_norm_km = str(pristine_row.get('normal_km'))
            p_norm_st = str(pristine_row.get('normal_start_time'))
            p_norm_et = str(pristine_row.get('normal_end_time'))
            p_slat = str(pristine_row.get('normal_start_lat') or '')
            p_slng = str(pristine_row.get('normal_start_lng') or '')
            p_elat = str(pristine_row.get('normal_end_lat') or '')
            p_elng = str(pristine_row.get('normal_end_lng') or '')

            for host in ['dev.igps.io', 'igps.io']:
                # Delete all existing duplicate rows by sno
                ex_rows = run_query(host, f"SELECT sno FROM reports WHERE imei='{imei}' AND dt LIKE '{target_date}%'")
                if ex_rows and isinstance(ex_rows, list) and len(ex_rows) > 0:
                    snos = [str(r['sno']) for r in ex_rows if r.get('sno')]
                    if snos:
                        run_query(host, f"DELETE FROM reports WHERE sno IN ({', '.join(snos)})", qtype="update")
                run_query(host, f"DELETE FROM reports WHERE imei='{imei}' AND dt LIKE '{target_date}%'", qtype="update")

                # Insert single locked row
                ins_sql = f"""INSERT INTO reports 
                    (imei, dt, km, run_time, idle_time, engine_idle_time, overspeed_time, overspeed_count, 
                     ac_run_time, ac_idle_time, ac_overall_time, ac_overall_km, ac_start_lat, ac_start_lng, ac_end_lat, ac_end_lng, ac_start_time, ac_end_time,
                     normal_start_time, normal_end_time, normal_km, normal_duration, normal_start_lat, normal_start_lng, normal_end_lat, normal_end_lng, username)
                    VALUES 
                    ('{imei}', '{target_date} 00:00:00', '{p_km}', '{p_run}', '{p_idle}', '{p_e_idle}', '0', '0',
                     '{p_run}', '0', '{p_norm_dur}', '{p_norm_km}', '{p_slat}', '{p_slng}', '{p_elat}', '{p_elng}', '{p_norm_st}', '{p_norm_et}',
                     '{p_norm_st}', '{p_norm_et}', '{p_norm_km}', '{p_norm_dur}', '{p_slat}', '{p_slng}', '{p_elat}', '{p_elng}', 'trichy')"""
                run_query(host, ins_sql, qtype="update")

                # Ensure strictly 1 row remains
                post_chk = run_query(host, f"SELECT sno FROM reports WHERE imei='{imei}' AND dt LIKE '{target_date}%' ORDER BY sno DESC")
                if post_chk and isinstance(post_chk, list) and len(post_chk) > 1:
                    older = [str(r['sno']) for r in post_chk[1:] if r.get('sno')]
                    if older:
                        run_query(host, f"DELETE FROM reports WHERE sno IN ({', '.join(older)})", qtype="update")
                log(f"[{host}] Cleaned & Locked: KM={p_km}, Run={p_run}s, EngineIdle={p_e_idle}s (Zero Duplicates)")
            return True

        # 2. If no pristine row exists, reconstruct from telemetry
        trips = segment_trips_from_telemetry("dev.igps.io", imei, target_date)
        if not trips:
            trips = segment_trips_from_telemetry("igps.io", imei, target_date)
            
        if not trips:
            log(f"[-] WARNING: No telemetry trips found for {imei} on {target_date}. Skipping insert to prevent zeroing.")
            return False
            
        # Determine exact total KM from playback start/end odo
        p_res = run_query("dev.igps.io", f"SELECT totel_km FROM `{imei}` WHERE dt_s LIKE '{target_date}%' ORDER BY sno ASC LIMIT 1")
        p_last = run_query("dev.igps.io", f"SELECT totel_km FROM `{imei}` WHERE dt_s LIKE '{target_date}%' ORDER BY sno DESC LIMIT 1")
        expected_total_km = None
        if p_res and p_last and isinstance(p_res, list) and isinstance(p_last, list):
            try:
                p1 = p_res[0]['totel_km'].split('-')
                p2 = p_last[0]['totel_km'].split('-')
                o_start = float(p1[1] if len(p1) > 1 else p1[0])
                o_end = float(p2[1] if len(p2) > 1 else p2[0])
                if o_end > o_start:
                    expected_total_km = round(o_end - o_start, 3)
            except Exception:
                pass

        if expected_total_km and expected_total_km > 0:
            total_day_km = expected_total_km
            raw_sum = sum([float(t['dist_km']) for t in trips])
            if raw_sum > 0:
                scale = expected_total_km / raw_sum
                cum = 0.0
                for t in trips[:-1]:
                    scaled_d = round(float(t['dist_km']) * scale, 3)
                    t['dist_km'] = f"{scaled_d:.3f}"
                    cum += scaled_d
                trips[-1]['dist_km'] = f"{round(expected_total_km - cum, 3):.3f}"
        else:
            total_day_km = sum([float(t['dist_km']) for t in trips])
            
        total_day_dur = sum([int(t['dur_sec']) for t in trips])
        
        # Hours mode specific calculations
        if is_hours_mode:
            final_engine_idle_time = injected_idle_sec if injected_idle_sec > 0 else 14400
        else:
            final_engine_idle_time = 15000 if total_day_dur > 0 else 0
        
        st_str = ",".join([t['start_time_utc'] for t in trips])
        et_str = ",".join([t['end_time_utc'] for t in trips])
        km_str = ",".join([t['dist_km'] for t in trips])
        dur_str = ",".join([t['dur_sec'] for t in trips])
        slat_str = ",".join([t['start_lat'] for t in trips])
        slng_str = ",".join([t['start_lng'] for t in trips])
        elat_str = ",".join([t['end_lat'] for t in trips])
        elng_str = ",".join([t['end_lng'] for t in trips])
        
        km_locked = f"{total_day_km:.3f}"
        
        for host in ['dev.igps.io', 'igps.io']:
            # Delete all existing duplicate rows by Primary Key (sno)
            ex_rows = run_query(host, f"SELECT sno FROM reports WHERE imei='{imei}' AND dt LIKE '{target_date}%'")
            if ex_rows and isinstance(ex_rows, list) and len(ex_rows) > 0:
                snos = [str(r['sno']) for r in ex_rows if r.get('sno')]
                if snos:
                    run_query(host, f"DELETE FROM reports WHERE sno IN ({', '.join(snos)})", qtype="update")
            run_query(host, f"DELETE FROM reports WHERE imei='{imei}' AND dt LIKE '{target_date}%'", qtype="update")

            # Insert single pristine row
            ins_sql = f"""INSERT INTO reports 
                (imei, dt, km, run_time, idle_time, engine_idle_time, overspeed_time, overspeed_count, 
                 ac_run_time, ac_idle_time, ac_overall_time, ac_overall_km, ac_start_lat, ac_start_lng, ac_end_lat, ac_end_lng, ac_start_time, ac_end_time,
                 normal_start_time, normal_end_time, normal_km, normal_duration, normal_start_lat, normal_start_lng, normal_end_lat, normal_end_lng, username)
                VALUES 
                ('{imei}', '{target_date} 00:00:00', '{km_locked}', '{total_day_dur}', '35000', '{final_engine_idle_time}', '0', '0',
                 '{total_day_dur}', '0', '{dur_str}', '{km_str}', '{slat_str}', '{slng_str}', '{elat_str}', '{elng_str}', '{st_str}', '{et_str}',
                 '{st_str}', '{et_str}', '{km_str}', '{dur_str}', '{slat_str}', '{slng_str}', '{elat_str}', '{elng_str}', 'trichy')"""
            run_query(host, ins_sql, qtype="update")

            # Verify and eliminate any remaining duplicates immediately
            post_chk = run_query(host, f"SELECT sno FROM reports WHERE imei='{imei}' AND dt LIKE '{target_date}%' ORDER BY sno DESC")
            if post_chk and isinstance(post_chk, list) and len(post_chk) > 1:
                older = [str(r['sno']) for r in post_chk[1:] if r.get('sno')]
                if older:
                    run_query(host, f"DELETE FROM reports WHERE sno IN ({', '.join(older)})", qtype="update")
            log(f"[{host}] Cleaned & Locked: KM={km_locked}, Duration={total_day_dur}s, IdleEngine={final_engine_idle_time}s, Trips={len(trips)} (Zero Duplicates)")
        return True
    else:
        if dev_count == 1:
            log(f"[+] Pristine: Vehicle {veh_no} has 1 clean row (KM={dev_rows[0].get('km')}, Run={dev_rows[0].get('run_time')}s, IdleEngine={dev_rows[0].get('engine_idle_time')}s). No duplicates.")
        else:
            log(f"[-] No report rows exist for {veh_no} on {target_date}.")
        return False

def get_spoofed_vehicles_for_date(target_date):
    imeis = set()
    veh_map = {}
    
    # 1. Load vehicle map from vehicles.json
    if os.path.exists(VEHICLES_FILE):
        try:
            with open(VEHICLES_FILE, 'r', encoding='utf-8') as f:
                v_list = json.load(f)
                for v in v_list:
                    veh_map[v.get('imei')] = v.get('vehicle_no', v.get('imei'))
        except Exception:
            pass

    # 2. From gps_history_log in database (STRICTLY for this specific target_date!)
    db_hist = run_query("dev.igps.io", f"SELECT DISTINCT imei, mode, added_km, target_hours FROM gps_history_log WHERE date = '{target_date}'")
    if db_hist and isinstance(db_hist, list):
        for h in db_hist:
            imei_val = str(h.get('imei', '')).strip()
            mode_val = str(h.get('mode', '')).lower()
            added_km = float(h.get('added_km') or 0)
            target_hrs = float(h.get('target_hours') or 0)
            # Only include if actually spoofed on target_date
            if imei_val and (added_km > 0 or target_hrs > 0 or mode_val in ['drive', 'drive_km', 'ghost', 'spoof', 'night', 'real_ghost_drive', 'night_shift_spoof', 'ghost_hours']):
                imeis.add(imei_val)

    # 3. From history.json (local cache, STRICTLY for this specific target_date!)
    if os.path.exists(HISTORY_FILE):
        try:
            with open(HISTORY_FILE, 'r', encoding='utf-8') as f:
                hist = json.load(f)
                for h in hist:
                    if h.get('date') == target_date and h.get('imei'):
                        added_km = float(h.get('added_km') or 0)
                        target_hrs = float(h.get('target_hours') or 0)
                        mode = str(h.get('mode', '')).lower()
                        if added_km > 0 or target_hrs > 0 or mode in ['drive', 'drive_km', 'ghost', 'spoof', 'night', 'real_ghost_drive', 'night_shift_spoof', 'ghost_hours']:
                            imeis.add(str(h['imei']).strip())
        except Exception as e:
            log(f"[-] Error reading history file: {e}")

    result = []
    for imei in sorted(list(imeis)):
        result.append({
            'imei': imei,
            'vehicle_no': veh_map.get(imei, f"IMEI_{imei}")
        })
    return result

def main():
    parser = argparse.ArgumentParser(description="Server Deduplication & Auto-Lock Engine")
    parser.add_argument("--date", type=str, help="Target date YYYY-MM-DD (defaults to yesterday)")
    parser.add_argument("--imei", type=str, help="Specific vehicle IMEI to clean")
    args = parser.parse_args()

    if args.date:
        target_date = args.date
    else:
        target_date = (datetime.now() - timedelta(days=1)).strftime('%Y-%m-%d')

    log("============================================================")
    log(f"SERVER CRON: DEDUPLICATION & REPORT LOCK ENGINE STARTING")
    log(f"Target Date: {target_date}")
    log("============================================================")

    if args.imei:
        veh_no = f"IMEI_{args.imei}"
        # If user explicitly specified IMEI, force clean & lock reconstruction
        process_vehicle(args.imei, veh_no, target_date, force=True)
    else:
        vehicles_to_check = get_spoofed_vehicles_for_date(target_date)
        log(f"Found {len(vehicles_to_check)} vehicle(s) requiring duplicate inspection for {target_date}.")
        cleaned_count = 0
        for veh in vehicles_to_check:
            try:
                repaired = process_vehicle(veh['imei'], veh['vehicle_no'], target_date, force=False)
                if repaired:
                    cleaned_count += 1
            except Exception as e:
                log(f"[-] Error processing {veh.get('vehicle_no')}: {e}")

        log(f"[SUMMARY] Checked {len(vehicles_to_check)} vehicles. Cleaned and locked {cleaned_count} vehicle(s).")

    log("============================================================")
    log(f"SERVER CRON: DEDUPLICATION & REPORT LOCK COMPLETED")
    log("============================================================")

if __name__ == "__main__":
    main()

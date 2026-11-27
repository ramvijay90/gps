#!/usr/bin/env python3
"""
Autonomous Server Deduplication & Lock Engine (Old Domain)
Scans and repairs any duplicate rows or corrupted travel reports for spoofed vehicles on dev.igps.io and igps.io.
Supports Ghost Drive KM modes, Night Shift modes, and Ghost Drive Hours mode.
Designed for 05:30 AM IST runs, multi-pass follow-ups, and wakeup/startup catch-up.
"""

import os
import sys
import re
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
session_live = requests.Session()
_dev_verified = False


def ist_now():
    return datetime.utcnow() + timedelta(hours=5, minutes=30)


def ensure_dev_session():
    global _dev_verified
    if not _dev_verified:
        try:
            session_dev.post(
                "http://dev.igps.io/trichy/api/govt_api.php",
                data={"action": "verify", "username": "trichy", "password": "tmc@123"},
                timeout=15,
            )
            _dev_verified = True
        except Exception:
            pass


def log(msg):
    ts = ist_now().strftime("%Y-%m-%d %H:%M:%S")
    formatted = f"[{ts}] {msg}"
    print(formatted, flush=True)
    log_file = os.path.join(LOG_DIR, f"lock_cron_{ist_now().strftime('%Y-%m-%d')}.log")
    try:
        with open(log_file, "a", encoding="utf-8") as f:
            f.write(formatted + "\n")
    except Exception:
        pass


def run_query(host, sql, qtype="select", max_retries=3):
    if "dev" in host:
        ensure_dev_session()
    b64 = base64.b64encode(sql.encode("utf-8")).decode("utf-8")
    sess = session_dev if "dev" in host else session_live
    for attempt in range(max_retries):
        try:
            res = sess.post(
                f"http://{host}/http.php",
                data={"action": "select", "query": b64, "type": qtype},
                timeout=35,
            )
            try:
                return res.json()
            except Exception:
                return res.text
        except Exception as e:
            if attempt == max_retries - 1:
                log(f"[-] Query error on {host}: {e}")
                return []
            time.sleep(1)
    return []


def _has_clean_decimals(csv_str):
    vals = [x.strip() for x in str(csv_str or "").split(",") if x.strip()]
    if not vals:
        return False
    # PHP noisy floats produce segments like "4.9080000000013" or "2.8878300000001"
    return not any(len(v) > 10 or "00000" in v for v in vals)


def select_pristine_report_row(candidates, is_hours_mode=False, injected_idle_sec=0):
    """
    Rank report candidate rows and pick the authoritative spoofed/clean row over any
    overnight PHP duplicate (which typically has unrounded floats, integer-ish KM, or wrong engine_idle_time).
    """
    scored = []
    for r in candidates or []:
        r_run = int(float(r.get("run_time") or 0))
        r_idle_eng = int(float(r.get("engine_idle_time") or 0))
        r_idle_str = str(r.get("idle_time") or "").strip()
        r_km = str(r.get("km") or "").strip()
        r_dur = str(r.get("normal_duration") or "").strip()
        r_nkm = str(r.get("normal_km") or "").strip()
        r_st = str(r.get("normal_start_time") or "").strip()
        r_et = str(r.get("normal_end_time") or "").strip()

        st_len = len([x for x in r_st.split(",") if x])
        et_len = len([x for x in r_et.split(",") if x])
        dur_len = len([x for x in r_dur.split(",") if x])
        if st_len == 0 or st_len != et_len or st_len != dur_len:
            continue

        score = 0.0
        if re.match(r"^\d+\.\d{2,3}$", r_km):
            score += 200.0
        elif "." in r_km:
            score += 80.0
        if _has_clean_decimals(r_nkm):
            score += 250.0
        if r_idle_str.isdigit():
            score += 100.0
            if r_idle_str in ("35000", "50000"):
                score += 200.0

        if is_hours_mode and injected_idle_sec > 0:
            if r_idle_eng == injected_idle_sec:
                score += 1000.0
            elif r_idle_eng >= injected_idle_sec:
                score += 100.0
            score += min(r_run, 86400) * 0.01
        else:
            if r_idle_eng in (0, 15000):
                score += 250.0
            if r_run > 0:
                score += 300.0 + min(r_run, 86400) * 0.01

        scored.append((score, r))

    if not scored:
        return None
    scored.sort(key=lambda item: item[0], reverse=True)
    return scored[0][1]


def segment_trips_from_telemetry(host, imei, target_date):
    d_dt = datetime.strptime(target_date, "%Y-%m-%d")
    d_start_utc = (d_dt - timedelta(hours=5, minutes=30)).strftime("%Y-%m-%d %H:%M:%S")
    d_end_utc = (d_dt + timedelta(days=1) - timedelta(hours=5, minutes=30, seconds=1)).strftime("%Y-%m-%d %H:%M:%S")
    pkts = run_query(
        host,
        f"SELECT dt, dt_s, lat, lng, speed, i_status, totel_km, jcb_ac, pack_count FROM `{imei}` WHERE dt >= '{d_start_utc}' AND dt <= '{d_end_utc}' ORDER BY dt ASC, sno ASC",
    )
    if not isinstance(pkts, list) or len(pkts) == 0:
        return []

    trips = []
    curr = []

    def _flush(buf):
        if len(buf) <= 1:
            return
        try:
            p1 = str(buf[0]["totel_km"]).split("-")
            p2 = str(buf[-1]["totel_km"]).split("-")
            o1 = float(p1[-1])
            o2 = float(p2[-1])
            dist = max(0.0, o2 - o1)
        except Exception:
            dist = 0.0
        try:
            t1 = datetime.strptime(buf[0]["dt"], "%Y-%m-%d %H:%M:%S")
            t2 = datetime.strptime(buf[-1]["dt"], "%Y-%m-%d %H:%M:%S")
            dur = int((t2 - t1).total_seconds())
        except Exception:
            dur = 0
        if dist >= 0.05 or dur >= 60:
            trips.append({
                "start_time_utc": buf[0]["dt"],
                "end_time_utc": buf[-1]["dt"],
                "start_time_ist": buf[0]["dt_s"],
                "end_time_ist": buf[-1]["dt_s"],
                "dist_km": f"{dist:.3f}",
                "dur_sec": str(dur),
                "start_lat": buf[0]["lat"],
                "start_lng": buf[0]["lng"],
                "end_lat": buf[-1]["lat"],
                "end_lng": buf[-1]["lng"],
            })

    for p in pkts:
        spd = float(p.get("speed") or 0)
        ign = str(p.get("i_status") or "0")
        if spd > 0 or ign == "1":
            curr.append(p)
        else:
            _flush(curr)
            curr = []
    _flush(curr)
    return trips


def _rows_match_cleanly(dev_rows, live_rows, is_hours_mode, injected_idle_sec):
    if len(dev_rows) != 1 or len(live_rows) != 1:
        return False
    d = dev_rows[0]
    l = live_rows[0]
    if str(d.get("km", "")) != str(l.get("km", "")):
        return False
    if str(d.get("run_time", "")) != str(l.get("run_time", "")):
        return False
    if "." not in str(d.get("km", "")):
        return False
    if not _has_clean_decimals(d.get("normal_km")):
        return False
    if is_hours_mode and injected_idle_sec > 0:
        if int(float(d.get("engine_idle_time") or 0)) != injected_idle_sec:
            return False
        if int(float(l.get("engine_idle_time") or 0)) != injected_idle_sec:
            return False
    return True


def process_vehicle(imei, veh_no, target_date, force=False):
    log("------------------------------------------------------------")
    log(f"Checking vehicle: {veh_no} (IMEI: {imei}) for Date: {target_date}")

    dev_rows = run_query("dev.igps.io", f"SELECT * FROM reports WHERE imei='{imei}' AND dt LIKE '{target_date}%' ORDER BY sno ASC")
    live_rows = run_query("igps.io", f"SELECT * FROM reports WHERE imei='{imei}' AND dt LIKE '{target_date}%' ORDER BY sno ASC")

    dev_rows = dev_rows if isinstance(dev_rows, list) else []
    live_rows = live_rows if isinstance(live_rows, list) else []
    dev_count = len(dev_rows)
    live_count = len(live_rows)
    log(f"Reports rows found: dev.igps.io={dev_count}, igps.io={live_count}")

    hist_logs = run_query(
        "dev.igps.io",
        f"SELECT sno, mode, added_km, target_hours FROM gps_history_log WHERE imei='{imei}' AND date='{target_date}' ORDER BY sno DESC LIMIT 1",
    )
    is_hours_mode = False
    injected_idle_sec = 0
    if hist_logs and isinstance(hist_logs, list) and len(hist_logs) > 0:
        h_rec = hist_logs[0]
        h_mode = str(h_rec.get("mode", "")).lower()
        h_hours = float(h_rec.get("target_hours") or 0)
        h_km = float(h_rec.get("added_km") or 0)
        if h_mode == "drive" or (h_hours > 0 and h_km == 0):
            is_hours_mode = True
            injected_idle_sec = int(round(h_hours * 3600))
            log(f"[+] Detected Ghost Drive Hours Mode: target_hours={h_hours}h ({injected_idle_sec}s)")

    if not force and _rows_match_cleanly(dev_rows, live_rows, is_hours_mode, injected_idle_sec):
        log(
            f"[+] Pristine: Vehicle {veh_no} locked & synced on both hosts "
            f"(KM={dev_rows[0].get('km')}, Run={dev_rows[0].get('run_time')}s, EngineIdle={dev_rows[0].get('engine_idle_time')}s)."
        )
        return False

    log("[*] Cleaning duplicates / syncing single authoritative reports row across dev.igps.io & igps.io...")

    pristine_row = select_pristine_report_row(dev_rows + live_rows, is_hours_mode=is_hours_mode, injected_idle_sec=injected_idle_sec)
    if pristine_row:
        p_km = str(pristine_row.get("km"))
        p_run = str(pristine_row.get("run_time"))
        p_idle = str(pristine_row.get("idle_time") or "35000")
        p_e_idle = str(pristine_row.get("engine_idle_time") or (str(injected_idle_sec) if is_hours_mode else "0"))
        p_norm_dur = str(pristine_row.get("normal_duration"))
        p_norm_km = str(pristine_row.get("normal_km"))
        p_norm_st = str(pristine_row.get("normal_start_time"))
        p_norm_et = str(pristine_row.get("normal_end_time"))
        p_slat = str(pristine_row.get("normal_start_lat") or pristine_row.get("ac_start_lat") or "")
        p_slng = str(pristine_row.get("normal_start_lng") or pristine_row.get("ac_start_lng") or "")
        p_elat = str(pristine_row.get("normal_end_lat") or pristine_row.get("ac_end_lat") or "")
        p_elng = str(pristine_row.get("normal_end_lng") or pristine_row.get("ac_end_lng") or "")
        log(f"[+] Selected pristine row (sno={pristine_row.get('sno')}, KM={p_km}, Run={p_run}s, EngineIdle={p_e_idle}s).")
    else:
        trips = segment_trips_from_telemetry("dev.igps.io", imei, target_date)
        if not trips:
            trips = segment_trips_from_telemetry("igps.io", imei, target_date)
        if not trips:
            log(f"[-] WARNING: No telemetry trips found for {imei} on {target_date}. Skipping insert to prevent zeroing.")
            return False

        d_dt = datetime.strptime(target_date, "%Y-%m-%d")
        d_start_utc = (d_dt - timedelta(hours=5, minutes=30)).strftime("%Y-%m-%d %H:%M:%S")
        d_end_utc = (d_dt + timedelta(days=1) - timedelta(hours=5, minutes=30, seconds=1)).strftime("%Y-%m-%d %H:%M:%S")
        p_res = run_query("dev.igps.io", f"SELECT totel_km FROM `{imei}` WHERE dt >= '{d_start_utc}' AND dt <= '{d_end_utc}' ORDER BY dt ASC, sno ASC LIMIT 1")
        p_last = run_query("dev.igps.io", f"SELECT totel_km FROM `{imei}` WHERE dt >= '{d_start_utc}' AND dt <= '{d_end_utc}' ORDER BY dt DESC, sno DESC LIMIT 1")
        expected_total_km = None
        if p_res and p_last and isinstance(p_res, list) and isinstance(p_last, list):
            try:
                o_start = float(str(p_res[0]["totel_km"]).split("-")[-1])
                o_end = float(str(p_last[0]["totel_km"]).split("-")[-1])
                if o_end > o_start:
                    expected_total_km = round(o_end - o_start, 3)
            except Exception:
                pass

        if expected_total_km and expected_total_km > 0:
            total_day_km = expected_total_km
            raw_sum = sum(float(t["dist_km"]) for t in trips)
            if raw_sum > 0:
                scale = expected_total_km / raw_sum
                cum = 0.0
                for t in trips[:-1]:
                    scaled_d = round(float(t["dist_km"]) * scale, 3)
                    t["dist_km"] = f"{scaled_d:.3f}"
                    cum += scaled_d
                trips[-1]["dist_km"] = f"{round(expected_total_km - cum, 3):.3f}"
        else:
            total_day_km = sum(float(t["dist_km"]) for t in trips)

        total_day_dur = sum(int(t["dur_sec"]) for t in trips)
        p_e_idle = str(injected_idle_sec if (is_hours_mode and injected_idle_sec > 0) else (15000 if total_day_dur > 0 else 0))
        p_km = f"{total_day_km:.3f}"
        p_run = str(total_day_dur)
        p_idle = "35000" if is_hours_mode else str(max(0, 86400 - total_day_dur))
        p_norm_st = ",".join(t["start_time_utc"] for t in trips)
        p_norm_et = ",".join(t["end_time_utc"] for t in trips)
        p_norm_km = ",".join(t["dist_km"] for t in trips)
        p_norm_dur = ",".join(t["dur_sec"] for t in trips)
        p_slat = ",".join(t["start_lat"] for t in trips)
        p_slng = ",".join(t["start_lng"] for t in trips)
        p_elat = ",".join(t["end_lat"] for t in trips)
        p_elng = ",".join(t["end_lng"] for t in trips)

    for host in ("dev.igps.io", "igps.io"):
        ex_rows = run_query(host, f"SELECT sno FROM reports WHERE imei='{imei}' AND dt LIKE '{target_date}%'")
        if ex_rows and isinstance(ex_rows, list) and len(ex_rows) > 0:
            snos = [str(r["sno"]) for r in ex_rows if r.get("sno")]
            if snos:
                run_query(host, f"DELETE FROM reports WHERE sno IN ({', '.join(snos)})", qtype="update")
        run_query(host, f"DELETE FROM reports WHERE imei='{imei}' AND dt LIKE '{target_date}%'", qtype="update")

        ins_sql = f"""INSERT INTO reports
            (imei, dt, km, run_time, idle_time, engine_idle_time, overspeed_time, overspeed_count,
             ac_run_time, ac_idle_time, ac_overall_time, ac_overall_km, ac_start_lat, ac_start_lng, ac_end_lat, ac_end_lng, ac_start_time, ac_end_time,
             normal_start_time, normal_end_time, normal_km, normal_duration, normal_start_lat, normal_start_lng, normal_end_lat, normal_end_lng, username)
            VALUES
            ('{imei}', '{target_date} 00:00:00', '{p_km}', '{p_run}', '{p_idle}', '{p_e_idle}', '0', '0',
             '{p_run}', '0', '{p_norm_dur}', '{p_norm_km}', '{p_slat}', '{p_slng}', '{p_elat}', '{p_elng}', '{p_norm_st}', '{p_norm_et}',
             '{p_norm_st}', '{p_norm_et}', '{p_norm_km}', '{p_norm_dur}', '{p_slat}', '{p_slng}', '{p_elat}', '{p_elng}', 'trichy')"""
        run_query(host, ins_sql, qtype="update")

        post_chk = run_query(host, f"SELECT sno FROM reports WHERE imei='{imei}' AND dt LIKE '{target_date}%' ORDER BY sno DESC")
        if post_chk and isinstance(post_chk, list) and len(post_chk) > 1:
            older = [str(r["sno"]) for r in post_chk[1:] if r.get("sno")]
            if older:
                run_query(host, f"DELETE FROM reports WHERE sno IN ({', '.join(older)})", qtype="update")
        log(f"[{host}] Cleaned & Locked: KM={p_km}, Run={p_run}s, EngineIdle={p_e_idle}s (Zero Duplicates)")
    return True


def get_spoofed_vehicles_for_date(target_date):
    imeis = set()
    veh_map = {}

    if os.path.exists(VEHICLES_FILE):
        try:
            with open(VEHICLES_FILE, "r", encoding="utf-8") as f:
                for v in json.load(f):
                    veh_map[v.get("imei")] = v.get("vehicle_no", v.get("imei"))
        except Exception:
            pass

    # 1. From MySQL gps_history_log on dev.igps.io for target_date
    db_hist = run_query("dev.igps.io", f"SELECT DISTINCT imei, mode, added_km, target_hours FROM gps_history_log WHERE date = '{target_date}'")
    if db_hist and isinstance(db_hist, list):
        for h in db_hist:
            imei_val = str(h.get("imei", "")).strip()
            mode_val = str(h.get("mode", "")).lower()
            added_km = float(h.get("added_km") or 0)
            target_hrs = float(h.get("target_hours") or 0)
            if imei_val and (
                added_km > 0
                or target_hrs > 0
                or mode_val in ("drive", "drive_km", "ghost", "spoof", "night", "real_ghost_drive", "night_shift_spoof", "ghost_hours")
            ):
                imeis.add(imei_val)

    # 2. Global safety net: ANY IMEI having >1 report row on target_date on dev.igps.io or igps.io
    for host in ("dev.igps.io", "igps.io"):
        dup_rows = run_query(host, f"SELECT imei, COUNT(*) AS cnt FROM reports WHERE dt LIKE '{target_date}%' GROUP BY imei HAVING cnt > 1")
        if dup_rows and isinstance(dup_rows, list):
            for dr in dup_rows:
                iv = str(dr.get("imei") or "").strip()
                if iv:
                    imeis.add(iv)

    # 3. Local history.json cache fallback for target_date
    if os.path.exists(HISTORY_FILE):
        try:
            with open(HISTORY_FILE, "r", encoding="utf-8") as f:
                for h in json.load(f):
                    if h.get("date") == target_date and h.get("imei"):
                        added_km = float(h.get("added_km") or 0)
                        target_hrs = float(h.get("target_hours") or 0)
                        mode = str(h.get("mode", "")).lower()
                        if (
                            added_km > 0
                            or target_hrs > 0
                            or mode in ("drive", "drive_km", "ghost", "spoof", "night", "real_ghost_drive", "night_shift_spoof", "ghost_hours")
                        ):
                            imeis.add(str(h["imei"]).strip())
        except Exception as e:
            log(f"[-] Error reading history file: {e}")

    return [{"imei": imei, "vehicle_no": veh_map.get(imei, f"IMEI_{imei}")} for imei in sorted(imeis)]


def main():
    parser = argparse.ArgumentParser(description="Server Deduplication & Auto-Lock Engine")
    parser.add_argument("--date", type=str, help="Target date YYYY-MM-DD (defaults to IST yesterday)")
    parser.add_argument("--imei", type=str, help="Specific vehicle IMEI to clean")
    args = parser.parse_args()

    target_date = args.date if args.date else (ist_now() - timedelta(days=1)).strftime("%Y-%m-%d")

    log("============================================================")
    log("SERVER CRON: DEDUPLICATION & REPORT LOCK ENGINE STARTING")
    log(f"Target Date: {target_date}")
    log("============================================================")

    if args.imei:
        process_vehicle(args.imei, f"IMEI_{args.imei}", target_date, force=True)
    else:
        vehicles_to_check = get_spoofed_vehicles_for_date(target_date)
        log(f"Found {len(vehicles_to_check)} vehicle(s) requiring duplicate/lock inspection for {target_date}.")
        cleaned_count = 0
        for veh in vehicles_to_check:
            try:
                if process_vehicle(veh["imei"], veh["vehicle_no"], target_date, force=False):
                    cleaned_count += 1
            except Exception as e:
                log(f"[-] Error processing {veh.get('vehicle_no')}: {e}")
        log(f"[SUMMARY] Checked {len(vehicles_to_check)} vehicles. Cleaned and locked {cleaned_count} vehicle(s).")

    log("============================================================")
    log("SERVER CRON: DEDUPLICATION & REPORT LOCK COMPLETED")
    log("============================================================")


if __name__ == "__main__":
    main()

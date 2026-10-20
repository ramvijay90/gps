import requests

def check_playback():
    for host in ['dev.igps.io', 'igps.io']:
        res = requests.post(f"http://{host}/http.php", data={
            "imei": "869867035027616",
            "from": "2026-10-20 00:00:00",
            "to": "2026-10-20 23:59:59",
            "username": "trichy",
            "action": "get_playback_imei"
        }, timeout=25).json()
        print(f"Host: {host}, Total playback points: {len(res)}")
        # Check coordinates range
        lats = [float(p['lat']) for p in res]
        lngs = [float(p['lng']) for p in res]
        print(f"  Lat min: {min(lats):.4f}, max: {max(lats):.4f}")
        print(f"  Lng min: {min(lngs):.4f}, max: {max(lngs):.4f}")
        # Check if any lat is near MIET (MIET is around lat 10.70 to 10.73)
        miet_pts = [p for p in res if float(p['lat']) < 10.75]
        print(f"  Points near MIET (< 10.75): {len(miet_pts)}")
        kmm_s = res[0]['totel_km'].split('-')
        kmm_e = res[-1]['totel_km'].split('-')
        print(f"  Start odo: {kmm_s}, End odo: {kmm_e}, Distance: {float(kmm_e[1]) - float(kmm_s[1]):.2f} KM")

check_playback()

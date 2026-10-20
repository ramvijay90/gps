import requests, base64

sess = requests.Session()
sess.post("http://dev.igps.io/trichy/api/govt_api.php", data={"action": "verify", "username": "trichy", "password": "tmc@123"})

for imei in ['869925071609026', '869867035027616']:
    sql = f"SELECT dt, dt_s, totel_km, speed, pack_count FROM `{imei}` ORDER BY dt DESC LIMIT 3"
    b64 = base64.b64encode(sql.encode('utf-8')).decode('utf-8')
    res = sess.post("http://dev.igps.io/http.php", data={"action": "select", "query": b64, "type": "select"}).text
    print(imei, "LAST 3:")
    print(res)

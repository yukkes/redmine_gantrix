"""End-to-end check against a running Redmine: python3 docker/dev/smoke_test.py 3006"""
import http.cookiejar, json, re, sys, urllib.request, urllib.parse

# the published port (3006) or the container's address (172.19.0.3:3000, as docker/dev/test_all.sh passes it)
target = sys.argv[1] if len(sys.argv) > 1 else "3006"
base = f"http://{target if ':' in target else '127.0.0.1:' + target}"
jar = http.cookiejar.CookieJar()
op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))

def req(method, path, body=None, form=False, token=None):
    data, headers = None, {"Accept": "application/json" if "/gantrix/api/" in path else "text/html"}
    if body is not None:
        if form:
            data = urllib.parse.urlencode(body).encode()
        else:
            data = json.dumps(body).encode(); headers["Content-Type"] = "application/json"
    if token: headers["X-CSRF-Token"] = token
    r = urllib.request.Request(base + path, data=data, method=method, headers=headers)
    try:
        with op.open(r, timeout=30) as res:
            return res.status, res.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()

def csrf(html):
    return re.search(r'name="csrf-token" content="([^"]+)"', html).group(1)

_, html = req("GET", "/login")
st, _ = req("POST", "/login", {"username": "admin", "password": "admin", "authenticity_token": csrf(html)}, form=True)
st, html = req("GET", "/projects/demo/gantrix")
assert st == 200 and 'id="gantrix-schedule"' in html, (st, html[:300])
tok = csrf(html)
for asset in re.findall(r'(?:src|href)="([^"]*gantrix[^"]*\.(?:js|css)[^"]*)"', html):
    s, _ = req("GET", asset.replace(base, ""))
    assert s == 200, ("asset", asset, s)
    print("asset ok", asset)

def data(query=""):
    s, b = req("GET", "/projects/demo/gantrix/api/schedule" + query)
    assert s == 200, b[:300]
    d = json.loads(b)
    # tasks come as columns + rows
    d["tasks"] = [dict(zip(d["tasks"]["columns"], r)) for r in d["tasks"]["rows"]]
    return d

d = data()
tasks = {t["subject"]: t for t in d["tasks"]}
print(len(d["tasks"]), "tasks,", len(d["relations"]), "relations,", len(d["calendar"]["holidays"]), "holidays")
assert d["permissions"]["edit"]

# progress + actuals
t = tasks["画面設計"]
s, b = req("PATCH", f"/projects/demo/gantrix/api/tasks/{t['id']}", {"task": {"done_ratio": "50", "actual_start_date": t["start_date"]}}, token=tok)
assert s == 200, b
# move predecessor's due date later -> successors must be pushed
before = tasks["基本設計レビュー"]["start_date"]
s, b = req("PATCH", f"/projects/demo/gantrix/api/tasks/{t['id']}", {"task": {"due_date": "2027-03-01"}}, token=tok)
assert s == 200, b
after = {x["subject"]: x for x in data()["tasks"]}
assert after["画面設計"]["done_ratio"] == 50
assert after["基本設計レビュー"]["start_date"] > "2027-03-01", (before, after["基本設計レビュー"])
print("push ok:", before, "->", after["基本設計レビュー"]["start_date"])

# baseline, then reschedule +3 working days with successors
s, b = req("POST", "/projects/demo/gantrix/api/baselines", {"name": "当初計画"}, token=tok)
assert s == 200, b
bid = json.loads(b)["id"]
rv = after["詳細設計"]
s, b = req("POST", "/projects/demo/gantrix/api/reschedule", {"issue_ids": [rv["id"]], "days": 3, "with_successors": True, "notes": "テスト"}, token=tok)
assert s == 200, b
print("reschedule:", b)
d2 = data(f"?baseline_id={bid}")
x = {t["subject"]: t for t in d2["tasks"]}
assert x["詳細設計"]["start_date"] > rv["start_date"]
# the baseline is rebuilt from journals: it must still show the dates before the reschedule
assert d2["baseline_items"][str(rv["id"])][0] == rv["start_date"], (d2["baseline_items"][str(rv["id"])], rv["start_date"])
print("baseline rebuilt from journals:", rv["start_date"], "->", x["詳細設計"]["start_date"])

# add / indent / outdent / move / predecessors / delete
s, b = req("POST", "/projects/demo/gantrix/api/tasks", {"subject": "追加タスク", "after_id": x["結合テスト"]["id"]}, token=tok)
assert s == 200, b
nid = json.loads(b)["id"]
for dirn in ["up", "indent", "outdent", "down"]:
    s, b = req("POST", f"/projects/demo/gantrix/api/tasks/{nid}/move", {"direction": dirn}, token=tok)
    print("move", dirn, s, b[:120])
s, b = req("PATCH", f"/projects/demo/gantrix/api/tasks/{nid}", {"task": {"predecessors": str(x['単体テスト']['id']), "assigned_to_id": str(d['users'][0]['id'])}}, token=tok)
assert s == 200, b
n = next(t for t in data()["tasks"] if t["id"] == nid)
assert n["start_date"] > x["単体テスト"]["due_date"], n
# actual dates are stored in issue custom fields
s, b = req("PATCH", f"/projects/demo/gantrix/api/tasks/{nid}", {"task": {"actual_start_date": "2026-10-01"}}, token=tok)
assert s == 200, b
assert next(t for t in data()["tasks"] if t["id"] == nid)["actual_start_date"] == "2026-10-01"
# baseline taken while the task exists, then the task goes to the trash
s, b = req("POST", "/projects/demo/gantrix/api/baselines", {"name": "削除前"}, token=tok)
bid2 = json.loads(b)["id"]
s, b = req("DELETE", f"/projects/demo/gantrix/api/tasks/{nid}", token=tok)
assert s == 200, b
d3 = data(f"?baseline_id={bid2}")
if d3["trash"]:
    assert d3["baseline_items"][str(nid)][2] is True, d3["baseline_items"].get(str(nid))
    print("trashed task kept in the baseline as deleted")
req("DELETE", f"/projects/demo/gantrix/api/baselines/{bid2}", token=tok)
s, b = req("DELETE", f"/projects/demo/gantrix/api/baselines/{bid}", token=tok)
assert s == 200, b
import datetime
final = data()
hol = set(final["calendar"]["holidays"])
parents = {t["parent_id"] for t in final["tasks"]}
for t in final["tasks"]:
    if t["id"] in parents or not t["start_date"]:
        continue
    d0 = datetime.date.fromisoformat(t["start_date"])
    assert d0.isoweekday() < 6 and t["start_date"] not in hol, ("starts on non-working day", t["subject"], t["start_date"])
print("ALL OK", base)

# ---- holiday settings (admin): Cabinet Office CSV cache, CSV import
def multipart(path, fields, filename, content, token):
    boundary = "----gantrix" + str(abs(hash(content)))
    parts = []
    for k, v in fields.items():
        parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode())
    parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{filename}"\r\nContent-Type: text/csv\r\n\r\n'.encode() + content + b"\r\n")
    parts.append(f"--{boundary}--\r\n".encode())
    r = urllib.request.Request(base + path, data=b"".join(parts), method="POST",
                               headers={"Content-Type": f"multipart/form-data; boundary={boundary}", "X-CSRF-Token": token})
    with op.open(r, timeout=30) as res:
        return res.status, res.read().decode()

s, html = req("GET", "/admin/gantrix")
assert s == 200 and "holiday_source" in html, (s, html[:200])
tok = csrf(html)
s, html = req("POST", "/admin/gantrix/holidays/refresh", {"authenticity_token": tok}, form=True)
assert s == 200, s
s, html = req("GET", "/admin/gantrix?year=2027")
assert "2027-01-01" in html or "2027/01/01" in html, "2027 holidays not listed"
print("cao fetched:", re.search(r'(最終取得[^<]*|Last downloaded[^<]*)', html).group(1))
csv_bytes = "date,name\n2027-07-05,Independence Day (observed)\n2027/11/25,Thanksgiving\n".encode()
s, html = multipart("/admin/gantrix/holidays/import", {"authenticity_token": tok, "name": "US 2027", "use_imported": "1"}, "us.csv", csv_bytes, tok)
assert s == 200, s
hol = data()["calendar"]["holidays"]
assert "2027-07-05" in hol and "2027-01-01" not in hol, sorted(hol)[:5]
sjis = "日付,名前\n2027/12/28,年末休暇\n".encode("cp932")
s, html = multipart("/admin/gantrix/holidays/import", {"authenticity_token": tok, "use_imported": "1"}, "company.csv", sjis, tok)
assert "2027-12-28" in data()["calendar"]["holidays"]
s, html = req("PATCH", "/admin/gantrix", {"authenticity_token": tok, "holiday_source": "jp", "extra_holidays": "2027-12-29"}, form=True)
hol = data()["calendar"]["holidays"]
assert "2027-01-01" in hol and "2027-12-29" in hol and "2027-12-28" not in hol
s, html = req("DELETE", "/admin/gantrix/holidays/import", {"authenticity_token": tok}, form=True)
req("PATCH", "/admin/gantrix", {"authenticity_token": tok, "holiday_source": "jp", "extra_holidays": ""}, form=True)
print("HOLIDAYS OK", base)

"""تدوير مفتاح بوابة الأتمتة — توليد مفتاح جديد وتخزينه في Turso meta
عبر /api/meta (op=set مع إثبات الملكية بالترويسة)، وحفظه محليًا في ملف
غير متتبع (.automation-key). لا يطبع القيمة أبدًا — القناع فقط.
"""
import json
import secrets
import string
import urllib.request

KEY_FILE = "/home/z/my-project/.automation-key"
META_URL = "https://meko-manger.vercel.app/api/meta"

alphabet = string.ascii_letters + string.digits
key = "mkau" + "".join(secrets.choice(alphabet) for _ in range(35))
assert len(key) == 39

req = urllib.request.Request(
    META_URL,
    data=json.dumps({"op": "set", "key": "automation_key", "value": key}).encode(),
    headers={"Content-Type": "application/json", "Authorization": f"Bearer {key}"},
    method="POST",
)
with urllib.request.urlopen(req, timeout=30) as resp:
    out = json.load(resp)

print("ok:", out.get("ok"), "| masked:", out.get("masked"), "| note:", out.get("note", "")[:80])
with open(KEY_FILE, "w") as f:
    f.write(key + "\n")

# تحقق فوري: البوابة تقبل المفتاح الجديد (مهمة وهمية بمعرف صيغة UUID سليم تعطي 404 وليس 401/503)
probe = urllib.request.Request(
    "https://meko-nine.vercel.app/api/automate/video?task_id=00000000-0000-0000-0000-000000000000"
)
probe.add_header("Authorization", f"Bearer {key}")
try:
    with urllib.request.urlopen(probe, timeout=30) as r:
        print("probe status:", r.status, json.load(r).get("error", ""))
except urllib.error.HTTPError as e:
    print("probe status:", e.code, json.loads(e.read().decode()).get("error", "")[:120])

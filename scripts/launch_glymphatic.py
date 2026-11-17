"""إطلاق فيديو YouTube Short عبر بوابة الأتمتة POST /api/automate/video
- مشهد الجهاز الغليمفاوي (بلا ترجمة داخلية — طبقة الترجمة الموحدة captions:true)
- موسيقى خلفية "ambient" مع خفض تلقائي أثناء الكلام
- webhook_callback_url من webhook.site للتحقق من الإشعار الفوري
"""
import json
import urllib.request
import urllib.error

BASE = "https://meko-nine.vercel.app"
KEY = open("/home/z/my-project/.automation-key", encoding="utf-8").read().strip()
HTML = open("/home/z/my-project/scripts/scene-glymphatic.html", encoding="utf-8").read()

TITLE = "How Sleep Cleans Your Brain — The Glymphatic System"
SCRIPT = ("Here's something incredible. Every single night, while you sleep, your brain "
          "switches on its own cleaning crew — the glymphatic system. Cerebrospinal fluid "
          "flushes toxic proteins, linked to Alzheimer's, straight out of your brain. "
          "Skip sleep, and that waste builds up. So sleep well — your brain is counting on it.")

words = len(SCRIPT.split())
print(f"script words: {words}")

# 1) رابط webhook للتحقق من الإشعار (اختياري)
callback = None
try:
    req = urllib.request.Request(
        "https://webhook.site/token",
        data=json.dumps({"name": "meko-glymphatic-test"}).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=20) as r:
        tok = json.load(r)
    callback = f"https://webhook.site/{tok['uuid']}"
    print("webhook.site uuid:", tok["uuid"])
except Exception as e:
    print("webhook.site unavailable — callback omitted:", str(e)[:120])

# 2) الإطلاق
body = {
    "title": TITLE,
    "script": SCRIPT,
    "voice": "en-US-AndrewNeural",
    "html_code": HTML,
    "captions": True,
    "bg_music_url": "ambient",
    "aspect_ratio": "9:16",
}
if callback:
    body["webhook_callback_url"] = callback

req = urllib.request.Request(
    f"{BASE}/api/automate/video",
    data=json.dumps(body).encode(),
    headers={"Content-Type": "application/json", "Authorization": f"Bearer {KEY}"},
    method="POST",
)
try:
    with urllib.request.urlopen(req, timeout=90) as r:
        resp = json.load(r)
        status_code = r.status
except urllib.error.HTTPError as e:
    status_code = e.code
    resp = json.loads(e.read().decode())

print("HTTP:", status_code)
print(json.dumps(resp, ensure_ascii=False, indent=2)[:1200])
if resp.get("task_id"):
    with open("/tmp/last-task-id.txt", "w") as f:
        f.write(resp["task_id"] + ("\n" + callback if callback else "") + "\n")

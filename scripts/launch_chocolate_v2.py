"""إطلاق فيديو مصنع الشوكولاتة v2 عبر بوابة الأتمتة POST /api/automate/video
- مشهد v2: تايم لاين متزامن مع السكربت + آلات متحركة + منطقة مقدمة + عدسة مكبرة
- نمط الترجمة caption_style: "single-pop" (كلمة واحدة منبثقة ذهبية/بيضاء)
- موسيقى خلفية "ambient" — الصوت en-US-AndrewNeural — المدة من طول الصوت
"""
import json
import urllib.request
import urllib.error

BASE = "https://meko-nine.vercel.app"
KEY = open("/home/z/my-project/.automation-key", encoding="utf-8").read().strip()
HTML = open("/home/z/my-project/scripts/scene-chocolate-v2.html", encoding="utf-8").read()

TITLE = "How Chocolate Is Made From Scratch v2"
SCRIPT = ("You have raw cocoa beans. You bite one. Awful! So where does chocolate begin? "
          "Inside the factory, you build eight stages. First, harvest cocoa pods, scoop out "
          "the beans, and ferment them until their white pulp turns deep purple. Next, dry "
          "them under the sun, then roast and crack their bitter shells. Third, crush the "
          "nibs into thick, dark cocoa liquor. Fourth, press it, separating golden cocoa "
          "butter from cocoa powder. Fifth, blend everything with milk and sugar. Sixth, "
          "giant stone rollers conch the mixture until silky smooth. Seventh, carefully "
          "heat and cool it, creating perfect crystals. Finally, pour glossy chocolate into "
          "molds, cool, and unwrap the bars. Your factory is complete!")

words = len(SCRIPT.split())
print(f"script words: {words} | html chars: {len(HTML)}")

# فحوص سلامة سريعة قبل الإرسال
assert 'xmlns="http://www.w3.org/2000/svg"' in HTML, "xmlns تالف"
assert "](" not in HTML, "بقايا روابط ماركداون داخل الكود!"
assert "window.renderAtTime=renderAtTime" in HTML, "renderAtTime غير معرّفة"
assert HTML.count('xmlns="http://www.w3.org/2000/svg"') == 2, "عدد xmlns غير صحيح"
assert 'const NS="http://www.w3.org/2000/svg"' in HTML, "NS تالفة"

body = {
    "title": TITLE,
    "script": SCRIPT,
    "voice": "en-US-AndrewNeural",
    "html_code": HTML,
    "captions": True,
    "caption_style": "single-pop",
    "bg_music_url": "ambient",
    "aspect_ratio": "9:16",
}

req = urllib.request.Request(
    f"{BASE}/api/automate/video",
    data=json.dumps(body).encode(),
    headers={"Content-Type": "application/json", "Authorization": f"Bearer {KEY}"},
    method="POST",
)
try:
    with urllib.request.urlopen(req, timeout=120) as r:
        resp = json.load(r)
        status_code = r.status
except urllib.error.HTTPError as e:
    status_code = e.code
    resp = json.loads(e.read().decode())

print("HTTP:", status_code)
print(json.dumps(resp, ensure_ascii=False, indent=2)[:1500])
if resp.get("task_id"):
    with open("/tmp/last-task-id.txt", "w") as f:
        f.write(resp["task_id"] + "\n")

"""إطلاق فيديو صناعة الزجاج (عربي مصر) عبر بوابة الأتمتة POST /api/automate/video
- صوت ar-EG-ShakirNeural + ترجمة single-pop (تتكفل الطبقة بكشف RTL تلقائيًا)
- موسيقى خلفية "ambient" — المدة من طول الصوت فعليًا والمشهد يتحجّم نسبيًا
"""
import json
import urllib.request
import urllib.error

BASE = "https://meko-nine.vercel.app"
KEY = open("/home/z/my-project/.automation-key", encoding="utf-8").read().strip()
HTML = open("/home/z/my-project/scripts/scene-glass-ar.html", encoding="utf-8").read()

TITLE = "إزاي الرمل بيتحول لإزاز شفاف من الصفر"
SCRIPT = ("معاك شوية رمل من الصحرا، شكله عادي جداً، لكن جواه سر صناعة الإزاز الشفاف! "
          "لو سخنته على نار البوتاجاز مش هيسيح. طيب إزاي المصنع بيحوّله لإزاز نقي؟ "
          "تعالى نشوف سبع مراحل من الصفر! "
          "أولاً، بنغربل رمل السيليكا ونغسله عشان نشيل الطين والشوائب. "
          "بعد كده بنخلطه برماد الصودا لتقليل حرارة الانصهار، والحجر الجيري عشان الإزاز مايدوبش في الميه. "
          "الخليط يدخل فرن عملاق حرارته ألف وخمسمية درجة، ويتحول لحمم برتقالية سائلة. "
          "بعدها بننقّيه ونطلّع فقاعات الهوا الدقيقة، فيبقى صافي تماماً. "
          "الزجاج السائل ينساب فوق قصدير منصهر، فيتفرد ويبقى مستوي زي المراية. "
          "بعد كده يمر في فرن تبريد تدريجي يخفف الإجهاد الداخلي. "
          "وأخيراً، الليزر يقطع الألواح، وتتلمّع الحواف، وتخرج ألواح وأكواب زجاجية فائقة النقاء. "
          "كده الرمل بقى إزاز!")

words = len(SCRIPT.split())
print(f"script words: {words} | html chars: {len(HTML)}")

# فحوص سلامة سريعة قبل الإرسال
assert HTML.count('xmlns="http://www.w3.org/2000/svg"') == 2, "عدد xmlns غير صحيح"
assert "](" not in HTML, "بقايا روابط ماركداون داخل الكود!"
assert "window.renderAtTime" in HTML, "renderAtTime غير معرّفة"
assert "\\%" not in HTML, "backslash شارد داخل الكود!"

body = {
    "title": TITLE,
    "script": SCRIPT,
    "voice": "ar-EG-ShakirNeural",
    "html_code": HTML,
    "captions": True,
    "caption_style": "single-pop",
    "bg_music_url": "ambient",
    "aspect_ratio": "9:16",
}

req = urllib.request.Request(
    f"{BASE}/api/automate/video",
    data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
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

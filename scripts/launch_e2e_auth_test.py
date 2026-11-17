"""اختبار E2E لبوابة الأتمتة — فيديو قصير رخيص يتحقق من كل المراحل:
التسجيل في Turso → الصوت Edge-TTS + توقيتات الكلمات → تخزين الحمولة →
إطلاق GitHub Actions → الرندر FHD → رفع MP4 → تحديث الحالة → الويب هوك.
لا يطبع مفتاح الأتمتة أبدًا — يقرأه من .automation-key.
"""
import json
import sys
import urllib.error
import urllib.request

BASE = "https://meko-nine.vercel.app"
KEY = open("/home/z/my-project/.automation-key", encoding="utf-8").read().strip()
WEBHOOK = "https://webhook.site/" + open("/tmp/wh_uuid.txt", encoding="utf-8").read().strip()
HTML = open("/home/z/my-project/scripts/scene-e2e-auth-test.html", encoding="utf-8").read()

SCRIPT = "مرحبًا بكم في اختبار نظام الميكو الآلي. هذا فيديو قصير يتحقق من مسار الإنتاج الكامل من الطلب حتى الملف النهائي."

payload = {
    "title": "اختبار الأتمتة الشاملة — مسار كامل",
    "script": SCRIPT,
    "voice": "ar-EG-ShakirNeural",
    "html_code": HTML,
    "caption_style": "single-pop",
    "bg_music_url": "ambient",
    "webhook_callback_url": WEBHOOK,
}

req = urllib.request.Request(
    BASE + "/api/automate/video",
    data=json.dumps(payload).encode(),
    headers={"Content-Type": "application/json", "Authorization": f"Bearer {KEY}"},
    method="POST",
)
try:
    with urllib.request.urlopen(req, timeout=90) as resp:
        out = json.load(resp)
        print("launch status:", resp.status)
        print(json.dumps(out, ensure_ascii=False)[:600])
except urllib.error.HTTPError as e:
    print("HTTP", e.code)
    print(e.read().decode()[:800])
    sys.exit(1)

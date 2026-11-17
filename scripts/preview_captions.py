"""معاينة التركيب النهائي: المشهد + طبقة الترجمة الحركية (نسخة العامل الحقيقية)
يستخرج installCaptionsInPage من سكربت العامل نفسه ويشغّله داخل الصفحة.
"""
import json
import re
import sys
from playwright.sync_api import sync_playwright

scene = "/home/z/my-project/scripts/scene-glymphatic.html"
worker = "/home/z/my-project/renderer-repo/scripts/render-code-video.js"
out = "/tmp/render3"

# استخراج دالة الطبقة من العامل كما هي
src = open(worker, encoding="utf-8").read()
m = re.search(r"function installCaptionsInPage\(spec\) \{.*?\n\}\n", src, re.S)
assert m, "installCaptionsInPage غير موجودة في العامل"
fn_src = m.group(0)

# نص التعليق الصوتي (نفس نص المهمة) وتوقيتات تقريبية واقعية
SCRIPT = ("Here's something incredible. Every single night, while you sleep, "
          "your brain switches on its own cleaning crew. It's called the glymphatic system. "
          "Cerebrospinal fluid flows deep between your neurons, flushing out toxic proteins "
          "linked to Alzheimer's disease. Skip sleep, and that waste builds up. So tonight, "
          "sleep well — your brain is counting on it.")

def build_timings(text, start=0.7):
    t = start
    out = []
    for w in text.split():
        dur = max(0.20, min(0.65, 0.10 + len(w) * 0.042))
        out.append({"text": w, "start": round(t, 3), "end": round(t + dur, 3)})
        t += dur + 0.02
        if w.endswith((".", "!", "?")):
            t += 0.32
        elif w.endswith(","):
            t += 0.15
    return out, t

timings, total = build_timings(SCRIPT)
print(f"words={len(timings)} approx_duration={total:.2f}s")

with sync_playwright() as p:
    b = p.chromium.launch(headless=True)
    page = b.new_page(viewport={"width": 1080, "height": 1920}, device_scale_factor=1)
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(f"file://{scene}")
    page.wait_for_timeout(250)
    page.evaluate(f"window.installCaptionsInPage = {fn_src}")
    ok = page.evaluate(f"window.installCaptionsInPage({json.dumps({'fontSize': 54, 'timings': timings})})")
    print("captions installed:", ok)
    for t in [2.5, 5.5, 11.0, 16.5, 19.2]:
        page.evaluate(f"window.renderAtTime({t}, {total:.3f}, null); window.__mekoUpdateCaptions({t})")
        page.wait_for_timeout(60)
        page.screenshot(path=f"{out}/cap{str(t).replace('.', '_')}.png")
    b.close()
    print("PAGE ERRORS:", errors[:3] if errors else "none")

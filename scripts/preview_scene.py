"""معاينة مشهد الفيديو محليًا — لقطات عند لحظات محددة عبر Playwright"""
import sys
from playwright.sync_api import sync_playwright

scene = sys.argv[1] if len(sys.argv) > 1 else "/home/z/my-project/scripts/scene-glymphatic.html"
out = sys.argv[2] if len(sys.argv) > 2 else "/tmp/render"
times = [float(x) for x in (sys.argv[3].split(",") if len(sys.argv) > 3 else ["1", "4", "8", "12", "16", "19"])]

import os
os.makedirs(out, exist_ok=True)

with sync_playwright() as p:
    b = p.chromium.launch(headless=True)
    page = b.new_page(viewport={"width": 1080, "height": 1920}, device_scale_factor=1)
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(f"file://{scene}")
    page.wait_for_timeout(300)
    for t in times:
        page.evaluate(f"window.renderAtTime({t}, 20, null)")
        page.wait_for_timeout(60)
        page.screenshot(path=f"{out}/t{int(t):02d}.png")
        print(f"shot t={t}")
    b.close()
    if errors:
        print("PAGE ERRORS:", errors[:3])
    else:
        print("no page errors")

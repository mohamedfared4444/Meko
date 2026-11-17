#!/usr/bin/env python3
"""إطلاق الرندر على Actions عبر المسار الإنتاجي الحقيقي:
POST الحمولة (مشهد 720×1280 + صوت data:audio) إلى meko-manger /api/render-payload
ثم dispatch الـ workflow بـ payload_url — كما يفعل Meko تمامًا.
"""
import base64
import json
import subprocess
import sys
import time
import urllib.request

sys.path.insert(0, "/home/z/my-project/scripts")
from dispatch_render_actions import api, REPO  # noqa: E402


def main():
    with open("/home/z/my-project/scripts/test-scene-720.html", "rb") as f:
        html = f.read().decode()
    with open("/tmp/test-audio-10s.mp3", "rb") as f:
        audio_data = "data:audio/mpeg;base64," + base64.b64encode(f.read()).decode()

    payload = {
        "task_id": "00000000-0000-0000-0000-00000000000a",
        "job_id": "00000000-0000-0000-0000-00000000000b",
        "title": "اختبار ملء الكادر والصوت (مسار الحمولة)",
        "html_code": html,
        "audio_url": audio_data,
        "word_timings": None,
        "duration_seconds": 10,
    }
    req = urllib.request.Request(
        "https://meko-manger.vercel.app/api/render-payload",
        method="POST",
        headers={"Content-Type": "application/json"},
        data=json.dumps(payload).encode(),
    )
    with urllib.request.urlopen(req, timeout=60) as r:
        res = json.loads(r.read())
    print(f"payload_id: {res['payload_id']}")
    print(f"payload_url: {res['payload_url']}")
    print(f"expires_at: {res['expires_at']}")

    st, _ = api(
        f"/repos/{REPO}/actions/workflows/render-code-video.yml/dispatches",
        method="POST",
        body={
            "ref": "main",
            "inputs": {
                "task_id": "new",
                "job_id": "new",
                "payload_url": res["payload_url"],
                "width": "1080",
                "height": "1920",
                "fps": "30",
            },
        },
    )
    print(f"dispatch: HTTP {st} (204 = نجح)")
    if st != 204:
        sys.exit(1)
    time.sleep(8)
    st, runs = api(f"/repos/{REPO}/actions/workflows/render-code-video.yml/runs?per_page=1")
    run = runs["workflow_runs"][0]
    print(f"RUN_ID={run['id']} — {run['status']}")


if __name__ == "__main__":
    main()

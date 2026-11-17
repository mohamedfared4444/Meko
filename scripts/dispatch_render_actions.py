#!/usr/bin/env python3
"""التحقق من نشر Vercel للـ commit الأخير + إطلاق ومراقبة workflow الرندر على Actions.
الاستخدام:
  python3 scripts/dispatch_render_actions.py deploy   — فحص حالات نشر Vercel للـ HEAD
  python3 scripts/dispatch_render_actions.py dispatch — إطلاق الرندر (مشهد 720 + صوت http)
  python3 scripts/dispatch_render_actions.py poll RUN_ID  — مراقبة حتى الاكتمال
  python3 scripts/dispatch_render_actions.py logs RUN_ID  — تنزيل السجلات واستخراج النواتج
"""
import base64
import json
import re
import subprocess
import sys
import time
import urllib.request
import urllib.error

REMOTE = subprocess.check_output(["git", "remote", "get-url", "origin"], text=True, cwd="/home/z/my-project").strip()
TOKEN = re.search(r"https://([^@]+)@github\.com/", REMOTE).group(1)
REPO = "mohamedfared4444/Meko"
API = "https://api.github.com"


def api(path, method="GET", body=None, raw=False):
    req = urllib.request.Request(
        API + path,
        method=method,
        headers={"Authorization": f"Bearer {TOKEN}", "Accept": "application/vnd.github+json", "User-Agent": "meko-e2e"},
        data=json.dumps(body).encode() if body is not None else None,
    )
    try:
        r = urllib.request.urlopen(req, timeout=60)
        data = r.read()
        return r.status, (data if raw else (json.loads(data) if data else None))
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")[:300]


def head_sha():
    return subprocess.check_output(["git", "rev-parse", "HEAD"], text=True, cwd="/home/z/my-project").strip()[:12]


def deploy():
    sha = subprocess.check_output(["git", "rev-parse", "HEAD"], text=True, cwd="/home/z/my-project").strip()
    print(f"HEAD: {head_sha()}")
    for attempt in range(30):  # حتى 15 دقيقة
        st, statuses = api(f"/repos/{REPO}/commits/{sha}/status")
        if st == 200:
            total = statuses.get("total_count", 0)
            state = statuses.get("state")
            if state in ("success", "failure") and total > 0:
                print(f"حالة النشر: {state} — {total} حالة:")
                for s in statuses.get("statuses", []):
                    print(f"  - {s.get('context')}: {s.get('state')} — {(s.get('description') or '')[:80]}")
                return state == "success"
            print(f"[{attempt}] الانتظار… حالات: {total} — الحالة الحالية: {state}")
        else:
            print(f"HTTP {st}: {statuses}")
        time.sleep(30)
    print("انتهت مهلة الانتظار")
    return False


def dispatch():
    with open("/home/z/my-project/scripts/test-scene-720.html", "rb") as f:
        html_b64 = base64.b64encode(f.read()).decode()
    with open("/tmp/test-audio-10s.mp3", "rb") as f:
        audio_url = f.read().decode().strip()
    st, res = api(
        f"/repos/{REPO}/actions/workflows/render-code-video.yml/dispatches",
        method="POST",
        body={
            "ref": "main",
            "inputs": {
                "task_id": "new",
                "job_id": "new",
                "html_code_b64": html_b64,
                "audio_url": audio_url,
                "width": "1080",
                "height": "1920",
                "fps": "30",
            },
        },
    )
    print(f"dispatch: HTTP {st} (204 = نجح)")
    if st != 204:
        print(res)
        return False
    time.sleep(8)
    st, runs = api(f"/repos/{REPO}/actions/workflows/render-code-video.yml/runs?per_page=2")
    for r in runs.get("workflow_runs", []):
        print(f"run {r['id']} — {r['status']}/{r.get('conclusion')} — {r['created_at']} — {r['display_title'][:40]}")
    active = [r["id"] for r in runs.get("workflow_runs", []) if r["status"] in ("queued", "in_progress")]
    if active:
        print(f"ACTIVE_RUN={active[0]}")
    return True


def poll(run_id):
    for i in range(80):  # حتى 40 دقيقة
        st, run = api(f"/repos/{REPO}/actions/runs/{run_id}")
        if st != 200:
            print(f"HTTP {st}")
            time.sleep(30)
            continue
        status, concl = run.get("status"), run.get("conclusion")
        print(f"[{i}] {status}/{concl}")
        if status == "completed":
            print("RESULT:", concl)
            return concl == "success"
        time.sleep(30)
    return False


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


def logs(run_id):
    req = urllib.request.Request(
        f"{API}/repos/{REPO}/actions/runs/{run_id}/logs",
        headers={"Authorization": f"Bearer {TOKEN}", "User-Agent": "meko-e2e"},
    )
    opener = urllib.request.build_opener(NoRedirect)
    try:
        opener.open(req, timeout=60)
        print("متوقع 302")
        return
    except urllib.error.HTTPError as e:
        if e.code not in (301, 302, 303, 307):
            print(f"HTTP {e.code}")
            return
        loc = e.headers["Location"]
    data = urllib.request.urlopen(loc, timeout=120).read()
    with open("/tmp/render-run.log", "wb") as f:
        f.write(data)
    text = data.decode("utf-8", "replace")
    print(f"السجل: {len(data)} بايت → /tmp/render-run.log")
    for line in text.splitlines():
        if any(k in line for k in ("ملء الكادر", "الصوت", "تحقق ffprobe", "VIDEO_URL", "الناتج", "تحقق النشر", "جُلبت", "provision")):
            print("  |", line.split("Z")[-1][:180])


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "deploy"
    if cmd == "deploy":
        sys.exit(0 if deploy() else 1)
    elif cmd == "dispatch":
        sys.exit(0 if dispatch() else 1)
    elif cmd == "poll":
        sys.exit(0 if poll(sys.argv[2]) else 1)
    elif cmd == "logs":
        logs(sys.argv[2])

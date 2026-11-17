"""مراقبة رندر مهمة على meko-renderer — يجد الـ run المطابق ويتبعه حتى النهاية"""
import json
import re
import subprocess
import sys
import time
import urllib.request

def token():
    url = subprocess.check_output(["git", "remote", "get-url", "origin"], text=True, cwd="/home/z/my-project").strip()
    return re.search(r"https://([^@]+)@github\.com/", url).group(1)

TOKEN = token()
REPO = "mohamedfared4444/meko-renderer"
API = "https://api.github.com"

def api(path):
    req = urllib.request.Request(
        f"{API}{path}",
        headers={"Authorization": f"Bearer {TOKEN}", "Accept": "application/vnd.github+json", "User-Agent": "meko-e2e"},
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)

def find_run():
    runs = api(f"/repos/{REPO}/actions/workflows/render-code-video.yml/runs?per_page=5")["workflow_runs"]
    return runs[0] if runs else None

def main():
    run = find_run()
    if not run:
        print("لا توجد runs")
        sys.exit(1)
    rid = run["id"]
    print(f"RUN_ID={rid} | status={run['status']} | created={run['created_at']} | run_url={run['html_url']}")
    started = time.time()
    while True:
        r = api(f"/repos/{REPO}/actions/runs/{rid}")
        jobs = api(f"/repos/{REPO}/actions/runs/{rid}/jobs")["jobs"]
        step = ""
        if jobs:
            js = jobs[0]
            cur = [s for s in js["steps"] if s["status"] == "in_progress"]
            step = cur[0]["name"] if cur else (js["steps"][-1]["name"] if js["steps"] else "")
            step = f" | خطوة: {step[:60]}"
        print(f"[{int(time.time()-started):>4}s] status={r['status']} conclusion={r['conclusion']}{step}")
        if r["status"] == "completed":
            print(f"CONCLUSION: {r['conclusion']}")
            sys.exit(0 if r["conclusion"] == "success" else 2)
        time.sleep(20)

main()

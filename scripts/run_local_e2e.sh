#!/usr/bin/env bash
# اختبار E2E محلي للعامل: مشهد 720×1280 + صوت data: URL → فيديو 1080×1920 مع صوت
set -euo pipefail
cd /home/z/my-project

HTML_B64=$(base64 -w0 scripts/test-scene-720.html)
AUDIO_B64=$(base64 -w0 /tmp/test-audio-10s.mp3)

export INPUT_TASK_ID="new"
export INPUT_JOB_ID="new"
export INPUT_HTML_CODE_B64="$HTML_B64"
export INPUT_AUDIO_URL="data:audio/mpeg;base64,$AUDIO_B64"
export INPUT_WIDTH="1080"
export INPUT_HEIGHT="1920"
export INPUT_FPS="30"
export MERGER_BASE_URL="https://meko-manger.vercel.app"

# كروم المثبت مسبقًا في /tmp/chrome (نفس مسار البحث في العامل)
exec node scripts/render-code-video.js

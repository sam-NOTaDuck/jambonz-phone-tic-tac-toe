#!/usr/bin/env python3
"""Provision the Phone Tic-Tac-Toe Jambonz application.

Creates a webhook for the WSS URL, creates the application with Google TTS
(same speech config as Call Snare), and forces the wss:// call_hook (the
known webhook-normalization workaround). Does NOT assign a phone number —
that decision is parked for Sam.
"""
import json
import sys
import urllib.request
import urllib.error

WS_URL = "wss://prison-paid-statements-registrar.trycloudflare.com/"

# Load creds from .env.jambonz
creds = {}
with open("/home/sam/apps/jambonz-agent/.env.jambonz") as f:
    for line in f:
        line = line.strip()
        if "=" in line and not line.startswith("#"):
            k, v = line.split("=", 1)
            creds[k.strip()] = v.strip().strip('"').strip("'")

API = creds["JAMBONZ_API_BASE"]
KEY = creds["JAMBONZ_API_KEY"]


def call(method, path, body=None):
    req = urllib.request.Request(
        f"{API}{path}",
        data=json.dumps(body).encode() if body is not None else None,
        headers={
            "Authorization": f"Bearer {KEY}",
            "Content-Type": "application/json",
        },
        method=method,
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            raw = r.read()
            return json.loads(raw) if raw else None
    except urllib.error.HTTPError as e:
        print(f"❌ HTTP {e.code} on {method} {path}: {e.read().decode()[:500]}")
        sys.exit(1)


# 1. Create webhook
print("🔧 Creating webhook...")
webhook = call("POST", "/v1/Webhooks", {"url": WS_URL, "method": "POST"})
wh_sid = webhook.get("sid")
print(f"✅ Webhook: {wh_sid}")

# 2. Create application (Google TTS, same config as Call Snare)
print("🔧 Creating application...")
app = call(
    "POST",
    "/v1/Applications",
    {
        "name": "Phone Tic-Tac-Toe",
        "speech_synthesis_vendor": "google",
        "speech_synthesis_language": "en-US",
        "speech_synthesis_voice": "en-US-Wavenet-D",
        "speech_synthesis_label": "g_speech",
        "speech_recognizer_vendor": "google",
        "speech_recognizer_language": "en-US",
        "call_hook": {"webhook_sid": wh_sid, "url": WS_URL, "method": "POST"},
        "call_status_hook": {
            "url": "https://public-apps.jambonz.cloud/call-status",
            "method": "POST",
        },
        "env_vars": {},
    },
)
app_sid = app.get("sid")
print(f"✅ Application: {app_sid}")

# 3. Force wss:// call_hook (webhook normalization workaround)
print("🔧 Forcing wss:// call_hook...")
call(
    "PUT",
    f"/v1/Applications/{app_sid}",
    {"call_hook": {"url": WS_URL, "method": "POST"}},
)
print("✅ wss:// confirmed")

# 4. Verify
verify = call("GET", f"/v1/Applications/{app_sid}")
print(f"\n🎉 Done! Application SID: {app_sid}")
print(f"   Name: {verify.get('name')}")
print(f"   call_hook.url: {verify.get('call_hook', {}).get('url')}")
print(f"   TTS: {verify.get('speech_synthesis_vendor')} / {verify.get('speech_synthesis_voice')} / label={verify.get('speech_synthesis_label')}")

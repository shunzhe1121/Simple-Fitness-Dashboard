<p align="center"><a href="README-CN.md">简体中文</a> · <b>English</b></p>

# Simple Fitness Recorder

> A local-first fitness tracker (Chinese UI). Log diet / workout / body measurements, auto-compute your daily calorie target and deficit, and visualize the trends. Ships in two forms — a **web app** and an **Android app** — and keeps all your data on your own device, with no server upload.

## Screenshots

The desktop version runs a FastAPI + Vue 3 app in your browser; the mobile version is a Capacitor-packaged Android app that stores data on-device. The four images below are real screenshots of the running app.

#### Desktop · Today's overview

![Desktop today's overview](assets/screenshots/desktop-today.png)

#### Mobile · Today's overview

<p align="center"><img src="assets/screenshots/mobile-today.png" width="320" alt="Mobile today's overview"></p>

#### Desktop · Statistics

![Desktop statistics](assets/screenshots/desktop-stats.png)

#### Mobile · Statistics

<p align="center"><img src="assets/screenshots/mobile-stats.png" width="320" alt="Mobile statistics"></p>

## Features

- **Three record types**: diet (meal / food / portion / calories / macros), workout (muscle group / duration / burn / note), and body (weight / body-fat / waist), with inline edit and soft-delete (recoverable from the trash).
- **Goal & deficit chain**: BMR (Mifflin-St Jeor) → TDEE (activity factor) → daily target (goal factor); today's workout burn raises the effective target live, so the calorie ring and the deficit stay in sync.
- **Visual stats**: calorie ring, macro progress bars, daily summary, plus range trend lines, macro split, and workout distribution charts.
- **Assisted entry**: paste vision-model OCR output in a template and parse locally (no LLM cost), or enter manually.
- **Optional AI assistant**: connect any OpenAI-compatible endpoint (e.g. SiliconFlow / DeepSeek) for natural-language logging and queries; delete actions ask for a second confirmation. Everything works without it.
- **Clean monochrome UI**: light / dark theme toggle; sidebar layout on the web, bottom navigation on mobile; floating chat button never blocks the underlying interaction.
- **Cross-platform sync**: web and mobile share the same record model; export JSON and re-import on either side, de-duplicated by record type + id.

## Two forms

| | Web (desktop) | Mobile (Android) |
| --- | --- | --- |
| Storage | Local SQLite (`data/`, never uploaded) | Local IndexedDB (works offline) |
| How it runs | Start FastAPI locally, open in a browser | Install the APK, runs as a standalone app |
| Best for | Logging and reviewing on a computer | Logging on the go |
| AI configuration | Server-side `.env` | In-app Settings page, key stays on the device |
| Relationship | They coexist and complement each other; sync via JSON export / import | Same |

## Quick start

### Web

```bash
# 1. Recommended: use a virtual environment to avoid polluting system Python
python -m venv .venv
source .venv/bin/activate            # Windows: .venv\Scripts\activate

# 2. Install dependencies
pip install -r requirements.txt

# 3. (Optional) Configure the AI assistant. If you skip this, the chat is disabled
#    but every other feature still works.
cp .env.example .env
# Edit .env and set the OpenAI-compatible endpoint:
#   LLM_API_KEY=sk-xxx
#   LLM_BASE_URL=https://api.siliconflow.cn/v1   # any OpenAI-compatible service works
#   LLM_MODEL=deepseek-ai/DeepSeek-V3

# 4. Start the server
python run.py
```

Then open `http://127.0.0.1:8000`. If the server is bound to `0.0.0.0`, a phone on the same Wi-Fi can reach it at the LAN address — handy for the photo → OCR → paste workflow.

> Double-clicking `run.py` usually fails because the system Python doesn't have the dependencies. Always run it from a terminal inside a virtualenv (or any Python where you've installed the requirements).

### Mobile (Android)

Install one of the APKs from the `apk/` directory in this repo:

- `fitness-recorder-v1.0.3-release.apk` — production-signed, supports in-place upgrade (recommended)
- `fitness-recorder-v1.0.3-debug.apk` — debug-signed, ~3.9MB, good for a quick trial

You'll need to allow "install from unknown sources" on first install. All data is stored on-device and works fully offline. To enable the AI assistant, fill in the OpenAI-compatible API key on the in-app Settings page (the key stays on the device).

## Data backup and migration

Both the web and mobile Settings pages offer **Export all JSON**, which includes your profile, goals, and every record (including the trash). Share the file with someone else; once they import it, they have the same data. Re-importing the same file is a no-op — duplicates are dropped by record type + id (set union, not accumulation).

## Tech stack

- **Backend**: FastAPI + SQLite + LangGraph (OpenAI-compatible, defaults to DeepSeek-V3)
- **Frontend**: Vue 3 + Chart.js (vendored locally for offline use, CDN fallback)
- **Architecture**: API-first — the web UI is just one client. The mobile app is a pure-frontend shell that stores data locally and syncs with the web app via JSON export / import.

## Build from source (optional)

- **Web**: `pip install -r requirements.txt && python run.py`, as above.
- **Mobile**: `pwa/` holds the pure-frontend web assets (Vue 3 + IndexedDB, zero build step); `mobile/` is a Capacitor 6 project that wraps `pwa/` into a native Android WebView shell. After editing `pwa/`, run `cap sync` inside `mobile/` to copy assets, then build the APK. Release builds need your own signing keystore (not committed to this repo). Windows + Chinese paths + sandboxed environments have known pitfalls — see the project's `capacitor-apk-build` notes.

## Roadmap

- [ ] Multiple profiles / users
- [ ] Exercise library and plan templates
- [ ] Weight / body-fat trend forecasting
- [ ] Better dark-theme persistence on the web

## License

This project does not currently declare an open-source license. Please contact the author before redistributing or using it commercially.

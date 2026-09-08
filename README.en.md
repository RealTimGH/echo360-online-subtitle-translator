# echo360-online-subtitle-translator

[简体中文](README.md) | **English**

Chrome/Safari extension for loading translated subtitles on Echo360 recordings and Canvas-embedded Instructure Media videos; the local FastAPI backend is kept as a development, fallback, and batch-processing path.

Current extension version: **1.5.0**

## What It Does

1. Finds the VTT subtitle source for the current Echo360 lecture or Canvas-embedded video (player CC, network capture, `transcript-file` API, etc.).
2. Translates directly from the extension frontend by default (`direct_translator.js`); dev builds can also proxy through the local backend.
3. If the local backend is enabled, the backend calls the bundled VTT translator script as a fallback/batch tool:
   `translator/translate_vtt_zh_deepl_native.py`
4. Displays translated subtitles on the active Echo360 video; **the default is the browser `<track>` renderer**. Enable **使用原生 CC 注入（Beta）** in settings to try Echo360 native CC injection (may still miss cues at higher playback speeds; falls back automatically when the lesson has no native caption slot).
5. **Incremental display while translating** (1.3.0): subtitles mount immediately on click; pending cues show `正在翻译中...` until each batch completes.
6. **Per-provider API keys** with real-time sync between the popup and options page; switching providers loads the matching key automatically.

## Subtitle Source Discovery

`source_finder.js` tries multiple strategies in priority order and maps subtitles to the active video:

- CC / `<track>` VTT already attached to the player
- VTT URLs captured via the page probe and network layer
- **Transcript-panel fallback** (1.2.2): when the player has no usable CC, call  
  `/api/ui/echoplayer/lessons/{lessonId}/medias/{mediaId}/transcript-file?format=vtt`

If every strategy fails, the control panel reports that no usable subtitle source was found.

## Translation and Display Flow

**Direct translation path** (default in store builds; dev builds when the local backend is off):

1. Click `加载翻译字幕` → if mountable, subtitles appear immediately (pending cues show `正在翻译中...`).
2. While translating → each partial VTT hot-updates completed cues; status shows `翻译中 X/Y（已开始显示）`.
3. On completion → a final incremental refresh applies the full VTT without tearing down the renderer.

**Limits:**

- Incremental preview is only available on the in-extension direct path (`direct_translator.js` → background job). The local FastAPI backend still waits for the full VTT before display.
- A local translation cache hit mounts the complete subtitles immediately (no incremental flow).

## Subtitle Rendering

**The default is the browser `<track>` renderer** (the reliable path). Echo360 native CC injection is an opt-in **Beta** in settings (`renderer.js` + `bilingual_dom_renderer.js`):

1. **Default (browser track)**
   - Single-language mode mounts the translated VTT directly.
   - Bilingual mode is built by `subtitle_strategy.js`: Safari uses a single-cue bilingual VTT; Chrome / Edge use split-cue bilingual VTT.
   - Bilingual/order/size controls are editable.
2. **Optional Beta: Echo360 native CC injection**
   - Check **使用原生 CC 注入（Beta）** in the settings popover (`ui_popover.js`) to inject the translation into Echo360's built-in CC area (English on top, Chinese below).
   - **Known limit**: at higher playback speeds Echo360's own caption DOM often lags behind playback, so miss-injection can still occur; this path is not yet as reliable as the browser track, so it is no longer the default.
   - Since 1.2.1, DOM matching/injection timing is improved; since 1.3.0, incremental display via `updateTranslatedVtt()` is supported.
   - In native CC mode, bilingual/order are forced to bilingual, non-reverse; size and related controls are disabled.
   - `hasNativeCaptionCapability()` (`source_finder.js`) distinguishes "this lesson never had a native caption slot" from "CC is simply off right now". The primary signal is the player's **"Toggle Captions" button**; a real `<track>`/`TextTrack` also counts:
     - No button and no `<track>`/`TextTrack` → fall back to the browser track immediately on mount.
     - Button present but off (`aria-pressed="false"`) → treated as intentional; stay silent.
     - Safety net: after the matching grace period, confirmed lack of capability still falls back to the browser track (without persisting that choice).

Prefs schema v3 migrates the old "native CC preferred" default to the browser track once; users who want the native look can re-enable the Beta in settings.

3. **Canvas / Instructure Media videos**
   - Canvas embeds the video in a separate `sydney.instructuremedia.com` iframe. The player uses Vidstack's custom `[data-part="captions"]` surface, so the extension detects each iframe independently instead of treating all videos on the page as one player.
   - Translation still uses the same timed VTT and cache. Cues are rendered against `video.currentTime` in the player's captions surface, so translated subtitles do not depend on the native CC toggle and do not leak between the page's multiple videos.
   - If a caption URL's CORS policy prevents direct content-script access, the extension retries through the service worker, restricted to `*.instructuremedia.com` rather than acting as an arbitrary URL proxy.

### Canvas assessment safe mode

- The top-level Canvas matches are `/courses/*/pages/*` and `/courses/*/external_tools/*`, where the isolated `canvas_course_bridge.js` runs. It is never injected into `quizzes`, `assignments`, `taking`, `modules/items`, or other Canvas routes. The bridge checks the live URL and high-confidence assessment DOM markers, then answers a media frame's one-time nonce; it does not modify the DOM, read page text or keyboard input, access extension storage, or make network requests.
- For Canvas-embedded Echo360 / Instructure Media frames, `assessment_guard.js` runs before every other active module. A full `/courses/{id}/pages/{slug}` or `/courses/{id}/external_tools/{tool_id}` referrer is accepted directly. If referrer policy exposes only the Canvas origin, the frame must receive a response with the matching request ID from the course-page bridge before it can start.
- Quiz, assignment, New Quizzes, and taking routes have no course-page bridge and therefore fail closed. Missing proof, empty referrers, ambiguous ancestry, and high-confidence assessment DOM markers also fail closed.
- In safe mode, apart from a one-shot `postMessage` verification listener lasting at most 1.5 seconds, the extension creates no translation UI, subtitle track, page probe, persistent timer, or media-event listener, and performs no extension-storage read or translation request.

This protection minimizes interaction with an assessment page, but no extension can guarantee that proctoring software will not report it merely because it is installed. If an assessment policy prohibits browser extensions, disable this extension in the browser's extension manager beforehand and use the institution-mandated browser or a separate exam profile.

Display preferences (bilingual, order, size) do not require retranslation. The extension caches one translated VTT and renders client-side.

## Directory Layout

```text
backend/      FastAPI dev/fallback service and local translation cache
extension/    Chrome/Safari extension source
translator/   VTT translator script (backend/fallback path)
scripts/      Extension build scripts
tests/        Vitest unit tests for core extension logic
```

Main extension modules:

```text
build_config.js           Build target (dev/store) and local-backend switch
assessment_guard.js       Fail-closed Canvas assessment/assignment context gate
canvas_course_bridge.js   Data-free proof bridge limited to Canvas course-content/external_tools routes
browser_api.js            Chrome / Safari storage and runtime API abstraction
config_keys.js            Shared per-provider API key logic for popup/options
constants.js              Shared defaults and option lists
host_support.js           Echo360 / Canvas Instructure Media host detection and adapter helpers
vtt.js                    Pure VTT parsing, formatting, bilingual, and incremental preview helpers
subtitle_strategy.js      Browser detection and bilingual VTT build strategy
storage.js                Config, prefs, and local subtitle cache
video.js                  Echo360 video discovery, media-id hints, and page-probe bridge
source_finder.js          Subtitle source discovery (incl. transcript-file API) and video matching
player_caption_renderer.js Timed captions overlay for Canvas Vidstack players
bilingual_dom_renderer.js Echo360 native CC DOM bilingual injection
renderer.js               Browser track / native CC DOM render orchestration and cue styling
direct_translator.js      In-extension direct translation and partial VTT callbacks (default store path)
ui.js                     In-page UI facade (ball / panel / popover / onboarding)
ui_ball.js                Bottom-right dock ball entry point
ui_panel.js               Slide-out translation panel
ui_popover.js             Display and render preference popover
ui_onboarding.js          First-run onboarding bubble
ui_styles.js / ui_theme.js In-page UI styles and light/dark theming
backend_client.js         Backend proxy, direct job polling (incl. partial_vtt), and error messages
translation_service.js    Payload construction, cache keys, and translation orchestration
controller.js             Translation orchestration (incl. incremental preview mounting)
content.js                Content-script entrypoint
page_probe.js             MAIN-world Echo360/React/XHR probe
background.js             Service worker (direct jobs and partial_vtt storage)
popup.js / options.js     Extension popup and options page
```

## Backend Setup

The backend and translator CLI support Python 3.9 or later. On macOS, prefer a Homebrew/pyenv Python built with OpenSSL; the Xcode-provided LibreSSL Python can start the application, but its TLS stack is not fully supported by current `urllib3` releases.

First, go to the repo root:

```bash
cd /path/to/echo360-online-subtitle-translator
```

macOS / Linux:

```bash
cd backend
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app:app --host 127.0.0.1 --port 8765 --reload
```

Windows (PowerShell):

```powershell
cd backend
py -m venv .venv
.venv\Scripts\Activate.ps1
pip install -r requirements.txt
uvicorn app:app --host 127.0.0.1 --port 8765 --reload
```

Health check:

```bash
curl http://127.0.0.1:8765/health
```

Windows (PowerShell) health check:

```powershell
Invoke-WebRequest http://127.0.0.1:8765/health
```

### Standalone backend (no Python installation required)

Release artifacts bundle Python, FastAPI, the translator, the Argos/CTranslate2 runtime, `en→zh`, `en→zt`, and the English MiniSBD model in one application directory. End users do not install Python, pip, a virtual environment, or Argos models:

- macOS: extract `echo360-online-subtitle-translator-backend-macos-*.tar.gz` and launch `Echo360 Subtitle Backend.app`;
- Windows: extract `echo360-online-subtitle-translator-backend-windows-x64.zip` and launch `Echo360SubtitleBackend\echo360-subtitle-backend.exe`.

The program listens only on `127.0.0.1:8765` by default, so the extension keeps using its existing Backend URL. Quit the program to stop the backend. Translation cache files go to the current user's platform cache directory rather than the application directory.

On first launch, the read-only bundled Argos models are copied into the current user's application-data directory, so that launch can take longer than subsequent ones. The workflow artifacts are intended for testing and internal distribution until Windows Authenticode signing and Apple Developer ID notarization credentials are added. The user starts this standalone program explicitly; browser-managed startup would require a separate installer and Native Messaging integration and is outside this environment-free packaging change.

After a backend update, rebuild with one command on each target operating system (PyInstaller does not cross-compile):

```bash
python3 -m venv .backend-build-venv
source .backend-build-venv/bin/activate
python -m pip install -r backend/requirements-build.txt
npm run build:backend
python scripts/smoke-backend.py --check-argos
```

Windows PowerShell:

```powershell
py -3.12 -m venv .backend-build-venv
.backend-build-venv\Scripts\Activate.ps1
python -m pip install -r backend\requirements-build.txt
npm run build:backend
python scripts\smoke-backend.py --check-argos
```

Simplified and Traditional Chinese models are bundled by default. Repeat `--argos-target` to change the set, for example `npm run build:backend -- --argos-target zh --argos-target ja`; use `--refresh-models` to update the models in the build cache. The repository's `Build packaged backend` GitHub Actions workflow builds Windows x64, macOS Apple Silicon, and macOS Intel natively, then smoke-tests `/health`, frozen translator dispatch, and a real Argos translation.

## Extension Setup

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Click `Load unpacked`.
4. Select the `extension/` directory in this repository.

On an Echo360 classroom page, a **dock ball** appears at the bottom right; click it to open the slide-out translation panel, and use the gear button for the display/render popover. First-time installs see a one-time onboarding bubble. You can also configure the provider and API key from the extension popup (`popup.html`) or options page (`options.html`); keys are stored per provider and switch automatically when you change provider. Use `加载翻译字幕` for normal loading and `重新翻译` to clear the current cache and rerun translation.

## Release Builds

Install Node dependencies at the repo root first:

```bash
npm install
```

The source tree keeps the local backend switch available for development. Use the store build for Chrome Web Store submission:

```bash
npm run build:store
```

Build outputs:
- `dist/extension-store/`
- `dist/echo360-online-subtitle-translator-store.zip`

The store build retains the optional local-backend entry and the `localhost` / `127.0.0.1` permissions so both the Chrome release and Safari containing app can connect to the standalone Argos backend. Direct translation remains the default when that option is disabled.

For local development:

```bash
npm run build:dev
```

The dev build also keeps the local backend entry and localhost permissions, with a development name so it can be installed alongside the release build.

`extension/` is the single source of business logic shared by Chrome and Safari. The Safari/Xcode project references generated release resources in `dist/extension-store/`, not a second manually maintained source tree. The build generates target-specific `build_config.js` and manifest files while preserving standalone local-backend support.

Before opening Xcode or using Build/Run, run:

```bash
npm run safari:prepare
```

This regenerates the store resources from the current `extension/` tree and strictly verifies that every generated file matches the source plus release transforms, both Extension targets contain the complete resource set, and every Xcode reference points exactly to `dist/extension-store/`. Do not continue with an old Xcode build if this validation fails.

After changing extension scripts, also rebuild/run the containing app in Xcode and reopen the Safari Canvas/EchoVideo page; generating resources does not update an already-installed Safari app bundle. The regular `npm run check:safari` quality gate performs the same drift checks, but skips Xcode-project validation when no generated Safari project is present in the current environment.

## Testing

Unit and property tests cover VTT parsing, subtitle strategy, storage, translation payloads, the cross-browser API adapter, and error handling in `extension/`. Run the complete quality gate before submitting changes:

```bash
npm ci
npm run check
npm run test:coverage
```

After installing `backend/requirements.txt`, run the Python backend/CLI smoke regressions separately:

```bash
npm run test:python
```

`npm run check` syntax-checks every JavaScript and Python source file, runs the extension test suite, and produces both store and development builds. Tests live under `tests/unit/`, `tests/property/`, and `tests/python/`; see `vitest.config.js` for JavaScript test configuration.

## Defaults

- provider: `google-web`
- model: empty by default (Gemini preset: `gemini-3.1-flash-lite`)
- target: `ZH`
- max_paragraphs: `6` (the Google web endpoint refreshes progress per cue)
- max_chars: `1200`
- concurrency: `96` (the 1.4.2 profile is tried first; recovery lowers it only after a failed run)
- rps: `0` (no added pacing on the first run; recovery uses `3` RPS only after a failed run)
- retries: `1`
- timeout: `10`
- reasoning_effort: empty by default
- deepseek_thinking_mode: `disabled`

Supported providers: `google-web`, `deepseek`, `openai`, `gemini`, `deepl`, plus the development/local-backend-only `argos` provider. `google-web` and `argos` do not require API keys.

Target language options: `ZH`, `ZH-HK`, `YUE`, `EN`, `JA`, `KO`, `FR`, `DE`, `ES`, `IT`, `PT`, `RU`, `AR`, `HI`.

In the Chrome Web Store build, advanced translation settings only show provider-specific options:
- OpenAI: `Reasoning Effort`
- DeepSeek: `DeepSeek Thinking` (disabled by default to reduce latency)
- Gemini: default model `gemini-3.1-flash-lite`
- DeepL: `DeepL Formality`

The dev build also keeps local-backend tuning controls such as `maxParagraphs`, `maxChars`, `concurrency`, `rps`, `retries`, `timeout`, `fallbackMode`, `repairConcurrency`, and `slowSplitThreshold`.

Language notes:
- `deepl` does not support `YUE`; use an AI provider instead (`deepseek`/`openai`/`gemini`)
- `argos` explicitly uses English source subtitles. It supports installed pairs such as `ZH` (`en→zh`) and `ZH-HK` (`en→zt`), but does not support `YUE` or accept `EN` as the target.

Google Translate provider:
- `google-web` uses an unofficial web endpoint and does not require an API key, so it is useful for quick first-run testing
- The store build calls it directly from the extension frontend; the dev build can optionally proxy it through the local backend
- The backend/script path restores the 1.4.2 speed profile: default `concurrency=96, rps=0` (no added pacing), while keeping `max_chars=1200, max_paragraphs=1` for independent incremental updates
- This endpoint is unofficial, so stability, availability, and translation quality are not guaranteed
- For better subtitle translation quality, use an AI/API provider such as `deepseek`, `openai`, `gemini`, or `deepl` with your own API key

For the direct extension path, `google-web` restores the 1.4.2 default speed profile: up to `96` workers with default `rps=0` (no added pacing). An explicitly supplied positive `rps` is still honored. Each cue is handled independently; `HTTP 429` uses `Retry-After` or exponential backoff, failed cues keep their original text and appear in `failed_items`, and partial results are not cached. The extension Console reports the effective concurrency/RPS, progress, retries, 429s, queue waits, and final failure summaries. The endpoint has no public, stable official QPS guarantee, so formal Google Cloud Translation quotas should not be applied to it directly.

Argos Translate provider (development build only):

`argos` loads local Argos models directly inside the existing Python translator subprocess. It does not require a second LibreTranslate service and does not send subtitle text to a third party. The runtime uses one worker to avoid model contention and duplicate CTranslate2 memory use. Standalone backend artifacts already contain the Simplified and Traditional Chinese models; only source development requires installing the optional dependency and models in the backend virtual environment:

```bash
cd backend
source .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -r requirements-argos.txt
argospm update
argospm install translate-en_zh
python -c 'from argostranslate import sbd; sbd.minisbd_models.download_models(["en"])'
# Traditional Chinese: argospm install translate-en_zt
```

The last command explicitly preloads MiniSBD's English sentence-boundary model. Then build and load the development extension and select `Argos Translate (local)` in the full settings page. Saving automatically enables the local backend. Translation never downloads models or accesses the network silently: missing runtime dependencies, language packages, and sentence-boundary models are reported as `ARGOS_DEPENDENCY_MISSING` or `ARGOS_MODEL_MISSING`, with actionable installation guidance.

## Privacy

See [PRIVACY.md](PRIVACY.md). The extension sends subtitle text to the translation provider selected by the user; with `argos`, subtitles stay on the local machine. API keys and subtitle cache are stored in Chrome local storage.

## Backend Translator Invocation

The backend builds an argument list directly instead of shell-parsing a command string. By default it uses:

```text
TRANSLATOR_API_KEY=... python translator/translate_vtt_zh_deepl_native.py input.vtt --out translated.vtt --provider deepseek --model deepseek-v4-flash --target ZH
```

Optional environment overrides:

```bash
export TRANSLATOR_SCRIPT=/absolute/path/to/translate_vtt_zh_deepl_native.py
export TRANSLATOR_PYTHON_BIN=/absolute/path/to/python
```

The translator script comes from [bryanxianyu/VTT-Translator](https://github.com/bryanxianyu/VTT-Translator), and this repository keeps a vendored snapshot at `translator/translate_vtt_zh_deepl_native.py`.

The backend detects support for optional translator flags:

- `--request-timeout`
- `--openai-reasoning-effort`

Unsupported optional flags are skipped with a warning instead of being sent to the translator.

## Caching

Source mode stores translated VTT files in the git-ignored `backend/.cache/`; the standalone backend uses the current user's platform cache directory. Set `ECHO360_CACHE_DIR` to override it explicitly.

Cache identity is based on content-affecting inputs:

- source VTT text
- provider/model/endpoint
- target language
- max paragraphs/chars
- bilingual backend mode
- reasoning effort

Performance-only settings such as concurrency, RPS, retries, and timeout are not part of the content cache key.

The extension keeps one local translated VTT cache entry. Bilingual display is rendered client-side, so toggling bilingual subtitles does not require retranslating.

## Notes

- `page_probe.js` is still injected in the page context to read Echo360/React video UUID hints for better subtitle-to-video mapping.
- Detailed network body capture in the probe is disabled by default.
- If a separated intro clip exists, the extension prefers strong media-id mapping first and timeline/state matching as fallback.
- Transcript-panel-only lessons without player CC rely on the `transcript-file` API (1.2.2); those pages have no native CC DOM to inject into, so `hasNativeCaptionCapability()` detects that and uses the browser track directly.
- Incremental preview partial VTT is emitted per batch by `direct_translator.js`, polled via `background.js` jobs; `buildIncrementalPreviewVtt()` replaces untranslated cues with placeholder text.
Beta-first rendering, capability detection, and perf/UI polish

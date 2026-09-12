# echo360-online-subtitle-translator

[简体中文](README.md) | **English**

Chrome/Safari extension for loading translated subtitles on Echo360 recordings and Canvas-embedded Instructure Media videos. Online providers are called directly; only Argos and the explicitly selected custom-backend provider use a backend protocol.

Current extension version: **1.6.0**

## What It Does

1. Finds the VTT subtitle source for the current Echo360 lecture or Canvas-embedded video (player CC, network capture, `transcript-file` API, etc.).
2. Google, DeepSeek, Gemini, OpenAI, DeepL, and Azure AI Translator are called directly (`direct_translator.js`). Argos automatically uses the fixed loopback backend; the custom backend URL is used only when that provider is explicitly selected.
3. The Argos backend calls `translator/translate_vtt_zh_deepl_native.py` for offline/fallback work. There is no longer a contradictory global “use local backend” switch.
4. Displays translated subtitles on the active Echo360 video; **the default is the browser `<track>` renderer**. Enable **使用原生 CC 注入（Beta）** in settings to try Echo360 native CC injection (may still miss cues at higher playback speeds; falls back automatically when the lesson has no native caption slot).
5. **Incremental display while translating** (1.3.0): subtitles mount immediately on click; pending cues show `正在翻译中...` until each batch completes.
6. **Per-provider API keys** with real-time sync between the popup and options page; switching providers loads the matching key automatically.
7. **Manual AI round trip**: click `AI 手动翻译` to download one compact `.translate.json` containing the full course cue map and copy a short prompt. A file-capable AI translates the complete map and returns one import-ready `.translated.json`; the extension uses the bound session to verify source SHA-256 and target, then checks the complete ID set, WebVTT tags, code/URL/path/email literals, and numbers before rebuilding playback VTT locally from the immutable source.

## Subtitle Source Discovery

`source_finder.js` tries multiple strategies in priority order and maps subtitles to the active video:

- CC / `<track>` VTT already attached to the player
- VTT URLs captured via the page probe and network layer
- **Transcript-panel fallback** (1.2.2): when the player has no usable CC, call  
  `/api/ui/echoplayer/lessons/{lessonId}/medias/{mediaId}/transcript-file?format=vtt`

If every strategy fails, the control panel reports that no usable subtitle source was found.

## Translation and Display Flow

**Direct translation path** (Google, DeepSeek, Gemini, OpenAI, DeepL, and Azure AI Translator):

1. Click `加载翻译字幕` → if mountable, subtitles appear immediately (pending cues show `正在翻译中...`).
2. While translating → each partial VTT hot-updates completed cues; status shows `翻译中 X/Y（已开始显示）`.
3. On completion → a final incremental refresh applies the full VTT without tearing down the renderer.

**Limits:**

- Incremental preview is only available on the in-extension direct path (`direct_translator.js` → background job). The local FastAPI backend still waits for the full VTT before display.
- A local translation cache hit mounts the complete subtitles immediately (no incremental flow).

### Manual AI translation

Manual translation now defaults to one compact `.translate.json` containing the full course cue map plus a copied task prompt. The input keeps only the session, target language, and ordered `cue ID → source text` map; timecodes, repeated context, chunk metadata, and client-only validation data stay local.

Give the JSON and the copied prompt to a file-capable AI once. The short prompt contains only the task rules and cue count, so it does not duplicate the subtitle body; it asks the AI to translate every cue and return one complete `.translated.json`. Users do not need to split, merge, or paste batches. If the AI cannot handle the full file in one response, choose **AI 不能一次处理整份文件？改用逐批模式**. The extension then copies one bounded batch at a time and prepares the next request after each import.

The AI must write real translations, never a dictionary, regex substitution, or stop-word deletion script. Import validates JSON syntax, the complete ID set, non-empty translations, WebVTT tag structure, code/URL/path/email literals, numbers, and obvious language defects before mounting. A complete-file result with one isolated, locatable failure (at least 10 cues) or at most 20 failures with at least 99% success is loaded as a marked partial result and saved in the local manual progress; larger failures remain progress-only and are never treated as a complete translation. Cue-wide speaker/style wrappers are restored locally; original timing, settings and metadata remain unchanged, and the complete VTT can be downloaded after repair.

The latest course's progress is stored locally and can be resumed within 30 days; saved entries are revalidated on resume. If storage fails, the UI explains that progress remains in the current page only. The v2 JSON and full VTT paths first use strict validation; a v2 complete-file result enters the partial-preservation path only for the isolated failures described above. Language checks are heuristics, not a guarantee of semantic accuracy. Direct and backend translation paths are unchanged.

See the [manual AI subtitle translation protocol](docs/manual-ai-translation-protocol.md) for the wire format, validation rules, and compatibility policy.

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
   - Translation still uses the same timed VTT and cache. Cues are rendered against `video.currentTime` in an extension-owned overlay, so translated subtitles do not depend on the native CC toggle and do not leak between the page's multiple videos. The default mode preserves Vidstack's native CC and moves Chinese above a visible native cue without duplicating its English. Only explicit **native CC injection (Beta)** hides and occupies the native captions position.
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
build_config.js           Build target (dev/store) and Argos-backend capability flag
assessment_guard.js       Fail-closed Canvas assessment/assignment context gate
canvas_course_bridge.js   Data-free proof bridge limited to Canvas course-content/external_tools routes
browser_api.js            Chrome / Safari storage and runtime API abstraction
config_keys.js            Shared per-provider API key logic for popup/options
constants.js              Shared defaults and option lists
host_support.js           Echo360 / Canvas Instructure Media host detection and adapter helpers
vtt.js                    Pure VTT parsing, formatting, bilingual, and incremental preview helpers
manual_translation.js     Manual-AI compact JSON, literal/tag checks, strict import, and local VTT rebuild
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
backend_startup.js        Argos health checks, in-flight deduplication, and staged relaunch
background.js             Service worker (direct jobs, backend proxying, and partial_vtt storage)
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

- macOS: extract `echo360-online-subtitle-translator-backend-macos-*.tar.gz`, move `Echo360 Subtitle Backend.app` to Applications, and open it at least once;
- Windows: extract `echo360-online-subtitle-translator-backend-windows-x64.zip`, then run `Echo360SubtitleBackend\install-and-launch-echo360-subtitle-backend.cmd` once. It registers the launch protocol for the current user only and does not require administrator rights.

The program listens only on `127.0.0.1:8765`; selecting Argos makes the extension use that address automatically, with no user-facing Backend URL. Quit the program to stop it. Translation cache files go to the current user's platform cache directory rather than the application directory.

On first launch, bundled Argos models are copied into the user's application-data directory. A cross-process atomic install lock and a post-copy integrity check now prevent the server and translator processes from deleting one another's freshly installed model. The extension checks `/health` when Argos is selected, translated, retranslated, or used as the Google 429 fallback. If necessary it opens `echo360-subtitle-backend://start`. Edge's external-protocol confirmation is a browser security boundary that an ordinary extension cannot silently bypass, so any required confirmation now opens in the active tab and closes automatically once `/health` succeeds. Equivalent loopback spellings are canonicalized to the server's real IPv4 endpoint, concurrent callers share one attempt, and swallowed protocol launches are retried in a 75-second window. The preparing stage immediately exposes the known subtitle total instead of lingering at `0/0`. Failed attempts are removed so the next click can genuinely retry. The workflow artifacts remain intended for testing/internal distribution until Authenticode signing and Apple Developer ID notarization are configured.

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

On an Echo360 classroom page, a **split dock control** appears at the bottom right. Its large button checks the cache and loads/starts the default translation while copying the AI prompt and downloading the complete `.translate.json` input. The adjacent disclosure button opens the slide-out panel, and the import button becomes available when the current source session is ready so an AI-produced `.translated.json` can be loaded quickly. First-time installs see a one-time onboarding bubble. You can also configure the provider and API key from the extension popup (`popup.html`) or options page (`options.html`); keys are stored per provider and switch automatically when you change provider. Use `重新翻译` in the panel to clear the current cache and rerun translation.

## Release Builds

Install Node dependencies at the repo root first:

```bash
npm install
```

Use the store build for Chrome Web Store submission:

```bash
npm run build:store
```

Build outputs:
- `dist/extension-store/`
- `dist/echo360-online-subtitle-translator-store.zip`

The store build retains the fixed loopback permissions needed by Argos. There is no global backend toggle: Argos uses loopback automatically, online providers always remain direct, and the custom-backend provider alone uses its configured local-HTTP or remote-HTTPS URL after requesting that origin as an optional permission.

For local development:

```bash
npm run build:dev
```

The dev build also keeps Argos, loopback permissions, and backend tuning fields, with a development name so it can be installed alongside the release build.

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
- concurrency: the shared setting defaults to `96`; Google Translate is capped at `48`, Azure AI Translator at `8`, with other providers unchanged
- rps: `0` (no added pacing on the first run; recovery uses `3` RPS only after a failed run)
- retries: `1`
- timeout: `10`
- reasoning_effort: empty by default
- deepseek_thinking_mode: `disabled`

Supported providers: `google-web`, `deepseek`, `openai`, `gemini`, `deepl`, `azure`, `argos`, and `custom-backend`. `google-web`, `argos`, and `custom-backend` do not require API keys; Azure requires the user's own Translator subscription key. A custom backend must implement the same `/translate`, `/translate-async`, and `/translate-async/{job_id}` JSON contract as this project.

Target language options: `ZH`, `ZH-HK`, `YUE`, `EN`, `JA`, `KO`, `FR`, `DE`, `ES`, `IT`, `PT`, `RU`, `AR`, `HI`.

In the Chrome Web Store build, advanced translation settings only show provider-specific options:
- OpenAI: `Reasoning Effort`
- DeepSeek: `DeepSeek Thinking` (disabled by default to reduce latency)
- Gemini: default model `gemini-3.1-flash-lite`
- DeepL: `DeepL Formality`
- Azure AI Translator: optional `Azure Region`

The dev build also keeps local-backend tuning controls such as `maxParagraphs`, `maxChars`, `concurrency`, `rps`, `retries`, `timeout`, `fallbackMode`, `repairConcurrency`, and `slowSplitThreshold`.

Language notes:
- `deepl` does not support `YUE`; use an AI provider instead (`deepseek`/`openai`/`gemini`)
- `argos` explicitly uses English source subtitles. It supports installed pairs such as `ZH` (`en→zh`) and `ZH-HK` (`en→zt`), but does not support `YUE` or accept `EN` as the target.

Azure AI Translator provider:

- `azure` uses the official Translator v3 REST API. Create an Azure Translator F0 resource and enter that resource's subscription key in the extension.
- A global Translator resource needs only its key. Multi-service or regional resources also need the Region/Location shown in Azure Portal (for example, `australiaeast`) in Advanced settings.
- With an empty Endpoint field, the extension uses `https://api.cognitive.microsofttranslator.com/translate`. For an Azure custom domain, enter the complete translate endpoint.
- Each request sends one subtitle batch as an ordered JSON array. The existing `max_paragraphs=6` and `max_chars=1200` limits still apply, and Azure concurrency is capped at `8`.
- `ZH`, `ZH-HK`, and `YUE` map to Azure `zh-Hans`, `zh-Hant`, and `yue`; every other project target maps to its corresponding Azure language code.
- HTTP 429, timeouts, and 5xx responses use the existing retry/backoff path. Invalid credentials, malformed responses, and incomplete batches are never cached as successes.
- The service worker alone reads and injects the locally stored API key. Never ship a shared Azure key in the repository or extension package.
- Official references: [authentication](https://learn.microsoft.com/azure/ai-services/translator/text-translation/reference/authentication), [Translate API](https://learn.microsoft.com/rest/api/translator/translator/translate?view=rest-translator-v3.0), and [language support](https://learn.microsoft.com/azure/ai-services/translator/language-support).

Google Translate provider:
- `google-web` uses an unofficial web endpoint and does not require an API key, so it is useful for quick first-run testing
- Every build calls it directly from the extension frontend; Argos/custom-backend settings cannot reroute it
- The backend/script path caps Google concurrency at `48` (half of the former `96`) while retaining `rps=0, max_chars=1200, max_paragraphs=1`
- This endpoint is unofficial, so stability, availability, and translation quality are not guaranteed
- For better subtitle quality and API stability, use an official API provider such as `azure`/`deepl`, or an AI provider, with your own API key

For the direct extension path, `google-web` uses at most `48` workers, half of the former `96`-worker cap, with default `rps=0` (no added pacing). An explicitly supplied positive `rps` is still honored. Each cue is handled independently. Isolated `HTTP 429` responses still use `Retry-After` or exponential backoff, but five 429 responses within ten seconds open a circuit breaker: new Google requests and retries stop, the old adaptive Google recovery is skipped, and the local backend is launched so Argos can take over. The Python backend uses the same threshold and preserves Google cues that already succeeded while Argos fills the unfinished cues. Any cues that still fail keep their original text and appear in `failed_items`, and partial results are not cached. The extension Console reports the effective concurrency/RPS, progress, circuit breaker, fallback, and final failure summaries. The endpoint has no public, stable official QPS guarantee, so formal Google Cloud Translation quotas should not be applied to it directly.

Argos Translate provider:

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

The last command explicitly preloads MiniSBD's English sentence-boundary model. Select `Argos Translate (local)` in full settings; saving or starting translation automatically checks and launches `127.0.0.1:8765`, with no separate toggle. Translation never downloads models silently: missing runtime dependencies, language packages, and sentence-boundary models are reported as `ARGOS_DEPENDENCY_MISSING` or `ARGOS_MODEL_MISSING`, with actionable guidance.

See the [local machine-translation research](docs/local-translation-research.md) for quality, speed, footprint, licensing, and migration recommendations.

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

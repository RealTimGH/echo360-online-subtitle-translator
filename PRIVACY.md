# Privacy Policy

This extension runs on supported Echo360 and Instructure Media lecture-player pages to load, translate, and display subtitle tracks. Its only top-level Canvas content-script match is `canvas.sydney.edu.au/courses/*/pages/*`, where a data-free isolated bridge verifies that an embedded media frame belongs to a course page. The bridge does not modify the Canvas DOM, read page text or keyboard input, access extension storage, or make a network request. Quiz, assignment, New Quizzes, taking, and ambiguous Canvas contexts are disabled before storage or translation activity starts.

The use of information received from Chrome extension APIs adheres to the Chrome Web Store User Data Policy, including the Limited Use requirements.

## Data Stored Locally

- Extension settings, such as provider, target language, subtitle display preferences, and optional API key.
- A small local subtitle cache so translated subtitles can be reused after a page refresh.

These values are stored in Chrome local storage on the user's device.

## Data Sent to Translation Services

When the user loads translated subtitles, the source subtitle text is sent to the selected translation provider:

- Google Translate
- DeepSeek
- OpenAI
- Gemini
- DeepL
- Azure AI Translator

API keys are sent only to the provider selected by the user. This project does not operate a remote server for collecting API keys, subtitles, account data, or browsing history.

The Argos Translate provider runs through the user's local backend and processes subtitle text with models installed on that same machine. Argos subtitle text is not sent to a third-party translation service.

There is no general “use local backend” setting. Online providers are called directly; Argos always uses the fixed local endpoint. If the user explicitly selects the custom-backend provider, subtitle text is sent to the local-HTTP or remote-HTTPS address they configure. The extension requests access only to that origin at save time.

The manual AI workflow prepares one local compact `.translate.json` containing the complete cue map plus a prompt after a supported video loads. It writes the prompt to the clipboard only when the user starts the manual workflow or activates the one-click translation control, and reads the clipboard only after the user activates an AI-translation import button. The result picker accepts the returned `.translated.json` (and legacy VTT/JSON formats). The extension does not upload the input or returned result itself; the user decides whether and where to provide them to an external AI service.

## Permissions

The Chrome Web Store build requests `clipboardRead` and `clipboardWrite` so the user-activated manual AI workflow can read a returned `.translated.json` or VTT and copy its prompt across supported extension contexts. These permissions can expose or modify the system clipboard, but the extension reads it only for the manual import action and does not send clipboard contents to a translation service. The build also requests host permissions for supported Echo360/Instructure Media player pages, configured translation-provider endpoints, and the fixed Argos loopback endpoint. It has no broad Canvas entry in `host_permissions`; its Canvas content-script matches are restricted to course pages/external-tool pages and contain only the course-page proof bridge. A custom backend's origin is an optional permission requested only after the user selects that provider and saves its URL.

## Contact

For issues, open a GitHub issue in this repository.

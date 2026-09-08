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

API keys are sent only to the provider selected by the user. This project does not operate a remote server for collecting API keys, subtitles, account data, or browsing history.

The optional Argos Translate provider is different: it is available only in development builds, runs through the user's local backend, and processes subtitle text with models installed on that same machine. Argos subtitle text is not sent to a third-party translation service.

The Chrome Web Store build does not enable the local backend feature. Development builds may enable a local backend on the user's own machine for testing or offline Argos translation.

## Permissions

The Chrome Web Store build requests host permissions for supported Echo360/Instructure Media player pages and configured translation provider endpoints. It has no broad Canvas entry in `host_permissions`; its one Canvas content-script match is restricted to `/courses/*/pages/*` and contains only the course-page proof bridge. Development builds may additionally request localhost permissions for local backend testing.

## Contact

For issues, open a GitHub issue in this repository.

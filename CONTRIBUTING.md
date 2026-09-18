# Contributing

Use Node.js 20.19+, 22.12+, or 24+ and Python 3.10 or later. Install JavaScript dependencies with `npm ci` and the lightweight backend dependencies with `python -m pip install -r backend/requirements.txt`. `npm run test:python` rejects unsupported or dependency-incomplete interpreters; set `ECHO360_TEST_PYTHON=/absolute/path/to/python` when more than one Python installation is present.

Before submitting a change, run:

```sh
npm run check
npm run test:coverage
npm run check:dependencies
```

`npm run check` validates JavaScript/Python syntax, extension resource references and CSP, local documentation links/contracts, JavaScript and Python tests, and Chrome build outputs. It also synchronizes and verifies Safari resources when a generated Xcode project is present; a clean non-macOS checkout reports that platform-specific check as skipped. Run `npm run safari:prepare` on macOS to require the generated Xcode project and validate both Safari targets. A change to provider names, target codes, error codes, the backend JSON contract, or VTT validation must include boundary-focused regression tests in both affected runtimes.

Keep user-facing documentation aligned with behavior. Changes to providers, permissions, supported hosts/routes, setup commands, minimum runtimes, privacy/data flow, security boundaries, or release behavior must update both `README.md` and `README.en.md` plus `PRIVACY.md`, `SECURITY.md`, or `CHROME_STORE.md` where applicable.

Keep secrets out of source, test fixtures, logs, and issue reports. Use placeholders in diagnostics. Do not weaken assessment guards, message-sender checks, endpoint validation, host permissions, or result validation without a documented threat-model review.

The extension currently uses classic scripts whose manifest order is a runtime dependency. Add a new content script only in dependency order, run `npm run check:structure`, and add a bootstrap-oriented test. Prefer extracting cohesive modules over adding another responsibility to `background.js`, `controller.js`, `direct_translator.js`, `error_utils.js`, or `backend/app.py`.

The packaged and documented source backend entrypoint is `python -m backend.launcher`; it is local-only by default. A non-loopback `--host` requires the explicit `--allow-remote` acknowledgement and must be deployed behind an authenticated, TLS-terminating proxy; CORS is not authentication. Preserve bounded streamed resource reads, request/job admission limits, translator subprocess deadlines, and bounded diagnostic tails.

# Security Policy

Please report suspected vulnerabilities through GitHub's [private vulnerability reporting form](https://github.com/RealTimGH/echo360-online-subtitle-translator/security/advisories/new) rather than opening a public issue. Include the affected version, a minimal reproduction, expected impact, and whether credentials or private subtitle data may have been exposed. Do not include live API keys or private captions.

Supported development is currently on the latest repository version. Published artifacts are intended for testing/internal distribution until the signing and notarization work described in the README is complete.

Security boundaries that should be preserved include:

- Manifest V3 with a self-only extension-page CSP;
- explicit sender validation at the service-worker message boundary;
- HTTPS provider/custom-backend endpoints, except loopback HTTP for local development;
- fixed backend proxy routes without caller-supplied headers;
- loopback-only packaged backend listening unless remote exposure is explicitly acknowledged and protected externally;
- redaction of API keys, signed URLs, and subtitle-source query strings from diagnostics and page DOM;
- strict VTT/result validation, bounded streamed subtitle reads, and bounded request/job sizes;
- translator capability-probe and whole-task deadlines, terminate/kill cleanup, and bounded subprocess diagnostics.

Do not publish credentials, private captions, signed media URLs, or unredacted logs in a public issue. General non-security bugs may use the issue tracker; suspected vulnerabilities should follow the private reporting direction above.

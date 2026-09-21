# Echo360 native-caption anchoring

## Failure mechanism

The original renderer confused an unavailable native DOM anchor with disabled native
captions. After 420 ms it displayed the bottom fallback, then switched back above
the native cue when discovery succeeded. Open shadow-root mutations were not
observed, so discovery could lag until the 900 ms refresh. Narrow native captions
under 80 px were rejected outright. Control-bar discovery could also select the
entire player while walking button ancestors, causing all native captions to be
excluded as control text. Player/video-containing ancestors are now ineligible.
These mechanisms are reproducible locally; the private Canvas lesson was not
opened, so its exact player DOM is unverified.

Two additional layout defects compounded placement instability: the overlay did
not explicitly use absolute positioning, and translated stack height was measured
while its parent could still be hidden. A viewport/local-coordinate mix in fallback
placement also made page offsets affect its bottom position.

The first fix hid the translation when a confirmed native node was unavailable for
more than 420 ms. The user reported disappearing Chinese in Chrome and preferred
retaining the last position. The final implementation removes that timeout/hiding
policy entirely; missing native DOM is not a reason to hide an active translation.

## Final behavior

- Save the last native anchor as three normalized player-local numbers (left,
  top, width). Retain it across missing DOM nodes, cue transitions and seeks in
  the same mounted video. Translation text always follows the active cue, rather
  than freezing the previous cue's text. A new native measurement replaces it.
- Keep native font properties as plain string values, not a live style object or
  detached DOM node. Text size/style does not reset during a native-node hand-off.
- Local geometry follows player movement automatically and scales with player
  resize. The CSS gap stays 6 px. When native layout returns, measure it afresh.
- Explicit CC off clears the anchor/style and uses standalone output. Unmount,
  video replacement or media `emptied` clears the session. No active translation
  cue, or the user disabling translation, still hides the overlay normally.
- Before any reliable native anchor has ever been seen, display the active
  translation at a fallback baseline with a two-line English reservation rather
  than waiting invisibly. This initial reservation is an estimate, not a guarantee
  of an unknown native cue's position. The first native measurement calibrates it.
- Observe discovered open shadow roots with the existing MutationObserver. Release
  detached roots during discovery, and disconnect observers on hide/unmount.
  Closed shadow roots and browser-owned text-track internals remain inaccessible.
- Position the overlay absolutely. Use native top minus the gap together with
  `translateY(-100%)`: the actual translated bottom stays anchored despite wrapping,
  font changes or visibility during initial layout. Convert viewport measurements
  to player-local CSS coordinates with scale/border correction.

## Performance strategy and sources

Floating UI supports virtual references derived from geometry rather than a live
DOM element: https://floating-ui.com/docs/virtual-elements . Retaining the last
confirmed geometry during native-node replacement is our application of that
mechanism, not a claim that its documentation mandates this caption policy.

Its automatic-update guidance recommends relevant observers/listeners, cleanup
when the overlay is removed, and sparing use of continuous frame positioning:
https://floating-ui.com/docs/autoupdate . MDN documents event-driven mutation and
size observation:
https://developer.mozilla.org/en-US/docs/Web/API/MutationObserver and
https://developer.mozilla.org/en-US/docs/Web/API/Resize_Observer_API . Browser layout
cost is particularly affected by repeated forced geometry reads after writes:
https://web.dev/articles/avoid-large-complex-layouts-and-layout-thrashing .

The implementation applies these principles without a new runtime dependency:

- Stable anchors no longer trigger periodic full-player rediscovery. Only a missing
  anchor gets the bounded 900 ms retry, needed for unobservable `attachShadow()` or
  CSS-only visibility changes. Cue/structural changes invalidate discovery as needed.
- Stable video-frame/timeupdate events use a 900 ms geometry watchdog instead of
  a 200 ms full render. Cue boundaries still update immediately via video frames.
- Relevant native mutations update immediately as an observer batch. ResizeObserver
  also watches the current native anchor. Pointer/control changes retain the existing
  bounded 100 ms refresh window for moving controls.
- Unrelated progress-bar style mutations do not flush selector caches or schedule
  layout. Overlay's own mutations are filtered out individually.
- Hiding translation disconnects MutationObserver and ResizeObserver, cancels frame
  callbacks/timers, and releases discovery-node references. Showing it rescans and
  resubscribes. Retained geometry/style is a fixed-size plain object.
- No new repeating timer, network request, disk write, persistent cache or library.

## Validation and measured work counts

`tests/unit/echo_caption_renderer.test.js` covers state transitions and bounded work.
`tests/fixtures/echo-caption-position.html` is a real-browser PASS/FAIL layout check.
A local Chrome run verified a 4.80 screen-pixel gap in an 80%-scaled bordered player:
wrapping/font changes, native absence for 1200 ms with uninterrupted translation,
font retention, page movement, player resize, next-cue text during absence, native
shadow reinsertion, stable player height and unmount cleanup all passed.

`tests/fixtures/echo-caption-performance.html` is a browser operation-count probe.
It simulates 600 video-frame callbacks spanning 10 seconds with a stable cue, then
100 DOM-change deliveries while translation is disabled. Comparing the previous
turn's renderer with this revision in the same local Chrome setup produced:

| Metric | Previous fix | Retained-anchor revision |
| --- | ---: | ---: |
| Full player subtree queries during stable frames | 40 | 0 |
| Instrumented player/video/native geometry reads | 330 | 55 |
| Observer callbacks during 100 hidden-state changes | 100 | 0 |

These are synthetic workload/API-call counts, not real Canvas playback CPU%,
RSS, battery or disk-I/O benchmarks. They demonstrate less scheduled work without
claiming a device-independent CPU reduction. Initial mount is excluded from the
stable-frame counts; new cues, actual layout changes and missing anchors require
additional work.

## Stable line layout and frame timing

Translation now uses a constant 96% player text area and fixed typography scaled
only by the user's size option. Neither a narrow English glyph box nor delayed
native font discovery changes Chinese wrapping. Text that exceeds available width
still wraps to avoid clipping; this does not force arbitrarily long text into an
unreadable single line.

During playback, requestVideoFrameCallback's mediaTime is the authoritative clock
after acquisition, including when DOM/timeupdate callbacks cause a render. Seeking
resets that clock; paused/unsupported browsers use currentTime. The previous fast
path also incorrectly held an older overlapping cue; it now selects the latest
active cue. WebVTT end timestamps with cue settings are parsed independently.
Sources: https://web.dev/articles/requestvideoframecallback-rvfc and
https://developer.mozilla.org/en-US/docs/Web/API/WebVTT_API/Web_Video_Text_Tracks_Format .
These fix reproducible implementation issues; actual native-player custom delays
cannot be determined without the user's reproduction/DOM. No guessed global
timing offset is applied.

The user confirmed Chinese sometimes advanced while English still showed the old
cue. When the confirmed visible native node still exactly contains the previous
English cue, Chinese now waits for its mutation/removal instead of advancing from
the media clock alone. A separate timeline index prevents this pending hand-off
from triggering layout every video frame. Explicit seeks disable the old-node
hold until a fresh anchor is found. This is covered by a regression that delivers
60 frames while English is unchanged and asserts zero additional geometry reads.

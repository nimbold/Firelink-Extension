# Changelog

All notable changes to Firelink Companion will be documented in this file.

## [2.0.4] - 2026-07-15

### Improved
- Make browser-to-Firelink handoffs more reliable when Firelink is still starting or several requests arrive together. Each request now keeps its own startup deadline.

### Fixed
- Show invalid pairing tokens as authentication errors and avoid mistaking unrelated local `403` responses for the Firelink desktop app.

## [2.0.3] - 2026-07-12

### Fixed
- Keep explicit media fetches on Firelink's configured yt-dlp cookie source instead of forwarding a potentially oversized raw browser cookie header.
- Keep ordinary captured downloads able to use their browser session while preventing explicit media requests from carrying stale or oversized cookies into metadata fetching.

## [2.0.2] - 2026-07-08

### New
- Add Fetch media actions in the popup and page/video/audio context menus.

### Improved
- Compact the popup layout so pairing, capture, per-site controls, and media fetch fit without long guidance text.
- Require Firelink local protocol v4 for explicit Fetch media handoffs so older desktop builds do not silently treat them as normal downloads.
- Forward container-aware cookies only for automatic single-download captures; explicit media uses Firelink's configured yt-dlp cookie source.

### Fixed
- Fall back to selected-text URL parsing when the browser cannot expose a tab for the selected-link context menu.

## [2.0.1] - 2026-07-06

### New
- Add a Chromium load-unpacked package for Chrome, Edge, Brave, Vivaldi, Opera, and other Manifest V3 Chromium browsers.
- Add a Chromium Manifest V3 service-worker bootstrap that reuses the existing Firelink protocol and background handoff logic.
- Add a packaging script that generates separate `dist/firefox` and `dist/chromium` browser builds.

### Improved
- Publish separate Firefox and Chromium release ZIP artifacts.
- Keep the existing `firelink.zip` release asset as a Firefox-package compatibility alias.
- Clean up the README installation flow and document manual Chromium installation limits while the extension is not yet available from a browser store.
- Use browser-neutral Firelink launch notification copy for cross-browser installs.

## [2.0.0] - 2026-07-04

### Breaking
- Require the Firelink 1.0 desktop app and its local protocol v3 for automatic download capture.
- Older desktop builds are rejected before the extension can cancel an automatic browser download.

### New
- Add stronger desktop-server identity checks before trusting localhost responses.
- Add dynamic port discovery across Firelink's `127.0.0.1:6412-6422` listener range.
- Add safer explicit launch behavior through `firelink://launch` when the app is closed.
- Add clearer offline, invalid-token, and update-required behavior for browser handoff failures.

### Improved
- Route automatic captures through Firelink's Add window while preserving the browser download unless Firelink confirms acceptance.
- Keep manual context-menu downloads free of browser cookies by default.
- Forward browser cookies only for automatic single-download captures that need the browser session.
- Avoid sharing one site's cookies across multi-link batches.
- Keep the extension package self-contained for Mozilla review by removing remote font loading.
- Update Firefox compatibility metadata and data-collection declarations for the current add-on store requirements.

### Fixed
- Fix event-page startup races so capture settings are respected after the background worker wakes up.
- Fix unsupported Firefox notification-button usage that could prevent capture listeners from registering.
- Fix protocol fallback paths that could open unnecessary tabs or lose the original browser download.
- Fix host permissions and local API port metadata so the extension matches the Firelink 1.0 desktop listener.

## [1.0.15] - 2026-06-24

### Compliance

- Remove remote Google Fonts import so the extension package is fully self-contained at runtime.
- Correct Mozilla data-collection declaration for the required local handoff of download URLs, referrers, cookies, and request metadata to the Firelink app.
- Require Firefox 140+ on desktop and Firefox for Android 142+ so Mozilla's built-in data-collection consent prompt is available.
- Drop unused `activeTab` permission; existing host access covers the current content-script and cookie handoff flows.
- Require the desktop app's protocol v2 contract before automatic browser captures can cancel the browser download.

## [1.0.14] - 2026-06-22

### Fixes
- Remove the unsupported Firefox notification-button API that prevented background capture listeners from registering.
- Verify the Firelink server identity before treating localhost responses as authoritative or sending download URLs.
- Use the registered `firelink://` protocol directly when an explicit "Download with Firelink" action finds the app offline.
- Stop intercepting normal page clicks so offline fallback preserves the browser and website's original download behavior.
- Never attach one site's cookies to a multi-URL handoff.
- Restore the automatic-capture `silent` payload contract and resume browser downloads without offline notification spam.
- Refresh the packaged extension so its host permissions and API port range match the desktop app's `127.0.0.1:6412-6422` listener.
- Never open a protocol tab after a successful direct handoff.
- Resume browser downloads whenever Firelink does not confirm acceptance.

## [1.0.13] - 2026-06-13

### Integration
- Connect to the rewritten Firelink desktop app through the fixed `127.0.0.1:23522` endpoint instead of scanning legacy ports.
- Share one signed-request implementation between the background worker and popup.
- Add request timeouts and explicit server detection for clearer offline and invalid-token states.

### Reliability
- Wait for persisted settings before handling context menu and browser download events.
- Pause intercepted browser downloads during handoff, resume them if Firelink is unavailable or rejects the request, and cancel them only after Firelink confirms acceptance.
- Disable deep-link fallback for automatic captures so browser downloads are never discarded without an API acknowledgement.

## [1.0.12] - 2026-06-11

### Security Fixes
- Upgraded the Firelink app connection protocol to use HMAC-SHA256 signatures, preventing unauthenticated access to the local extension server.
- The extension now correctly signs the payload and a timestamp using the pairing token instead of passing it as a simple HTTP header.

### Fixes
- Prevented the extension from falling back to deep linking if the pairing token hasn't been set, fully closing a token bypass vulnerability.
- Added a `silent` flag to the payload when capturing background downloads to explicitly differentiate auto-captures from manual context-menu clicks, restoring the intended "Add Downloads" bypass behavior.
- Updated the connection status check in the popup to correctly sign the `/ping` request, resolving an issue where it incorrectly displayed "App is closed".

## [1.0.11] - 2026-06-10

### Fixes
- Fix Manifest V3 service worker/event page state race condition to ensure user settings (like disabling global capture) are strictly respected upon wakeup.
- Pause browser downloads while pinging the Firelink app to reliably prevent duplicate files from being downloaded.
- Remove inline `onerror` attribute in the popup to ensure 100% compliance with Firefox's strict Manifest V3 Content Security Policy (CSP).

## [1.0.10] - 2026-06-09

### Improvements
- Polish the pairing-token popup UI by moving inline styles into the extension stylesheet and masking the token input by default.
- Document that Firelink app updates now use GitHub Releases while the browser extension remains a separate add-on release.

### Changes
- Remove stale references to the old static `firelink-extension-v1` token from the background script.

## [1.0.9] - 2026-06-09

### Improvements
- Update connection check to correctly handle empty pairing tokens by displaying a "Setup Required" state.

### Fixes
- Fix notification spam by suppressing the "Firelink Setup Required" alert on automatic background downloads when the token is missing.

## [1.0.8] - 2026-06-08

### New Features
- Add pairing-token setup in the extension popup for Firelink's dynamic local API authorization.

### Improvements
- Keep manual "Download with Firelink" actions resilient by preserving the custom protocol fallback when the local Firelink API is unavailable.
- Check the native app through `/ping` and show clearer connected, offline, setup-required, and invalid-token states.

### Changes
- Use the changelog entry for GitHub release page descriptions so published release notes match the source tree.
- Remove reliance on the old static `firelink-extension-v1` token.

### Fixes
- Prevent global download capture from canceling or erasing the browser download unless the native Firelink app confirms the local API handoff.

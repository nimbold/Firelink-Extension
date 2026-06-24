# Changelog

All notable changes to Firelink Companion will be documented in this file.

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
- Use the registered `firelink://` protocol directly when an explicit “Download with Firelink” action finds the app offline.
- Stop intercepting normal page clicks so offline fallback preserves the browser and website’s original download behavior.
- Never attach one site’s cookies to a multi-URL handoff.
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

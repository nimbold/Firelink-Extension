# Firelink Companion Privacy Policy

Effective date: 2026-08-28

Firelink Companion is a Microsoft Edge extension that connects Edge to the Firelink desktop download manager. This policy is intended for the Microsoft Edge Add-ons listing and describes the extension package at the time of publication.

## What the extension accesses

Depending on the feature you enable or use, Firelink Companion can access:

- Browser download details such as a URL, filename, referrer, state, and download identifier.
- The current page URL, page title, selected links, magnet links, and torrent links when you invoke a context-menu or popup action.
- Browser cookies for an automatic ordinary download when the signed-in browser session is needed to preserve that download.
- A local pairing token, capture settings, language, theme, and pending handoff state in browser extension storage.

The extension uses packaged code only. It does not inject an in-page media overlay and does not use a remote script or remote code service.

## Why this information is used

This information is used only to send a download or media handoff that you requested, or an automatic browser download that you enabled, to the Firelink desktop application. Captured requests open Firelink's Add window so you can review them before starting or queuing a download.

Explicit **Fetch media** requests send the canonical page URL to Firelink. They do not send a raw browser `Cookie` header. Firelink obtains media authentication through its configured media cookie source.

## Where information is sent

Handoff requests are sent only to the separately installed Firelink desktop application that the user pairs, through its signed local API on `127.0.0.1` in Firelink's documented local port range. The extension does not send download URLs, page data, cookies, pairing tokens, or analytics to a Firelink-operated remote server.

Firelink Companion does not contain advertising, cross-site tracking, an analytics SDK, or a data-broker integration. It does not sell personal information.

## Storage and control

The extension stores pairing and preference data in the browser's extension storage and may retain an in-progress handoff until the browser service worker can recover it safely. You can change capture and site settings in the popup, remove the pairing token, disable the extension, or uninstall it. Firelink may keep accepted downloads in its own local application data according to the desktop application's behavior.

## Security

Requests to Firelink are authenticated with the local pairing protocol and signed with the pairing token. The extension does not log or intentionally expose pairing tokens, cookies, or authorization headers.

## Third parties and changes

No third-party remote service is required by the extension. Firelink Companion may be updated to support browser or desktop protocol changes. Material privacy changes will be reflected in this policy and the store listing.

## Contact

For questions or privacy reports, use the [Firelink Companion issue tracker](https://github.com/nimbold/Firelink-Extension/issues). The source code is available in the [Firelink-Extension repository](https://github.com/nimbold/Firelink-Extension).

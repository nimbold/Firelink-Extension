# Firelink Companion Privacy Policy

Effective date: 2026-08-28

Firelink Companion is a Microsoft Edge extension that connects Edge to the Firelink desktop download manager. This policy is intended for the Microsoft Edge Add-ons listing and describes the extension package at the time of publication.

## What the extension accesses

Depending on the feature you enable or use, Firelink Companion can access:

- Browser download details such as a URL, filename, referrer, state, and download identifier.
- The current page URL, page title, selected links, magnet links, and torrent links when you invoke a context-menu or popup action.
- During an explicit **Fetch media** action, candidate HTTP(S) manifest request
  URLs and selected request context from the active tab for a bounded period
  of up to eight seconds. The selected context is limited to `Accept`, `Accept-Language`,
  `Origin`, `User-Agent`, and a validated `Referer`.
- Browser cookies for an automatic ordinary download when the signed-in browser session is needed to preserve that download.
- A local pairing token, capture settings, language, theme, and pending handoff state in browser extension storage.

The extension uses packaged code only. It does not inject an in-page media overlay and does not use a remote script or remote code service.

The manifest includes the non-blocking `webRequest` permission so an explicit
Fetch media action can observe request metadata. The listener is inert outside
that action and does not alter, block, or replay browser requests.

## Why this information is used

This information is used only to send a download or media handoff that you requested, or an automatic browser download that you enabled, to the Firelink desktop application. Captured requests open Firelink's Add window so you can review them before starting or queuing a download.

Explicit **Fetch media** requests combine a content-script snapshot of visible
media resources with newly observed requests and send at most one HTTP(S)
manifest URL (`.m3u8`, `.mpd`, `.ism`, or `.ism/manifest`) to Firelink. If no
manifest is visible, they send the canonical page URL. They do not send a raw
browser `Cookie` header. Cookie, authorization, proxy, range, host,
hop-by-hop, and custom token headers are not forwarded. Firelink obtains media
authentication through its configured media cookie source.

Discovery is user-triggered, active-tab-only, bounded to eight seconds, and
does not reload the page or fetch manifest bodies or key files. Observations
are held in memory only for the active handoff and are not written to browser
storage. On browsers that do not expose request/document identity to
extensions, the extension does not use request-observed candidates and safely
falls back to the canonical page URL.

## Where information is sent

Handoff requests are sent only to the separately installed Firelink desktop application that the user pairs, through its signed local API on `127.0.0.1` in Firelink's documented local port range. The extension does not send download URLs, page data, cookies, pairing tokens, or analytics to a Firelink-operated remote server.

Firelink Companion does not contain advertising, cross-site tracking, an analytics SDK, or a data-broker integration. It does not sell personal information.

## Storage and control

The extension stores pairing and preference data in the browser's extension storage and may retain an in-progress handoff until the browser service worker can recover it safely. You can change capture and site settings in the popup, remove the pairing token, disable the extension, or uninstall it. Firelink may keep accepted downloads in its own local application data according to the desktop application's behavior.

## Security

Requests to Firelink are authenticated with the local pairing protocol and
signed with the pairing token. Newer paired builds also bind handoffs to the
current desktop-server session; older paired desktop builds use the
established HMAC compatibility path until upgraded. The extension does not
log or intentionally expose pairing tokens, cookies, authorization headers,
manifest bodies, or key files.

## Third parties and changes

No third-party remote service is required by the extension. Firelink Companion may be updated to support browser or desktop protocol changes. Material privacy changes will be reflected in this policy and the store listing.

## Contact

For questions or privacy reports, use the [Firelink Companion issue tracker](https://github.com/nimbold/Firelink-Extension/issues). The source code is available in the [Firelink-Extension repository](https://github.com/nimbold/Firelink-Extension).

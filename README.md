<div align="center">
  <img src="icons/icon-128.png" alt="Firelink Companion" width="128" height="128" />

  # Firelink Companion

  **The browser bridge for Firelink's desktop download manager.**

  [![Version](https://img.shields.io/badge/version-2.0.6-6f42c1?style=flat-square)](https://github.com/nimbold/Firelink-Extension/releases)
  [![Firefox](https://img.shields.io/badge/Firefox-140%2B-FF7139?style=flat-square&logo=firefox-browser&logoColor=white)](https://addons.mozilla.org/en-US/firefox/addon/firelink-companion/)
  [![Chromium](https://img.shields.io/badge/Chromium-Manual%20Install-4285F4?style=flat-square&logo=googlechrome&logoColor=white)](#manual-chromium-installation)
  [![Manifest V3](https://img.shields.io/badge/Manifest-V3-4285F4?style=flat-square)](manifest.json)
  [![License](https://img.shields.io/github/license/nimbold/Firelink-Extension?style=flat-square)](LICENSE)
</div>

## Overview

Firelink Companion sends browser downloads, selected links, and media pages to the native [Firelink](https://github.com/nimbold/Firelink) app. Captured links open in Firelink's Add window first, so you can review them before starting or queuing a download.

The extension signs local handoffs with Firelink's pairing token, checks the desktop app before trusting it, and keeps the original browser download unless Firelink confirms acceptance.

The current Companion release is **2.0.6**, paired with [Firelink 1.2.0](https://github.com/nimbold/Firelink/releases). Use the [latest Companion release](https://github.com/nimbold/Firelink-Extension/releases) with the latest desktop release.

## Install

| Browser | How to install |
| --- | --- |
| Firefox 140+ | [Install Firelink Companion from Firefox Add-ons](https://addons.mozilla.org/en-US/firefox/addon/firelink-companion/) |
| Chrome, Edge, Brave, Vivaldi, Opera, Chromium | Download `firelink-chromium.zip` from [GitHub Releases](https://github.com/nimbold/Firelink-Extension/releases), then follow [Manual Chromium Installation](#manual-chromium-installation). |

After installing:

1. Open Firelink.
2. Go to **Settings -> Integrations**.
3. Copy the pairing token.
4. Open the Firelink Companion popup.
5. Paste the token and save.

## Features

- Automatic capture for ordinary browser downloads.
- **Batch selected links** from page context menus, with an optional Firelink folder named from the page title.
- Media fetch from the popup or page context menu.
- Link and selected-text context menus.
- Firefox and Chromium Manifest V3 support.
- Signed HMAC-SHA256 requests to Firelink's local server.
- Desktop identity checks before trusting localhost responses.
- Safe fallback behavior that resumes the browser download when Firelink is closed or rejects a handoff.
- Reliable filenames and origin-scoped authentication through redirects, including Gmail downloads and Chrome Incognito.
- Recovery for interrupted or ambiguous automatic captures without silently creating duplicate downloads.
- Cookie handoff only for automatic single-download captures that need the browser session. Explicit media fetches send the page URL without a raw browser Cookie header.
- Dynamic local port discovery across `127.0.0.1:6412-6422`.

## Requirements

| Component | Requirement |
| --- | --- |
| Firelink desktop app | `1.2.0` or newer recommended |
| Firelink local protocol | v3 for automatic captures; v4 for explicit Fetch media intent |
| Firefox desktop | 140 or newer |
| Chromium browsers | Current desktop builds with Manifest V3 extension service workers |

## Manual Chromium Installation

Use this flow until Firelink Companion is published on the Chrome Web Store or another browser store.

1. Download `firelink-chromium.zip` from a Companion release.
2. Extract it and keep the folder somewhere stable.
3. Open your browser's extension manager:

| Browser | Extension manager |
| --- | --- |
| Chrome / Chromium | `chrome://extensions` |
| Edge | `edge://extensions` |
| Brave | `brave://extensions` |
| Vivaldi | `vivaldi://extensions` |
| Opera | `opera:extensions` |

4. Enable **Developer mode**.
5. Click **Load unpacked**.
6. Select the extracted folder containing `manifest.json`.
7. Pair the extension from Firelink **Settings -> Integrations**.

Manual Chromium installs do not auto-update. Extract the new ZIP and click **Reload** to update. Managed corporate or school browsers may disable Developer mode.

## Manual Firefox Installation

For local testing or add-on review:

1. Clone this repository.
2. Open Firefox at `about:debugging#/runtime/this-firefox`.
3. Select **Load Temporary Add-on...**.
4. Choose `manifest.json`.
5. Pair the extension from Firelink **Settings -> Integrations**.

Temporary Firefox add-ons are removed when Firefox restarts.

## Fetch Media

Use **Fetch media** when a page contains video or audio that Firelink should inspect. The extension sends the canonical page URL without a raw browser Cookie header; Firelink uses its configured media cookie source when authentication is needed. The request still opens Firelink's Add window before downloading.

## Development

```sh
npm test
npm run check
npm run build
```

`npm run build` writes load-unpacked packages to `dist/firefox/` and `dist/chromium/`. Releases contain `firelink.zip`, `firelink-firefox.zip`, and `firelink-chromium.zip`; `firelink.zip` is a compatibility alias for the Firefox package.

## Privacy and License

The extension handles URLs, referrers, selected link text, filenames, request headers, and cookies only to deliver the chosen browser download to the local Firelink app. It does not send this data to a remote service. Cookie forwarding is limited to automatic single-download captures that need the browser session.

Firelink Companion is available under the [MIT License](LICENSE).

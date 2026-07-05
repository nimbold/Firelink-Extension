<div align="center">
  <img src="icons/icon-128.png" alt="Firelink Companion" width="128" height="128" />

  # Firelink Companion

  **The browser bridge for Firelink's desktop download manager.**

  [![Version](https://img.shields.io/badge/version-2.0.1-6f42c1?style=flat-square)](https://github.com/nimbold/Firelink-Extension/releases)
  [![Firefox](https://img.shields.io/badge/Firefox-140%2B-FF7139?style=flat-square&logo=firefox-browser&logoColor=white)](https://addons.mozilla.org/en-US/firefox/addon/firelink-companion/)
  [![Chromium](https://img.shields.io/badge/Chromium-Manual%20Install-4285F4?style=flat-square&logo=googlechrome&logoColor=white)](#manual-chromium-installation)
  [![Manifest V3](https://img.shields.io/badge/Manifest-V3-4285F4?style=flat-square)](manifest.json)
  [![License](https://img.shields.io/github/license/nimbold/Firelink-Extension?style=flat-square)](LICENSE)
</div>

## What It Does

Firelink Companion sends browser downloads and selected links to the native [Firelink](https://github.com/nimbold/Firelink) desktop app. Every captured link opens in Firelink's Add window first, so you can review metadata, choose a location, and decide whether to start now or queue it.

The extension signs every localhost handoff with the pairing token from Firelink, verifies the desktop app before trusting it, and keeps the original browser download unless Firelink confirms it accepted the request.

## Install

| Browser | How to install |
| --- | --- |
| Firefox 140+ | [Install from Mozilla Add-ons](https://addons.mozilla.org/en-US/firefox/addon/firelink-companion/) |
| Chrome, Edge, Brave, Vivaldi, Opera, Chromium | Download `firelink-chromium.zip` from [GitHub Releases](https://github.com/nimbold/Firelink-Extension/releases), then follow [Manual Chromium Installation](#manual-chromium-installation). |

After installing:

1. Open Firelink.
2. Go to **Settings -> Integrations**.
3. Copy the pairing token.
4. Open the Firelink Companion popup in your browser.
5. Paste the token and save.

## Features

- Automatic download capture for ordinary browser downloads.
- Context-menu actions for single links and selected text containing links.
- Firefox and Chromium Manifest V3 support.
- Signed HMAC-SHA256 requests to Firelink's local server.
- Desktop identity checks before trusting localhost responses.
- Safe fallback behavior that resumes browser downloads when Firelink is closed or rejects a handoff.
- Cookie handoff only for automatic single-download captures that need the browser session.
- Dynamic local port discovery across `127.0.0.1:6412-6422`.

## Requirements

| Component | Requirement |
| --- | --- |
| Firelink desktop app | `1.0.0` or newer |
| Firelink local protocol | v3 for automatic captures |
| Firefox desktop | 140 or newer |
| Chromium browsers | Current desktop builds with Manifest V3 extension service workers |

## Manual Chromium Installation

Use this temporary flow until Firelink Companion is published on the Chrome Web Store or another browser store.

1. Download `firelink-chromium.zip` from a Firelink Companion release.
2. Extract the ZIP and keep the extracted folder somewhere stable.
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
6. Select the extracted folder that contains `manifest.json`.
7. Pair the extension from Firelink **Settings -> Integrations**.

Manual Chromium installs do not auto-update. To update, extract the new ZIP and click **Reload** on the extension page. Managed corporate or school browsers may disable Developer mode.

## Manual Firefox Installation

Use this only for local testing or add-on review work:

1. Clone this repository.
2. Open Firefox and go to `about:debugging#/runtime/this-firefox`.
3. Click **Load Temporary Add-on...**.
4. Select `manifest.json`.
5. Pair the temporary extension from Firelink **Settings -> Integrations**.

Temporary Firefox add-ons are removed when the browser restarts.

## Offline Launch Notes

When Firelink is closed and you explicitly choose **Download with Firelink**, your browser may ask before opening `firelink://launch`. Approve that prompt and enable the browser's "always allow" option if one is offered.

The browser owns this permission prompt; Firelink Companion cannot suppress it. If launch repeatedly times out, open Firelink once manually, confirm it is registered as the `firelink://` handler, and retry the browser action.

## Development

```sh
npm test
npm run check
npm run build
```

`npm run build` writes load-unpacked browser builds to:

```text
dist/firefox/
dist/chromium/
```

Releases include:

```text
firelink.zip
firelink-firefox.zip
firelink-chromium.zip
```

`firelink.zip` is a compatibility alias for the Firefox package. The Chromium package uses `chromium-service-worker.js` as its Manifest V3 service worker and loads the same protocol/background logic as Firefox.

## Privacy

Firelink Companion handles URLs, referrers, selected link text, filenames, request headers, and cookies only to deliver the chosen browser download to the local Firelink app. It does not send that data to a remote service.

Cookie forwarding is intentionally narrow and limited to automatic single-download captures where the desktop app needs the browser session to fetch the same file.

## License

Firelink Companion is available under the [MIT License](LICENSE).

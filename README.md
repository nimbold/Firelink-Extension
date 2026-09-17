<p align="center">
  <img src="icons/icon-128.png" alt="Firelink Companion app icon" width="128" height="128" />
</p>

# Firelink Companion

> Browser integration for the Firelink desktop download manager.

[![Latest release](https://img.shields.io/github/v/release/nimbold/Firelink-Extension?style=flat-square)](https://github.com/nimbold/Firelink-Extension/releases/latest)
[![Firefox](https://img.shields.io/badge/Firefox-140%2B-FF7139?style=flat-square&logo=firefox-browser&logoColor=white)](#installation)
[![Chromium](https://img.shields.io/badge/Chromium-Manual%20install-4285F4?style=flat-square&logo=googlechrome&logoColor=white)](#manual-chromium-installation)
[![Manifest V3](https://img.shields.io/badge/Manifest-V3-4285F4?style=flat-square)](manifest.json)
[![License](https://img.shields.io/github/license/nimbold/Firelink-Extension?style=flat-square)](LICENSE)

## What it does

Firelink Companion sends browser downloads, selected links, media pages, magnet links, and torrent metadata to the native [Firelink](https://github.com/nimbold/Firelink) app.

Captured links open Firelink's Add window first. You can review them before starting or queuing a download.

## Status

The Companion package is **2.2.2**. It is compatible with [Firelink `1.4.2`](https://github.com/nimbold/Firelink/releases/tag/v1.4.2).

Version 2.2.2 includes the browser-local Torrent handoff fixes and the shared Chromium package now published through [Microsoft Edge Add-ons](https://microsoftedge.microsoft.com/addons/detail/firelink-companion/kflenjkpdoamjkalhfcllhflgahledbc). The submission material is kept in [`store/edge/listing.md`](store/edge/listing.md).

The project is actively maintained. Use the [latest Companion release](https://github.com/nimbold/Firelink-Extension/releases/latest) with the [latest Firelink release](https://github.com/nimbold/Firelink/releases/latest).

Remote Torrent and magnet handoff uses protocol version 5. Browser-local
Torrent attachments use the binary handoff contract and require a Firelink
build that supports it.

## Installation

<p>
  <a href="https://microsoftedge.microsoft.com/addons/detail/firelink-companion/kflenjkpdoamjkalhfcllhflgahledbc"><img src="https://img.shields.io/badge/Install%20from-Microsoft%20Edge%20Add--ons-0078D7?style=for-the-badge&logo=microsoftedge&logoColor=white" alt="Install from Microsoft Edge Add-ons" height="24" /></a>&nbsp;&nbsp;
  <a href="https://addons.mozilla.org/en-US/firefox/addon/firelink-companion/"><img src="https://img.shields.io/badge/Install%20from-Firefox%20Add--ons-FF7139?style=for-the-badge&logo=firefox-browser&logoColor=white" alt="Install from Firefox Add-ons" height="24" /></a>&nbsp;&nbsp;
  <a href="https://github.com/nimbold/Firelink-Extension#manual-chromium-installation"><img src="https://img.shields.io/badge/Manual%20install-Chromium-4285F4?style=for-the-badge&logo=googlechrome&logoColor=white" alt="Manual install for Chromium browsers" height="24" /></a>
</p>

- **Microsoft Edge:** Install Firelink Companion from [Microsoft Edge Add-ons](https://microsoftedge.microsoft.com/addons/detail/firelink-companion/kflenjkpdoamjkalhfcllhflgahledbc).
- **Other Chromium browsers:** Download `firelink-chromium.zip` from [the latest release](https://github.com/nimbold/Firelink-Extension/releases/latest).
  Follow the [manual installation guide](#manual-chromium-installation).

After installation:

1. Open Firelink.
2. Go to **Settings -> Integrations**.
3. Copy the pairing token.
4. Open the Firelink Companion popup.
5. Paste the token and save.

## Features

- Automatic capture for ordinary browser downloads.
- Magnet links through the existing link and selection context menus.
- Automatic `.torrent` handoff to Firelink's Add window, including authenticated browser sessions, opaque download URLs, and browser-local attachments.
- Paused Torrent captures that wait for Firelink confirmation before the browser download continues.
- Batch selected links from page context menus.
- Optional Firelink folders named from page titles.
- Explicit **Fetch media** actions from the popup and context menu. During the
  action, Companion briefly observes requests from the active tab to find one
  HLS, DASH, or Smooth Streaming manifest when the page exposes one.
- Localized popup UI in Firelink's six supported languages, including RTL layout for Hebrew and Persian.
- Localized browser context menus that follow the selected language.
- System, light, dark, Dracula, and Nord popup themes.
- Firefox and Chromium Manifest V3 support.
- Signed local requests with HMAC-SHA256.
- Desktop identity checks before trusting localhost responses.
- Safe fallback when Firelink is closed or rejects a handoff.
- Recovery for interrupted or ambiguous captures without silent duplicates.
- Recovery for interrupted and paused Firefox captures across service-worker restarts.
- Safer popup state and automatic-capture handling when settings change during a handoff.
- Dynamic local port discovery across `127.0.0.1:6412-6422`.

The extension deliberately keeps media fetching in the popup and context menu instead of injecting an in-page player button. A user-triggered Fetch
media action takes a bounded, eight-second snapshot of the active tab's media
resource URLs and newly observed HTTP(S) requests. It selects at most one
`.m3u8`, `.mpd`, `.ism`, or `.ism/manifest` URL, then falls back to the page
URL when no manifest is visible. It does not reload the page, fetch manifest
bodies or key files, or observe requests continuously. Browser sites
frequently change their DOM and player behavior, and media can be exposed
through site-specific, single-page, MSE, or blob-based paths that require
ongoing maintenance.

On browsers that do not expose a request/document identity to extensions,
manifest discovery is deliberately disabled for that session and the action
falls back to the canonical page URL. Direct manifest URLs still work through
the desktop Add window.

## Handoff and privacy

- Ordinary captures may use browser cookies when the browser session requires them.
- Explicit media requests send one discovered manifest when available, or the
  canonical page URL otherwise. They never send a raw browser `Cookie` header.
- Discovery may include only `Accept`, `Accept-Language`, `Origin`, and
  `User-Agent`, plus a validated `Referer` field. Credentials, custom token
  headers, cookies, ranges, host headers, and hop-by-hop headers are removed.
- Firelink handles media authentication through its configured media cookie source.
- The bundled yt-dlp path can handle clear or non-DRM encrypted HLS such as
  AES-128 when the manifest and key are legitimately accessible. DRM/CDM,
  license-server, and other key workflows are unsupported; Firelink does not
  bypass them.
- The original browser download is kept unless Firelink confirms the handoff.
- Torrent downloads remain paused until Firelink confirms receipt; ambiguous handoffs stay paused to avoid duplicate delivery.
- Requests stay on the local machine. The extension does not send download data to a remote service.

Newer Companion and Firelink builds additionally bind signed handoffs to the
current desktop-server session. Older paired desktop builds continue through
the established HMAC compatibility path until both sides are upgraded.

### Browser permissions

The extension requests access to all web pages because automatic capture runs
at document start and browser cookies may be needed for authenticated ordinary
downloads. It also uses the browser downloads, context-menu, storage, alarm,
script-injection, notification, cookie, and non-blocking `webRequest` APIs
listed in `manifest.json`. The webRequest listener records nothing unless you
invoke Fetch media, and then only for the active tab for at most eight seconds.
Those permissions support the features above; the extension sends handoff data
only to the paired Firelink app on localhost.

### Media capability boundary

Firelink's existing bundled yt-dlp, FFmpeg, and Deno engines remain the only
media backend. Clear media and non-DRM encrypted HLS (for example, AES-128)
may work when yt-dlp can legitimately access the manifest and key. DRM/CDM,
license-server, and other protected-key workflows are intentionally unsupported
and are not bypassed. This phase does not add subtitle or multiple-audio-track
selection UI.

For the Edge store listing, see the [privacy policy](PRIVACY.md) and the [submission kit](store/edge/listing.md).

## Manual Chromium installation

Chrome and other Chromium browsers use the load-unpacked package described below. Microsoft Edge users should install the extension from the [Edge Add-ons listing](https://microsoftedge.microsoft.com/addons/detail/firelink-companion/kflenjkpdoamjkalhfcllhflgahledbc) instead.

1. Download `firelink-chromium.zip` from the [latest release](https://github.com/nimbold/Firelink-Extension/releases/latest).
2. Extract the ZIP to a stable folder.
3. Open your browser's extension manager:

   | Browser | Extension manager |
   | --- | --- |
   | Chrome / Chromium | `chrome://extensions` |
   | Edge | `edge://extensions` |
   | Brave | `brave://extensions` |
   | Vivaldi | `vivaldi://extensions` |
   | Opera | `opera:extensions` |

4. Enable **Developer mode**.
5. Select **Load unpacked**.
6. Choose the extracted folder containing `manifest.json`.
7. Pair the extension from Firelink **Settings -> Integrations**.

Manual Chromium installs do not auto-update. Extract the new ZIP and click **Reload** after an update. Managed browsers may disable Developer mode.

## Temporary Firefox installation

Use this flow for local testing or add-on review:

1. Clone this repository.
2. Open `about:debugging#/runtime/this-firefox` in Firefox.
3. Select **Load Temporary Add-on...** and choose `manifest.json`.
4. Pair the extension from Firelink **Settings -> Integrations**.

Temporary Firefox add-ons are removed when Firefox restarts.

## Development

```sh
npm test
npm run check
npm run build
```

The build writes load-unpacked packages to `dist/firefox/` and `dist/chromium/`.

Release packages are `firelink-firefox.zip` and `firelink-chromium.zip`. `firelink.zip` remains a Firefox-package compatibility alias.

## Credits

The extension uses standard [WebExtensions APIs](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions).
It integrates with [Firelink](https://github.com/nimbold/Firelink).

Thanks to users who report browser compatibility issues, test releases, and review the integration.

## License

Firelink Companion is available under the [MIT License](LICENSE).

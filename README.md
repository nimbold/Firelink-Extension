<div align="center">
  <img src="icons/icon-128.png" alt="Firelink Companion" width="128" height="128" />

  # Firelink Companion

  **The browser bridge for Firelink's desktop download manager.**

  [![Version](https://img.shields.io/badge/version-2.0.0-6f42c1?style=flat-square)](https://github.com/nimbold/Firelink-Extension/releases)
  [![Firefox](https://img.shields.io/badge/Firefox-140%2B-FF7139?style=flat-square&logo=firefox-browser&logoColor=white)](https://addons.mozilla.org/en-US/firefox/addon/firelink-companion/)
  [![Chromium](https://img.shields.io/badge/Chromium-Manual%20Install-4285F4?style=flat-square&logo=googlechrome&logoColor=white)](#manual-chromium-installation)
  [![Manifest V3](https://img.shields.io/badge/Manifest-V3-4285F4?style=flat-square)](manifest.json)
  [![License](https://img.shields.io/github/license/nimbold/Firelink-Extension?style=flat-square)](LICENSE)

  <a href="https://addons.mozilla.org/en-US/firefox/addon/firelink-companion/"><img src="https://img.shields.io/badge/Install%20on%20Firefox-FF7139?logo=firefox-browser&logoColor=white&style=for-the-badge" alt="Install Firelink Companion on Firefox" /></a>
</div>

## What It Does

Firelink Companion sends browser downloads and selected links to the native [Firelink](https://github.com/nimbold/Firelink) desktop app. It is designed for Firelink 1.0.0 and newer, where every captured link opens in the desktop Add window first so the user can review metadata, choose a location, and decide whether to start immediately or queue it.

The extension focuses on a narrow job: capture the right browser event, authenticate the local handoff, and protect the browser download unless Firelink confirms it accepted the request.

## Highlights

- **Automatic download capture** for ordinary browser downloads.
- **Context-menu actions** for single links and selected text containing links.
- **Firefox and Chromium Manifest V3 support** with no remote code or remote fonts.
- **Signed localhost requests** using HMAC-SHA256 and the pairing token from Firelink.
- **Desktop identity checks** so the extension only trusts the real Firelink local server.
- **Protocol compatibility checks** that reject older desktop builds before automatic captures can cancel browser downloads.
- **Offline-safe fallback** that resumes browser downloads when Firelink is closed, unavailable, or rejects the request.
- **Container-aware cookie handoff** for automatic single-download captures only.
- **Dynamic local port discovery** across `127.0.0.1:6412-6422`.

## Compatibility

| Component | Requirement |
| --- | --- |
| Firelink desktop app | `1.0.0` or newer |
| Firelink local protocol | v3 for automatic captures |
| Firefox desktop | 140 or newer |
| Chromium browsers | Current desktop builds of Chrome, Edge, Brave, Vivaldi, Opera, and other Chromium browsers that support Manifest V3 extension service workers |

> [!IMPORTANT]
> Version 2.0.0 is a breaking extension release. Automatic capture requires the Firelink 1.0 local protocol. Update the desktop app and the extension together.

## Installation

Install the published add-on from Mozilla:

<div align="center">
  <a href="https://addons.mozilla.org/en-US/firefox/addon/firelink-companion/"><img src="https://img.shields.io/badge/Install%20Firelink%20Companion-Firefox-FF7139?logo=firefox-browser&logoColor=white&style=for-the-badge" alt="Install Firelink Companion on Firefox" /></a>
</div>

Then pair it with Firelink:

1. Open Firelink.
2. Go to **Settings -> Integrations**.
3. Copy the pairing token.
4. Open the Firelink Companion popup in Firefox.
5. Paste the token and save.

## Manual Firefox Installation

Use this flow for local testing or add-on review work:

1. Clone this repository.
2. Open Firefox and go to `about:debugging#/runtime/this-firefox`.
3. Click **Load Temporary Add-on...**.
4. Select `manifest.json`.
5. Pair the temporary extension from Firelink **Settings -> Integrations**.

Temporary Firefox add-ons are removed when the browser restarts.

## Manual Chromium Installation

Use this temporary flow until Firelink Companion is published on the Chrome Web Store or another browser store.

1. Download `firelink-chromium.zip` from a Firelink Companion release.
2. Extract the ZIP and keep the extracted folder somewhere stable.
3. Open the browser extension manager:

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
7. Open Firelink, go to **Settings -> Integrations**, copy the pairing token, then paste it into the Firelink Companion popup.

Manual Chromium installs have important limits:

- Browser stores do not auto-update this build. To update, extract the new ZIP over a new folder and click **Reload** on the extension page.
- The extracted folder must stay in place. Moving or deleting it breaks the installed extension.
- Some managed corporate or school browsers disable Developer mode.
- Browsers may show a developer-mode warning for unpacked extensions.
- Store installation should replace this flow once Firelink Companion is accepted by the Chrome Web Store or the relevant browser store.

## Offline Launch Notes

When Firelink is closed and you explicitly choose **Download with Firelink**, your browser may show an external-protocol confirmation before opening `firelink://launch`. Approve it and enable the browser's "always allow" option if one is offered.

The browser owns this permission prompt; Firelink Companion cannot suppress or bypass it. If launch repeatedly times out, open Firelink once manually, confirm it is registered as the `firelink://` handler, and retry the browser action.

## Development

Run syntax checks and tests:

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

Release ZIPs are generated by `.github/workflows/release.yml` from those folders. The Firefox package keeps `background.scripts`; the Chromium package uses `chromium-service-worker.js` as its Manifest V3 service worker and loads the same protocol/background logic. Releases include `firelink-firefox.zip`, `firelink-chromium.zip`, and a compatibility `firelink.zip` alias for the Firefox package.

Shared package contents include:

```text
background.js
content.js
icons/
manifest.json
popup/
protocol.js
```

## Privacy

Firelink Companion handles URLs, referrers, selected link text, filenames, request headers, and cookies only to deliver the chosen browser download to the local Firelink app. It does not send that data to a remote service. Cookie forwarding is intentionally narrow and is limited to automatic single-download captures where the desktop app needs the browser session to fetch the same file.

## License

Firelink Companion is available under the [MIT License](LICENSE).

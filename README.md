<div align="center">
  <img src="icons/icon-128.png" alt="Firelink Companion Icon" width="128" height="128" />
  <h1>Firelink Companion</h1>
</div>

This repository contains the standalone development files and releases for the **Firelink Companion** browser extension.

---

## ⚡ Overview

Firelink Companion bridges the gap between your web browser and the native **[Firelink](https://github.com/nimbold/Firelink)** macOS download manager.

It intelligently intercepts browser downloads, captures media URLs, and forwards them directly to the native app, allowing you to bypass your browser's default manager and harness the full power of Firelink's multi-segmented `aria2` and `yt-dlp` engines.

---

## 🌟 Current Status (v1.0.13)

The extension has been updated to **v1.0.13** with robust performance and security enhancements:
- **HMAC-SHA256 Authentication**: All requests to the native Firelink app are now cryptographically signed using the Web Crypto API to ensure maximum security against replay and CSRF attacks.
- **Fixed Local Endpoint**: The rewritten desktop app and extension communicate through `127.0.0.1:23522`.
- **Context-Aware Behavior**: Intelligently differentiates between automatic background captures and manual context-menu actions to respect your UI preferences in the native app.
- **Firefox MV3 Optimized**: 100% compliant with strict Manifest V3 Content Security Policies and optimized Event Page architectures.
- **Zero Race Conditions**: Secure async state handling guarantees your capture settings are strictly respected even upon background wakeup.
- **Duplicate Prevention**: Intelligently pauses browser downloads while pinging Firelink to guarantee no duplicate files are saved.
- **Connection Check**: The popup verifies the local app through `/ping` with the new signature model, showing clear connection states.

---

## 🚀 Installation

We are officially live on the Mozilla Add-on store!

<div align="center">
  <a href="https://addons.mozilla.org/en-US/firefox/addon/firelink-companion/"><img src="https://img.shields.io/badge/Install%20on%20Firefox-FF7139?logo=firefox-browser&logoColor=white&style=for-the-badge" alt="Install on Firefox" /></a>
</div>

### Manual/Developer Installation
If you wish to test unreleased features or modify the extension yourself:
1. Download the latest source code or clone the repository.
2. Open Firefox and navigate to `about:debugging#/runtime/this-firefox`.
3. Click on **Load Temporary Add-on...**
4. Select the `manifest.json` file from the directory.
5. Open Firelink Settings → Integration, copy the pairing token, then paste it into the extension popup.

*Note: Temporary installations reset when you restart your browser. Support for Chrome/Safari is planned for the future.*

---

## 📄 License
Released under the MIT License.

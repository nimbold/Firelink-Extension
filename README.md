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

*Note: Temporary installations reset when you restart your browser. Support for Chrome/Safari is planned for the future.*

---

## 📄 License
Released under the MIT License.

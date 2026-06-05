<div align="center">
  <img src="icons/icon-128.png" alt="Firelink Companion Icon" width="128" height="128" />
  <h1>Firelink Companion</h1>
</div>

This repository contains the standalone development files and releases for the Firelink Companion Firefox extension.

## Overview
Firelink Companion is a companion to the Firelink macOS download manager. It intercepts downloads from the browser and captures download links from selected text, forwarding them directly to the native macOS app.

## Installation
Firelink Companion has been submitted to Mozilla and is awaiting review. Until it is approved, install it as a temporary add-on:
1. Download the latest `.zip` release from the [Releases](https://github.com/nimbold/Firelink-Extension/releases) page.
2. Extract the downloaded `.zip` file into a folder on your computer.
3. Open Firefox and navigate to `about:debugging#/runtime/this-firefox` (or simply go to `about:debugging` and click **This Firefox** on the left).
4. Click on **Load Temporary Add-on...**
5. Select the `manifest.json` file from the folder you extracted in step 2.

*Note: Because this is a temporary installation, you will need to repeat this process if you restart your browser.*

*Note: This repository currently tracks the Firefox extension. Support for other browsers is planned for the future.*

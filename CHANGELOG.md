# Changelog

All notable changes to Firelink Companion will be documented in this file.

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

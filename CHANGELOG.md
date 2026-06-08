# Changelog

All notable changes to Firelink Companion will be documented in this file.

## [1.0.8] - 2026-06-08

### New Features
- No new user-facing features in this patch release.

### Improvements
- Keep manual "Download with Firelink" actions resilient by preserving the custom protocol fallback when the local Firelink API is unavailable.

### Changes
- Use the changelog entry for GitHub release page descriptions so published release notes match the source tree.

### Fixes
- Prevent global download capture from canceling or erasing the browser download unless the native Firelink app confirms the local API handoff.

# Release v1.0.7

This update introduces significant reliability improvements, a redesigned UI, and optimized communication with the native Firelink app.

## 🚀 New Features & Changes
- **Redesigned Icons**: Updated extension branding with modern gradient icons and improved multi-resolution scaling.
- **UI & Code Audit**: General UI improvements and extension robustness upgrades.
- **Multiple URLs Fallback**: Enhanced the local API server connection logic to handle multiple fallback URLs gracefully.
- **Default Capture**: "Capture Downloads" is now enabled by default for a smoother onboarding experience.
- **Naming Alignment**: Aligned terminology to properly brand the extension as "Firelink Companion".

## 🐛 Bug Fixes
- **Optimized Latency**: Reduced communication latency with the native app and silenced native UI interruptions.
- **Seamless Custom Protocol**: Implemented a hidden iframe approach for the custom URL scheme to completely eliminate blank tabs when capturing links.
- **API Unreachable Fallback**: Fallback to the custom URL scheme automatically when the local API server is unreachable.
- **Port Probing**: Probed and integrated Firelink fallback ports for added resilience.

## 📝 Documentation
- Added Firefox installation badges and updated the README with live extension store links.
- Added extensive backward compatibility comments in the code to safeguard against future native app updates.

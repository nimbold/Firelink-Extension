### Integration
- Use the rewritten Firelink desktop app's fixed `127.0.0.1:23522` endpoint.
- Share signed-request and timeout handling between the popup and background worker.

### Reliability
- Wait for persisted extension settings before capturing downloads.
- Resume paused browser downloads whenever Firelink does not confirm acceptance.

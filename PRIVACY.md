# Privacy notes

Penguin Desktop Pet is designed as a local-first desktop application. It does not intentionally send telemetry to a project-owned analytics service in the current preview.

## Data stored locally

Depending on the features you enable, the application may store settings, account labels, encrypted provider credentials, QR-login state, event logs, and conversation history in the operating system's application-data directory. The exact location is platform-specific and is not part of the source repository.

You can disable chat-history persistence in settings. Deleting the application-data directory removes local settings and history, but may also remove credentials and require you to sign in again.

## Data sent to other services

When you enable a messaging channel or Agent provider, the application sends the data required for that configured integration to the corresponding service. This can include message text, media, account identifiers, prompts, and Agent results. Those services have their own terms, retention, and privacy policies.

The project does not control third-party provider handling. Review the provider documentation before enabling a channel, and do not connect accounts that you are not authorized to operate.

## Diagnostics

Logs and any future diagnostic export should be treated as potentially sensitive. Share only a deliberately redacted export. Never share token files, `.env` files, databases, screenshots containing messages, or full application-data directories.

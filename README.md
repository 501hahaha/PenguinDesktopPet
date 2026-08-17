# Penguin Desktop Pet

Penguin Desktop Pet is an Electron + TypeScript desktop companion with optional local Agent and messaging-channel integrations.

## Current capabilities

- Transparent, frameless, always-on-top desktop pet with sprite/video animation states.
- Settings window with themes, Agent configuration, and local preferences.
- Optional Claude Code, Codex app-server, Hermes, and custom-command Agent adapters.
- Optional WeChat iLink Bot, QQ Bot, and Feishu Bot channels.
- Per-channel status, QR login flows, local conversation history, and encrypted credential storage where supported by the host platform.

The project is still an active preview. Some channels and Agent integrations require external accounts, local CLI installations, or provider-side configuration and are not enabled by default.

## Development

```powershell
npm install
npm run dev
```

Quality checks and a production renderer/main build:

```powershell
npm run typecheck
npm run build
```

Start the built application with:

```powershell
npm start
```

## Local packaging

The current release preparation targets Windows x64:

```powershell
npm run package:dir   # unpacked application directory
npm run package:win   # NSIS installer and portable executable
npm run release:checksums
```

Artifacts are written to `release/`, which is intentionally ignored by Git. The checksum command writes `release/SHA256SUMS.txt` after artifacts exist.

## Privacy and credentials

- Settings, conversation history, event logs, imported sessions, and credentials are runtime data stored in the operating system's application-data area, not in this repository.
- Platform credentials are handled in the Electron main process. Renderer code receives redacted status and user-facing labels rather than complete secrets.
- The application does not intentionally send telemetry to a project-owned analytics service. When you configure a messaging platform or Agent provider, messages and credentials are sent to that provider according to your configuration and its policies.
- Do not commit `.env`, token files, databases, logs, screenshots, backups, or copied application-data directories. Use `.env.example` only as a variable-name reference.
- Before a public release, run `npm run release:check` and inspect the complete diff.

## Open-source status

The source code is released under the MIT License. See [the open-source readiness plan](docs/plans/OPEN_SOURCE_READINESS_PLAN.md) for the privacy boundary, reproducible packaging, GitHub Release, mirror, and approval plan. The other product and architecture plans are indexed in [docs/plans](docs/plans/README.md).

Security reports should use a private GitHub Security Advisory after the public repository is created; do not put credentials or sensitive reproduction data in public issues. The initial Windows preview is unsigned and is distributed through the eventual GitHub Releases page; no separate download domain is assumed. Local preparation commands do not create a GitHub repository, Release, mirror, or website.

## Artwork and media

The repository includes supplied penguin artwork and animation media. MIT applies to the project code only; redistribution rights and attribution for these assets must be confirmed before the first public release. See `assets/penguin/README.md` for the current asset note.

## Contributing and security

Read [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), [PRIVACY.md](PRIVACY.md), and [RELEASE.md](RELEASE.md) before sharing changes or preparing a release.

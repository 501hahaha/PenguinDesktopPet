# Contributing

Thank you for helping improve Penguin Desktop Pet. The source code is licensed under MIT. Contributions will be accepted through the public GitHub repository after its owner and URL are configured.

## Before making a change

1. Read `docs/plans/OPEN_SOURCE_READINESS_PLAN.md` and the relevant project skill reference.
2. Keep secrets, account data, chat history, logs, screenshots, backups, and absolute personal paths out of the repository.
3. Keep platform SDKs, credentials, network lifecycle, persistence, and routing in `src/main`; keep Renderer changes focused on presentation and narrow IPC.

## Local checks

```powershell
npm install
npm run typecheck
npm run build
npm run release:check
git diff --check
```

Do not commit `release/` or local runtime data. If a test needs credentials, configure them locally through the application or an ignored `.env` file based on `.env.example`.

## Pull requests

- Explain the user-visible behavior and the affected process boundary.
- Include focused tests or manual verification steps.
- Do not include real account IDs, provider credentials, message content, or private machine paths in screenshots and logs.
- Do not add automatic public publishing, mirror synchronization, or website deployment without an explicit maintainer decision.

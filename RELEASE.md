# Release preparation

This document describes local release preparation. The source code uses the MIT License, but bundled artwork and animation media remain subject to separate redistribution approval. This document does not authorize public publication.

## Local build

```powershell
npm ci
npm run typecheck
npm run build
npm run release:check
npm run package:win
npm run release:checksums
```

The Windows x64 build produces an NSIS installer and a portable executable in `release/`. The exact artifacts must be inspected before distribution. The initial preview is unsigned; signing and automatic updates are future work and must not be implied by an unsigned preview package.

## Release integrity

The release directory is the single artifact source. Upload the exact same files and `SHA256SUMS.txt` to GitHub Releases and any official mirror. A mirror must not rebuild, rename, patch, or replace an artifact. If a mirror differs from the checksum manifest, remove it from the official download page until it is corrected.

## GitHub Actions

The checked-in quality workflow validates install, typecheck, build, and public-release hygiene. It does not create repositories, push tags, publish Releases, deploy a website, or synchronize a mirror.

## Approval gate

Before any public write, the owner must confirm all of the following:

- GitHub owner/organization and repository name;
- MIT source license and GitHub Security Advisory reporting path;
- artwork and media redistribution rights;
- version/tag and release notes;
- signing identity, if signing is enabled;
- official website/mirror domains and storage destinations. The default download destination is GitHub Releases, with no separate domain.

Only after explicit approval may an operator add a Git remote, push source or tags, create a Draft Release, publish a Release, deploy a site, or synchronize a mirror. The final approval request must list the exact destination and files that will become public.

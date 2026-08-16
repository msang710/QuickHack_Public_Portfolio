# QuickHack package and release contract

QuickHack publishes four logical products. Each logical product has a Windows x64 installer and a CachyOS/Arch x86_64 package, for eight platform variants in total.

| logical artifact | Windows result | Arch result | mutable state |
|---|---|---|---|
| demonstration server | `QuickHack-Demo-Server-Setup-<version>.exe` | `quickhack-demonstration-server-<version>-1-x86_64.pkg.tar.zst` | artifact-specific ProgramData or `/etc`/`/var/lib`/`/var/cache` roots |
| demonstration client | `QuickHack-Demo-Client-Setup-<version>.exe` | `quickhack-demonstration-client-<version>-1-x86_64.pkg.tar.zst` | artifact-specific LocalAppData or XDG roots; local port 3001 |
| operational server | `QuickHack-Operational-Server-Setup-<version>.exe` | `quickhack-operational-server-<version>-1-x86_64.pkg.tar.zst` | artifact-specific ProgramData or `/etc`/`/var/lib`/`/var/cache` roots |
| operational client | `QuickHack-Operational-Client-Setup-<version>.exe` | `quickhack-operational-client-<version>-1-x86_64.pkg.tar.zst` | artifact-specific LocalAppData or XDG roots; local port 3002 |

Every result is accompanied by its immutable `quickhack-package.json` metadata and SHA-256 checksum file. Portable ZIP files are debug staging inputs only and are not official release artifacts.

## Build commands

Build the standalone Next output once, then choose an explicit platform and target:

```powershell
npm run build
npm run stage:windows:demo-server -- "--postgresql-runtime-dir=C:\Program Files\PostgreSQL\18"
npm run release:windows:demo-server -- -Version 1.0.0
```

On CachyOS/Arch, the release command stages all four package roots because the checked-in `PKGBUILD` is a split package:

```bash
npm run build
npm run release:linux:operational-server -- --version=1.0.0
```

The old `stage:demo-server`, `stage:demo-client`, `release:demo-server`, and `release:demo-client` names remain Windows compatibility aliases.

## Installation and lifecycle

- Demonstration and operational clients may coexist. They reject a central server with the wrong role, runtime contract, flavor, or artifact identity before local application traffic starts.
- Demonstration and operational servers may not coexist on one host. Windows registry/SCM and Linux package/unit preflight reject the opposite server before data, credentials, or databases are changed.
- Arch packages depend on system Node.js 24, and server packages depend on system PostgreSQL 18. They do not bundle or modify Arch's default PostgreSQL cluster or account.
- Installing an Arch server package creates package files, service users/directories, and reloads systemd only. The artifact-specific `quickhack-<flavor>-server-setup` command then requests administrator authentication and performs finite setup. The non-root console service remains the long-lived parent of the backend, gateway, and demonstration simulators.
- Upgrade, repair, ordinary Windows uninstall, and `pacman -R` preserve config, database, encrypted credentials, and backups. Only the separate artifact-specific purge action removes mutable state after exact artifact and backup/no-recovery confirmation.

## Verification cadence

PR stages are work-splitting and review units, not execution blockers. Each stage runs only focused checks for its changed scope. The manual `Final integration gate` workflow runs the secret scan, dependency audit, lint, complete PostgreSQL verification, Windows package matrix, Arch package matrix, and Android test/build once after all planned stages are complete.

Actual clean install, upgrade, repair, uninstall/purge, SCM, pacman, systemd, ADB, printer, QHKEY, and cross-host pairing remain separate physical acceptance work. The public automated workflow neither requests those results nor treats unavailable hardware as a passing result. A successful public workflow therefore certifies the automated source/build/package checks only.

Every Windows and Arch distribution directory contains exactly the binary package, its immutable package manifest, and a SHA-256 checksum file covering both. The integration workflow verifies the expected file set, manifest schema, version, platform, target, artifact kind, and file digests before uploading the directory. Its final aggregation job runs even after an upstream failure and fails unless every automated job succeeded.

Official tag workflows do not rebuild packages or rerun the full CI graph. They locate a successful `Final integration gate` run for the exact tag SHA, download that run's exact target package artifact, and repeat the manifest/version/target/checksum verification before publishing. A tag or manual release run without a successful same-revision integration artifact fails closed. Debug or independently rebuilt artifacts are never substituted for the verified package set.

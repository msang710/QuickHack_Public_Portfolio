# QuickHack package and release contract

QuickHack publishes four logical products. Each logical product has a Windows x64 MSIX and a CachyOS/Arch x86_64 package, for eight platform variants in total.

| logical artifact | Windows result | Arch result | mutable state |
|---|---|---|---|
| demonstration server | `QuickHack-Demo-Server-<version>.msix` | `quickhack-demonstration-server-<version>-1-x86_64.pkg.tar.zst` | artifact-specific ProgramData or `/etc`/`/var/lib`/`/var/cache` roots |
| demonstration client | `QuickHack-Demo-Client-<version>.msix` | `quickhack-demonstration-client-<version>-1-x86_64.pkg.tar.zst` | artifact-specific LocalAppData or XDG roots; local port 3001 |
| operational server | `QuickHack-Operational-Server-<version>.msix` | `quickhack-operational-server-<version>-1-x86_64.pkg.tar.zst` | artifact-specific ProgramData or `/etc`/`/var/lib`/`/var/cache` roots |
| operational client | `QuickHack-Operational-Client-<version>.msix` | `quickhack-operational-client-<version>-1-x86_64.pkg.tar.zst` | artifact-specific LocalAppData or XDG roots; local port 3002 |

Every result is accompanied by its immutable `quickhack-package.json` metadata and SHA-256 checksum file. Portable ZIP files are debug staging inputs only and are not official release artifacts.

## Build commands

Build the standalone Next output once, stage all four Windows targets from shared inputs, then build one unsigned exact set for integration:

```powershell
npm run build
./packaging/stage-windows-four-artifacts.ps1 -PostgresqlRuntimeDir C:\qh\runtimes\postgresql-18 -PlatformToolsDir C:\Android\platform-tools -RequirePlatformTools
npm run release:msix:four -- -Version 1.0.0 -Publisher "CN=Verified Publisher, O=Verified Organization" -SigningMode Unsigned
```

On CachyOS/Arch, the release command stages all four package roots because the checked-in `PKGBUILD` is a split package:

```bash
npm run build
npm run release:linux:operational-server -- --version=1.0.0
```

The Inno Setup source and old Windows commands remain rollback-only compatibility material. CI and public Windows release workflows do not invoke them and no `.exe` is an official Windows asset.

### Exact-four Windows MSIX candidate

The integration workflow creates the four packages once, unsigned but with the exact reviewed production Publisher. The protected candidate workflow downloads that same artifact and applies Azure Artifact Signing with OIDC, or an isolated self-hosted operator can use the approved CA certificate-store adapter. Neither path accepts a private-key file or secret password argument.

```powershell
./packaging/windows/msix/sign-msix.ps1 -Provider AzureArtifactSigning -Version 1.0.0 -Publisher "CN=Verified Publisher, O=Verified Organization"
```

The exact output contains these four packages and one manifest/checksum pair for each package:

- `QuickHack-Demo-Server-<version>.msix`
- `QuickHack-Demo-Client-<version>.msix`
- `QuickHack-Operational-Server-<version>.msix`
- `QuickHack-Operational-Client-<version>.msix`

Both server MSIX builds require packaged services and the elevated Server Setup application. Both client builds forbid those declarations and PostgreSQL content. Production finalization re-verifies the unpacked package, public-trust signature, exact certificate subject, timestamp, source/content inventory, pinned Node/PostgreSQL metadata, generated visual assets, and compiled launcher PE icon before replacing unsigned sidecars with schema-v2 production sidecars.

## Installation and lifecycle

- Demonstration and operational clients may coexist. They reject a central server with the wrong role, runtime contract, flavor, or artifact identity before local application traffic starts.
- Demonstration and operational READY server runtimes may not coexist on one host. Inno registry/SCM and Linux package/unit preflight reject the opposite server before data, credentials, or databases are changed. Distinct MSIX identities may both be registered as immutable packages because MSIX provides no mutual-exclusion manifest declaration; each packaged server launcher and Setup therefore observes the opposite service/package and fails before DB, ACL, credential, service, or firewall mutation. Remove the inert opposite package before continuing Setup.
- Arch packages depend on system Node.js 24, and server packages depend on system PostgreSQL 18. They do not bundle or modify Arch's default PostgreSQL cluster or account.
- Installing an Arch server package creates package files, service users/directories, and reloads systemd only. The artifact-specific `quickhack-<flavor>-server-setup` command then requests administrator authentication and performs finite setup. The non-root console service remains the long-lived parent of the backend, gateway, and demonstration simulators.
- Upgrade, repair, ordinary Windows uninstall, and `pacman -R` preserve config, database, encrypted credentials, and backups. Only the separate artifact-specific purge action removes mutable state after exact artifact and backup/no-recovery confirmation.

## Verification cadence

PR stages are work-splitting and review units, not execution blockers. Each stage runs only focused checks for its changed scope. The manual `Final integration gate` workflow runs the secret scan, dependency audit, lint, complete PostgreSQL verification, one exact-four unsigned Windows MSIX build, the Arch package matrix, and Android test/build once after all planned stages are complete.

Actual clean install, upgrade, repair, uninstall/purge, SCM, pacman, systemd, ADB, printer, QHKEY, and cross-host pairing remain separate physical acceptance work. The public automated workflow neither requests those results nor treats unavailable hardware as a passing result. A successful public workflow therefore certifies the automated source/build/package checks only.

Every Windows target directory contains exactly one MSIX, one sidecar, and one checksum; every Arch directory contains the corresponding package triplet. The Windows production release additionally publishes a release manifest, its checksum, and one sanitized native evidence document for each supported workstation family, for exactly 16 public assets. `.exe`, `.appinstaller`, extra files, development Publishers, missing timestamps, stale hashes, and mixed source revisions fail before publication.

The candidate workflow does not rebuild packages or rerun the full CI graph. It resolves a successful `Final integration gate` run for the request's exact source revision, signs that run's unsigned exact-four artifact, finalizes provenance, and uploads a private 30-day candidate artifact. The public release gate then requires exact-hash Windows 10 build 19041+ and Windows 11 workstation evidence covering install, provisioning, interruption recovery, update/reboot, migration, repair, conflict, dual clients, uninstall/purge, shell icon, and residue 0.

Release requests live under `release-requests/windows-msix/` and are checked against their complete Git addition history, so deleting a release or request does not permit its version/tag to be reused. Candidate generation never publishes. Public `windows-v<version>` tag/release creation requires a separate manual dispatch with `publish=true` and a protected production-release environment. Actual printers, Coupang/Logen accounts, approved external operations, and long-running real operations are `NOT_APPLICABLE(reason=EXTERNAL_OPERATION_ENVIRONMENT_UNAVAILABLE)` for this project and do not masquerade as automated PASS results.

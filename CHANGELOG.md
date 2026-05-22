# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.2.3] - 2026-05-22

### Fixed

- Fixed `install.mjs` writing `enableServerPlugins` into the wrong config file for Docker-style SillyTavern layouts that mount `./config` into the container.
- The installer now prefers `config/config.yaml` when present, and only falls back to root `config.yaml` for non-nested layouts.
- Updated installer, uninstaller, and docs wording to refer to the active SillyTavern config file instead of always assuming root `config.yaml`.

## [0.2.2] - 2026-05-19

### Fixed

- Fixed Cloud Vault cross-device restore so old user messages now remap persona avatar references to the target device's actual local avatar filename, instead of restoring with broken user avatar images.
- Covered both persona avatar URL styles during restore remapping: `/thumbnail?type=persona&file=...` and legacy `User Avatars/...`.

## [0.2.1] - 2026-04-14

### Fixed

- Added a CSRF self-heal retry path for Chat Vault API calls and restore/write requests so one stale token mismatch is retried automatically after fetching a fresh `/csrf-token`.

## [0.2.0] - 2026-04-08

### Added

- Optional Git Cloud Vault flow for publishing selected backups into a separate Git repository.
- Cloud resource bundle support for character cards, personas, lorebooks, and group definitions.
- Cloud-side prepare-restore flow that imports missing resources before restoring a remote snapshot as a new chat.
- Explicit per-backup cloud deletion, including cleanup of resources no longer referenced by any cloud backup.
- Cloud panel feedback for sync/connect/import/restore/delete actions, including busy states and resource/device badges on remote backup cards.
- Local and cloud backup search, collapsible panel sections, and per-module inner scrolling for long lists on desktop and mobile.

### Changed

- Cloud retention now behaves like an append-only vault by default instead of deriving remote deletions from the current local publish set.
- Remote manifest rebuilding now scans cloud snapshot metadata directly instead of treating device state files as the source of truth.
- Import-vs-restore wording and UI copy now explain where resources go and when a real SillyTavern chat file is created.
- Resource import now uses global hash dedupe for character cards, persona avatars, and lorebooks, rather than relying only on target filenames.
- Restore-as-new now writes the target chat file directly instead of relying on the current in-memory chat state.

## [0.1.0] - 2026-04-05

First public repository preparation.

### Added

- Front-end extension plus server plugin architecture for Chat Vault.
- Commit-level chat backup flow with rolling auto backups and manual backups.
- Unsaved edit mirroring and restore flow backed by server-side draft storage.
- Global disaster recovery view backed by `scopes-index.json`, independent from the currently opened chat.
- Chat rename continuity through scope alias and rebind handling.
- Floating panel UI, mobile layout, theme switching, and bilingual i18n.
- Cross-platform `install.mjs` and `uninstall.mjs` scripts.
- Installer and uninstaller now support automatic SillyTavern discovery from common and sibling directories, with interactive selection when multiple candidates are found.
- Repository docs for README, architecture, data model, manual testing, troubleshooting, and license.

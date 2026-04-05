# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project follows [Semantic Versioning](https://semver.org/).

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

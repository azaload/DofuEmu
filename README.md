<p align="center">
  <img src="resources/icon.png" width="120" alt="DofEmu">
</p>

<h1 align="center">DofEmu</h1>

[![platforms](https://img.shields.io/badge/platforms-windows%20%7C%20macOS%20%7C%20linux-blue)](https://github.com/angine67/DofuEmu/releases)
[![node](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org)

Unofficial desktop client for Dofus Touch.

![screenshot](resources/screenshot.png)

## Features

- Multi-account with up to 5 tabs
- Team management with leader/follower roles
- Auto-group — followers auto-follow across maps
- Auto-invite — automatic party invitations
- Automation scripts — movement paths, resource circuits and custom JS per tab ([docs](docs/scripting.md))
- Combat AI — casts a configured spell combo each turn, then passes, or lets a local Ollama model plan the turn ([docs](docs/combat.md))
- Map-circuit hunting — chains fights over a chosen list of maps ([docs](docs/scripting.md))
- Drag-to-reorder tabs
- Character icon capture in tabs
- Configurable hotkeys
- Audio mute / sound-on-focus
- Proxy support (HTTP, HTTPS, SOCKS5)
- Auto-download and patch game files on startup
- Persistent settings via electron-store

## Download

Grab the latest release from the [Releases](https://github.com/angine67/DofuEmu/releases) page.

| Platform | Format |
|----------|--------|
| macOS | `.dmg` |
| Windows | `.exe` (NSIS installer) |
| Linux | `.AppImage` |

## Development

```bash
pnpm install
pnpm run dev
```

## Build

```bash
pnpm run build
pnpm run dist
```

`dist` clears `release/` first. On Windows that folder is often held by
something else — DofEmu still running, OneDrive syncing a project kept on the
Desktop, or an antivirus scanning the generated uninstaller — which shows up as
`EPERM: operation not permitted, unlink ...__uninstaller-nsis-dofemu.exe`. The
clean step retries and then names the likely cause; keeping the project outside
synced folders (`C:\dev\DofuEmu`) avoids it entirely.

## Combat AI

**Settings → Combat** plays fight turns on its own: a fixed spell combo cast on a chosen
target, then the turn is passed. See [docs/combat.md](docs/combat.md).

## Automation scripts

Write JavaScript that drives a tab — walk a path, harvest a circuit, relay the leader's
map changes — from **Settings → Scripts**. See [docs/scripting.md](docs/scripting.md) for
the API reference. Run the engine tests with:

```bash
pnpm run test:scripts
```

## Release Updates

Packaged builds check GitHub Releases for app updates before updating game files. Publish release artifacts with:

```bash
GH_TOKEN=... pnpm run release
```

The release must include the Electron Builder update metadata (`latest.yml`, `latest-mac.yml`, blockmaps) alongside the platform installers. macOS auto-update also requires signed builds.

## Stack

| Layer | Tech |
|-------|------|
| Shell | Electron |
| UI | React 19, TypeScript |
| Build | Vite |
| State | Zustand |
| Server | Hono |
| Storage | electron-store |

## Project Structure

```
packages/
  main/           Electron main process
    windows/      BrowserWindow management
    updater/      Game downloader + patcher
    game-base/    Game shell, CSS fixes, regex patches
    scripts/      Injected helper scripts
  renderer/       React frontend
    screens/      GameScreen, SetupScreen, SettingsScreen, ScriptsScreen, CombatScreen
    stores/       Zustand stores (tabs, teams, settings, scripts)
    mods/         Game mods (auto-group, party invite, combat AI)
    scripts/      Automation engine (game API, runner, templates)
    components/   Shared components
    utils/        Utilities
  preload/        Electron preload bridge
  shared/         Shared types and constants
```

## License

GPL-3.0

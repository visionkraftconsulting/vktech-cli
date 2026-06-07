# Changelog

All notable changes to vktech are documented here.
This project adheres to [Semantic Versioning](https://semver.org/).

## [1.0.0]

Initial public release.

### Added
- Multi-provider analysis CLI: `ask`, `audit`, `code`, `providers`, `run`/`sh`/`remote`.
- `audit --all` fan-out across every configured provider into one consolidated report.
- Industry auto-detection (`audit auto`, `detect`, `industries`) that picks templates +
  compliance frameworks.
- Programmatic library API via `import { ask, askAll, … } from "vktech"` (`main: src/index.js`).
- Portable `.env` discovery: `$VKTECH_ENV`, `./.env`, `~/.config/vktech/.env`, `~/.vktech.env`.
- Modern REPL: violet/coral themes, live framed input box, Braille spinner, elapsed/token
  footer, multi-line bracketed paste with large-paste collapse, command history, Ctrl-C
  cancel (clears line / aborts in-flight request / exits on empty).

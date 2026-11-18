# Change Log

All notable changes to the "kubescape" extension will be documented in this file.

## [0.4.0]

Major architectural update: Integrated Kubescape's built-in Language Server Protocol (LSP).

- **Built-in Language Server Protocol (`kubescape lsp`)**: Replaced legacy external CLI process invocations and ad-hoc background downloads with the standard VS Code Language Client (`vscode-languageclient/node`).
- **Save-Triggered Security Scanning**: Kubescape automatically scans Kubernetes YAML and JSON manifests on save and publishes security diagnostics directly into the VS Code Problems panel.
- **Enhanced Configuration & Lifecycle**:
  - Added `kubescape.executablePath` for user-configured binary locations.
  - Added `kubescape.trace.server` for debugging LSP communications.
  - Deprecated legacy `kubescape.dirPath` and `kubescape.scanOnSave` (save-triggered scanning is built into the language server).
  - Serialized language client lifecycle queue (`start`, `stop`, `restart`) to eliminate concurrency race conditions.
  - Added dynamic workspace folder change listener to automatically resynchronize roots on workspace changes.
  - Added quoted Windows PATH normalization.
  - Removed mandatory `vscode.yaml` dependency in favor of optional recommendation.
  - Pruned obsolete Activity Bar webview panel and dead legacy code in favor of native VS Code Problems panel diagnostics.
- **New Commands**:
  - `Kubescape: Restart Language Server`
  - `Kubescape: Show Language Server Output`
  - `Kubescape: Scan YAML`
- **Robust Process & Discovery Management**: Platform-aware discovery (Windows/macOS/Linux), path validation, permission verification, and graceful crash recovery.

## [0.3.3]

- Updated @kubescape/install version (v0.4.2) - fixes a bug where control structure has changed in regolibrary, causing a failure in scan report parsing. 

## [0.3.0]
Major changes

- Updated to latest @kubescape/install
- Using newer Kubescape version and report format (v2)

## [0.1.1]
Minor fixes

- Documentation update
- Mac fix

## [0.1.0]
Major changes!

- Remove file diagnostics on close
- Initialize extension once, cache results
- No problem duplication
- Allow kubescape binary override
- Override framework dir and allow custom frameworks
- Download framework, offline scanning
- Introduce version tiers
- Fix: Don't run scanning when there is no real file in the system.

## [0.0.10]
- Redownload logic fixes

## [0.0.9]
- Bug fix

## [0.0.8]
- Add kubescape version validation
  Kubescape version is now being checked
  The version tier could be 'stable' or 'latest' (configurable)
  Doctor will report installed version as well

- Using the extension path as default location for kubescape unless specified otherwise.

- Add option to list supported frameworks

- Show progress when downloading kubescape and enable cancel operation

## [0.0.7]
- Address CVE-2021-23566 in nanoid

## [0.0.6]
- Support newer json from kubescape
- Make sure to wait for kubescape to be downloaded.

## [0.0.5]
- Minor readme and workflow changes
- Support path expansion

## [0.0.4]
- Fix for windows machines

## [0.0.3]
- Scan when new YAML files are being opened.
- Use warnings instead of errors.
  Sometimes errors on yaml files can cause build problems for projects. It is better to use warnings instead.
- Kubescape logo update
- Ensure kubescape location when exists in path.
    + Always set the location of kubescape - even if comes from system path.
    + Always show scan progress (notification / window)
- Create output channel for kubescape

## [0.0.2]
- Support multiple scanning frameworks
  The framework to use for scanning can now be set in the extension configuration.

## [0.0.1]

- Initial version
- Scanning YAML files using NSA framework

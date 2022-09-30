# Change Log

All notable changes to the "kubescape" extension will be documented in this file.

## [0.1.1]
Minor fixes!

- Documentation update.
- Mac fix.

## [0.1.0]
Major changes!

- Remove file diagnostics on close.
- Initialize extension once, cache results.
- No problem duplication.
- Allow kubescape binary override.
- Override framework dir and allow custom frameworks.
- Download framework, offline scanning.
- Introduce version tiers.
- fix: Don't run scanning when there is no real file in the system.

## [0.0.10]
- Redownload logic fixes.

## [0.0.9]
- Bug fix.

## [0.0.8]
- Add kubescape version validation Kubescape version are now being checked The version tier could be 'stable' or 'latest' (configurable) Doctor will report installed version as well.

- Using the extension path as default location for kubescape unless specified otherwise.

- Add option to list supported frameworks.

- Show progress when downloading kubescape and enable cancel operation.

## [0.0.7]
- Address CVE-2021-23566 in nanoid.

## [0.0.6]
- Support newer json from kubescape.
- Make sure to wait for kubescape to be downloaded.

## [0.0.5]
- Minor readme and workflow changes.
- Support path expansion.

## [0.0.4]
- Fix for windows machines.

## [0.0.3]
- Scan when new yaml files are being open.
- Use warnings instead of errors. Sometimes errors on yaml files can cause build problems for projects. It is better to use warnings instead.
- Kubescape logo update.
- Ensure kubescape location when exists in path.
    + Always set the location of kubescape - even if comes from system path.
    + Always show scan progress (notification / window).
- Create output channel for kubescape.

## [0.0.2]
- Support multiple scanning frameworks.
  The framework to use for scanning can now be set in the extension configuration.

## [0.0.1]

- Initial version.
- Scaning yaml files using nsa framework.

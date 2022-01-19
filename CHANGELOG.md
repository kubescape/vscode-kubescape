# Change Log

All notable changes to the "kubescape" extension will be documented in this file.

## [0.0.5]
- Minor readme and workflow changes
- Support path expansion

## [0.0.4]
- Fix for windows machines

## [0.0.3]
- Scan when new yaml files are being open.
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
- Scaning yaml files using nsa framework
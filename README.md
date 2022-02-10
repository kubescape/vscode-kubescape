# Kubescape

Visual studio extension the utilize the power 💪 of [Kubescape](https://github.com/armosec/kubescape) directly into your
favorite text editor.

## ✨ Features

### Scan yaml files and get analysis from Kubescape.

Yaml files can be scanned using a commands.
You can access any of this extension commands by opening the Command Palette (Ctrl+Shift+P on Linux/Windows and Cmd+Shift+P on Mac), and then typing in the command name.

The default behavior also scans yaml files on save 💾.

Scanning results are marked and can be found in `vscode` 'PROBLEMS' tab. There is also a hover info that can be viewed on marked positions.

![yaml-demo](./images/yaml-demo.gif)

## 🔒 Requirements

This extension downloads the latest Kubescape version.
However, it is recommended to have Kubescape installed in your path.

## ⚙️ Configuration

Currently the following options can be configured:

### Set custom directory for kubescape

By default, this extension uses it's own kubescape binary in order to provide
a stable experience as it can.

If, however, you desire to use a different or maybe a custom kubescape executable
you can use the option `Dir Path` which a custom directory on your system.

### Scan triggers

As for now, kubescape scan can take a while, so it might be unwise to run scans
without a good reason (like a dirty file). 
I chose to do a background scan only when a new file is saved on the disk.

To choose between available files to scan on save use the option `Scan On Save`.

Default : scan on save for all supported files.

### Frameworks

Frameworks are collections of controls.
There are some builtin controls that kubescape can use by default and can be
downloaded locally for an offline scan.
Kubescape extension for vscode is using this method to increase it's scanning
speed.

#### Choosing required frameworks

One can choose which frameworks are necessary by adding their names into the
`Required Frameworks` configuration. This list only ensure that the frameworks
in it will be downloaded - it's not marking them for scaning usage.

Default : Empty. Meaning all available framework will be downloaded.

#### Overriding framework directory

The used frameworks are getting downloaded to kubescape directory by default.
One can simply copy / download to this directory any desired framework.
Alternatively, you can use `Custom Frameworks Dir` configuration to choose a
different directory for frameworks.

Default: Not set. Use kubescape binary directory.

#### Specify frameworks for scanning

To specify which framework to use for scanning you can list them in the
`Scan Frameworks` configuration.

Those frameworks will be used at the moment of a scan. If not exists - they will
be downloaded automatically.

Default: Not set. Use frameworks from the framework directory.

### Kubescape Version

By default, I use a version of kubescape which is teseted more against integration
with this extension.

If, however, one wishes to use the latest and greatest it can be configured via
the `Version Tier` option by setting it to 'latest'

![kubescape-config](./images/kubescape-config.png)

## 💼 Marketplace

This extension is available officially at either:

- [Microsoft VScode Extensions Marketplace](https://marketplace.visualstudio.com/items?itemName=kubescape.kubescape)
- [Open VSX Registry](https://open-vsx.org/extension/kubescape/kubescape)
- [Kubescape Github Releases](https://github.com/armosec/kubescape/releases)

## 🗒️ Release Notes

See [Change Log](./CHANGELOG.md)

# Kubescape VS Code Extension

The official [Visual Studio Code extension](https://marketplace.visualstudio.com/items?itemName=kubescape.kubescape) brings [Kubescape](https://github.com/kubescape/kubescape) security scanning directly to your editor using Kubescape's built-in **Language Server Protocol (LSP)**.

As you write and save Kubernetes manifests, Kubescape analyzes them locally and surfaces misconfigurations and compliance violations directly in VS Code's **Problems** panel.

## ✨ Features

- **Built-in Language Server Protocol Integration**: Communicates directly with `kubescape lsp` using standard LSP over standard input/output.
- **Save-Triggered Local Scanning**: Automatically scans Kubernetes manifests when saved, catching misconfigurations without modifying remote clusters or sending source code out of your machine.
- **Native VS Code Diagnostics**: Security findings appear in the Problems panel with full control codes (e.g., `C-0017`), clear descriptions, severity levels, and precise source file ranges.
- **Multiple Manifest Formats**: Supports Kubernetes YAML (`.yaml`, `.yml`) and JSON (`.json`) manifests, including multi-document YAML files.
- **Workspace-Aware Discovery**: Discovers `kubescape` on your system `PATH` or uses a user-configured binary location.

## 🔒 Requirements

This extension requires the **Kubescape CLI** (v3.0.0 or higher with `kubescape lsp` support) installed on your system.

### Installing Kubescape

Follow the official instructions to install Kubescape:

- **macOS / Linux (Homebrew)**:
  ```bash
  brew install kubescape
  ```
- **Windows (Scoop / Winget)**:
  ```bash
  winget install kubescape
  ```
- **Shell script**:
  ```bash
  curl -s https://raw.githubusercontent.com/kubescape/kubescape/master/install.sh | /bin/bash
  ```

If Kubescape is not on your system `PATH`, you can configure its exact location using the `kubescape.executablePath` setting.

## ⚙️ Configuration

The extension can be configured via VS Code Settings (`Cmd+,` on macOS, `Ctrl+,` on Windows/Linux):

| Setting | Type | Default | Description |
|---|---|---|---|
| `kubescape.executablePath` | `string \| null` | `null` | Absolute path or workspace-relative path to the `kubescape` executable. When `null`, the extension discovers `kubescape` on your system `PATH`. |
| `kubescape.trace.server` | `string` | `"off"` | Traces communication between VS Code and the Kubescape Language Server (`"off"`, `"messages"`, or `"verbose"`). Logs appear in the "Kubescape Language Server" Output channel. |
| `kubescape.dirPath` | `string \| null` | `null` | *(Deprecated)* Legacy directory path for the Kubescape binary. Prefer `kubescape.executablePath`. |
| `kubescape.scanOnSave` | `string` | `"all"` | *(Deprecated)* Automatic save scanning is built into the Language Server; this legacy setting has no effect on the language server. |

### Optional Recommended Extensions

- **[YAML by Red Hat](https://marketplace.visualstudio.com/items?itemName=redhat.vscode-yaml)** (`redhat.vscode-yaml`): Provides Kubernetes schema validation and autocompletion alongside Kubescape's security diagnostics.

## 🕹️ Commands

Access these commands from the VS Code Command Palette (`Cmd+Shift+P` / `Ctrl+Shift+P`):

- **`Kubescape: Restart Language Server`**: Restarts the active `kubescape lsp` process and re-synchronizes the workspace.
- **`Kubescape: Show Language Server Output`**: Opens the dedicated Output channel displaying server logs and LSP traffic.
- **`Kubescape: Scan YAML`**: Saves the active manifest and triggers a scan.

## 📖 Supported Manifests

Kubescape LSP inspects Kubernetes manifests containing valid `apiVersion` and `kind` declarations:
- Single-document YAML manifests
- Multi-document YAML manifests separated by `---`
- JSON Kubernetes manifests
- Nested manifests in subdirectories within the workspace

Text files that are unsaved or non-Kubernetes YAML files are ignored by the scanner to keep scanning fast and avoid false positives.

## 💼 Marketplace

The Kubescape extension is available at:
- [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=kubescape.kubescape)
- [Open VSX Registry](https://open-vsx.org/extension/kubescape/kubescape)
- [Kubescape GitHub Releases](https://github.com/kubescape/kubescape/releases)

## 🗒️ License & Contributing

Licensed under Apache 2.0. Contributions are welcome on GitHub at [kubescape/vscode-kubescape](https://github.com/kubescape/vscode-kubescape).

import * as vscode from 'vscode';
import { findKubescapeExecutable, DiscoveryError } from './server/discovery';
import { configuredExecutablePath } from './server/configuredPath';
import { KubescapeLanguageClientManager } from './server/client';
import { ServerLifecycleCoordinator } from './server/coordinator';

let clientManager: KubescapeLanguageClientManager | null = null;
let coordinator: ServerLifecycleCoordinator | null = null;
let outputChannel: vscode.OutputChannel | null = null;

/**
 * Resolves the configured or discovered Kubescape executable path.
 */
export async function getResolvedExecutable(): Promise<string> {
    const config = vscode.workspace.getConfiguration('kubescape');
    const configuredPath = configuredExecutablePath(config.get<string>('executablePath'), config.get<string>('dirPath'));
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

    return await findKubescapeExecutable({
        configuredPath,
        workspaceRoot: workspaceFolder,
    });
}

/**
 * Returns the current ServerLifecycleCoordinator (useful for tests and inspection).
 */
export function getLifecycleCoordinator(): ServerLifecycleCoordinator | null {
    return coordinator;
}

/**
 * Activates the Kubescape VS Code extension.
 */
export async function activate(context: vscode.ExtensionContext): Promise<KubescapeLanguageClientManager> {
    outputChannel = vscode.window.createOutputChannel('Kubescape');
    context.subscriptions.push(outputChannel);

    outputChannel.appendLine('[Extension] Activating Kubescape extension...');

    clientManager = new KubescapeLanguageClientManager(outputChannel);
    context.subscriptions.push(clientManager);

    coordinator = new ServerLifecycleCoordinator(clientManager, outputChannel, getResolvedExecutable);
    context.subscriptions.push(coordinator);

    // Register user commands
    context.subscriptions.push(
        vscode.commands.registerCommand('kubescape.restartServer', async () => {
            outputChannel?.appendLine('[Command] Manual restart requested.');
            try {
                await coordinator?.triggerRestart('manual');
                vscode.window.showInformationMessage('Kubescape Language Server restarted.');
            } catch (err: any) {
                const msg = err?.message || String(err);
                outputChannel?.appendLine(`[Error] Restart failed: ${msg}`);
                vscode.window.showErrorMessage(`Failed to restart Kubescape Language Server: ${msg}`);
            }
        }),
        vscode.commands.registerCommand('kubescape.showOutput', () => {
            outputChannel?.show();
        }),
        vscode.commands.registerCommand('kubescape.scanYaml', async () => {
            const activeEditor = vscode.window.activeTextEditor;
            if (activeEditor) {
                outputChannel?.appendLine(`[Command] Saving active document to trigger scan: ${activeEditor.document.fileName}`);
                await activeEditor.document.save();
            } else {
                vscode.window.showInformationMessage('No active document to scan. Open a Kubernetes YAML manifest and save it.');
            }
        })
    );

    // Watch for dynamic workspace folder changes
    context.subscriptions.push(
        vscode.workspace.onDidChangeWorkspaceFolders(async (event) => {
            if (event.added.length === 0 && event.removed.length === 0) {
                return;
            }
            outputChannel?.appendLine(
                `[Workspace] Workspace folders changed (+${event.added.length}, -${event.removed.length}). Restarting language server...`
            );
            try {
                await coordinator?.triggerRestart('workspace');
            } catch (err: any) {
                const msg = err?.message || String(err);
                outputChannel?.appendLine(`[Workspace Error] Failed to restart server on workspace folder change: ${msg}`);
                if (err instanceof DiscoveryError) {
                    vscode.window.showWarningMessage(`Kubescape LSP: ${err.message}`);
                }
            }
        })
    );

    // Watch for configuration changes
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(async (event) => {
            if (
                event.affectsConfiguration('kubescape.executablePath') ||
                event.affectsConfiguration('kubescape.dirPath')
            ) {
                outputChannel?.appendLine('[Config] Executable path configuration changed.');
                try {
                    await coordinator?.triggerRestart('config');
                } catch (err: any) {
                    outputChannel?.appendLine(`[Config Error] Failed to restart server: ${err?.message || err}`);
                    if (err instanceof DiscoveryError) {
                        vscode.window.showWarningMessage(`Kubescape LSP: ${err.message}`);
                    }
                }
            }
        })
    );

    // Start language server via lifecycle coordinator
    try {
        await coordinator.triggerRestart('startup');
    } catch (err: any) {
        outputChannel.appendLine(`[Startup Error] ${err?.message || err}`);
        if (err instanceof DiscoveryError) {
            vscode.window
                .showWarningMessage(`Kubescape LSP: ${err.message}`, 'Open Settings')
                .then((choice) => {
                    if (choice === 'Open Settings') {
                        vscode.commands.executeCommand('workbench.action.openSettings', 'kubescape.executablePath');
                    }
                });
        }
    }

    outputChannel.appendLine('[Extension] Kubescape extension activated.');
    return clientManager;
}

/**
 * Deactivates the Kubescape VS Code extension.
 */
export async function deactivate(): Promise<void> {
    if (coordinator) {
        coordinator.dispose();
        coordinator = null;
    }
    if (clientManager) {
        outputChannel?.appendLine('[Extension] Deactivating Kubescape extension...');
        await clientManager.stop();
        clientManager = null;
    }
}

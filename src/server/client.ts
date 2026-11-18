import * as vscode from 'vscode';
import {
    LanguageClient,
    LanguageClientOptions,
    ServerOptions,
    TransportKind,
    State
} from 'vscode-languageclient/node';
import { LifecycleQueue } from './queue';

export type LanguageClientFactory = (
    id: string,
    name: string,
    serverOptions: ServerOptions,
    clientOptions: LanguageClientOptions
) => LanguageClient;

/**
 * Manages the lifecycle of the Kubescape LSP language client with
 * strictly serialized start, stop, and restart operations.
 */
export class KubescapeLanguageClientManager implements vscode.Disposable {
    private client: LanguageClient | null = null;
    private outputChannel: vscode.OutputChannel;
    private currentExecutablePath: string | null = null;
    private queue: LifecycleQueue = new LifecycleQueue();
    private clientFactory: LanguageClientFactory;

    constructor(outputChannel: vscode.OutputChannel, clientFactory?: LanguageClientFactory) {
        this.outputChannel = outputChannel;
        this.clientFactory = clientFactory ?? ((id, name, sOpts, cOpts) => new LanguageClient(id, name, sOpts, cOpts));
    }

    public getClient(): LanguageClient | null {
        return this.client;
    }

    public isRunning(): boolean {
        return this.client !== null && this.client.state === State.Running;
    }

    public getCurrentExecutablePath(): string | null {
        return this.currentExecutablePath;
    }

    /**
     * Public serialized start operation.
     */
    public async start(executablePath: string): Promise<void> {
        return this.queue.enqueue(() => this.internalStart(executablePath));
    }

    /**
     * Public serialized stop operation.
     */
    public async stop(): Promise<void> {
        return this.queue.enqueue(() => this.internalStop());
    }

    /**
     * Public serialized restart operation.
     */
    public async restart(executablePath: string): Promise<void> {
        return this.queue.enqueue(() => this.internalRestart(executablePath));
    }

    private async internalRestart(executablePath: string): Promise<void> {
        this.outputChannel.appendLine('[LSP] Restarting Kubescape Language Server...');
        await this.internalStop();
        await this.internalStart(executablePath);
    }

    private async internalStart(executablePath: string): Promise<void> {
        if (this.isRunning() && this.currentExecutablePath === executablePath) {
            this.outputChannel.appendLine('[LSP] Language client is already running with target executable.');
            return;
        }

        if (this.client) {
            await this.internalStop();
        }

        this.outputChannel.appendLine(`[LSP] Launching Kubescape Language Server: ${executablePath} lsp`);

        try {
            const serverOptions: ServerOptions = {
                command: executablePath,
                args: ['lsp'],
                transport: TransportKind.stdio,
                options: {
                    env: { ...process.env },
                },
            };

            const clientOptions: LanguageClientOptions = {
                documentSelector: [
                    { scheme: 'file', language: 'yaml' },
                    { scheme: 'file', language: 'json' },
                ],
                synchronize: {
                    configurationSection: 'kubescape',
                },
                outputChannel: this.outputChannel,
                traceOutputChannel: this.outputChannel,
                errorHandler: {
                    error: (error, message, count) => {
                        this.outputChannel.appendLine(`[LSP Error] ${error.message} (count: ${count})`);
                        return { action: 2 /* Close / Shutdown */ };
                    },
                    closed: () => {
                        this.outputChannel.appendLine('[LSP] Connection closed.');
                        return { action: 1 /* DoNotRestart */ };
                    },
                },
            };

            const client = this.clientFactory(
                'kubescape',
                'Kubescape Language Server',
                serverOptions,
                clientOptions
            );

            this.client = client;
            this.currentExecutablePath = executablePath;

            await client.start();
            this.outputChannel.appendLine('[LSP] Kubescape Language Server successfully started.');
        } catch (err: any) {
            this.outputChannel.appendLine(`[LSP] Failed to start language server: ${err?.message || err}`);
            this.client = null;
            this.currentExecutablePath = null;
            throw err;
        }
    }

    private async internalStop(): Promise<void> {
        if (!this.client) {
            this.currentExecutablePath = null;
            return;
        }

        const clientToStop = this.client;
        this.client = null;
        this.currentExecutablePath = null;

        try {
            if (clientToStop.state === State.Running || clientToStop.state === State.Starting) {
                this.outputChannel.appendLine('[LSP] Stopping Kubescape Language Server...');
                await clientToStop.stop();
                this.outputChannel.appendLine('[LSP] Kubescape Language Server stopped.');
            } else {
                await clientToStop.dispose();
            }
        } catch (err: any) {
            this.outputChannel.appendLine(`[LSP] Error stopping language server: ${err?.message || err}`);
        }
    }

    public dispose(): void {
        this.queue.dispose();
        void this.internalStop();
    }
}

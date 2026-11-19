import * as cp from 'child_process';
import * as vscode from 'vscode';
import {
    LanguageClient,
    LanguageClientOptions,
    ServerOptions,
    State
} from 'vscode-languageclient/node';
import { LifecycleQueue, RestartResult, createServerOptions } from './queue';
import { waitForProcessExit, terminateProcess, isProcessAlive } from './process';

export { waitForProcessExit, terminateProcess, isProcessAlive, RestartResult, createServerOptions };

export type LanguageClientFactory = (
    id: string,
    name: string,
    serverOptions: ServerOptions,
    clientOptions: LanguageClientOptions
) => LanguageClient;

export interface ClientManagerOptions {
    clientFactory?: LanguageClientFactory;
    initTimeoutMs?: number;
    stopTimeoutMs?: number;
}

function getChildProcess(client: any): cp.ChildProcess | null {
    if (!client) {
        return null;
    }
    return client._serverProcess ?? client.process ?? null;
}

/**
 * Manages the lifecycle of the Kubescape LSP language client with
 * strictly serialized start, stop, and restart operations, bounded initialization,
 * process confirmation on shutdown, and disposal safety.
 */
export class KubescapeLanguageClientManager implements vscode.Disposable {
    private client: LanguageClient | null = null;
    private currentProcess: cp.ChildProcess | null = null;
    private outputChannel: vscode.OutputChannel;
    private currentExecutablePath: string | null = null;
    private queue: LifecycleQueue = new LifecycleQueue();
    private clientFactory: LanguageClientFactory;
    private initTimeoutMs: number;
    private stopTimeoutMs: number;
    private isDisposed: boolean = false;
    private shutdownPromise: Promise<void> | null = null;

    constructor(
        outputChannel: vscode.OutputChannel,
        optionsOrFactory?: LanguageClientFactory | ClientManagerOptions
    ) {
        this.outputChannel = outputChannel;

        if (typeof optionsOrFactory === 'function') {
            this.clientFactory = optionsOrFactory;
            this.initTimeoutMs = 15000;
            this.stopTimeoutMs = 3000;
        } else {
            this.clientFactory =
                optionsOrFactory?.clientFactory ??
                ((id, name, sOpts, cOpts) => new LanguageClient(id, name, sOpts, cOpts));
            this.initTimeoutMs = optionsOrFactory?.initTimeoutMs ?? 15000;
            this.stopTimeoutMs = optionsOrFactory?.stopTimeoutMs ?? 3000;
        }
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

    public getCurrentProcess(): cp.ChildProcess | null {
        return this.currentProcess;
    }

    public getIsDisposed(): boolean {
        return this.isDisposed;
    }

    /**
     * Public serialized start operation.
     */
    public async start(executablePath: string): Promise<void> {
        if (this.isDisposed) {
            throw new Error('Cannot start Kubescape Language Server: Client manager has been disposed.');
        }
        return this.queue.enqueue(() => this.internalStart(executablePath));
    }

    /**
     * Public serialized stop operation. Shares an idempotent in-flight promise.
     */
    public stop(): Promise<void> {
        if (this.shutdownPromise) {
            return this.shutdownPromise;
        }
        if (this.isDisposed && !this.client && !this.currentProcess) {
            return Promise.resolve();
        }
        this.shutdownPromise = this.queue
            .enqueue(() => this.internalStop())
            .finally(() => {
                this.shutdownPromise = null;
            });
        return this.shutdownPromise;
    }

    /**
     * Public serialized restart operation.
     */
    public async restart(
        executablePath: string,
        checkGeneration?: () => boolean
    ): Promise<RestartResult> {
        if (this.isDisposed) {
            throw new Error('Cannot restart Kubescape Language Server: Client manager has been disposed.');
        }
        return this.queue.enqueue(() => this.internalRestart(executablePath, checkGeneration));
    }

    private async internalRestart(
        executablePath: string,
        checkGeneration?: () => boolean
    ): Promise<RestartResult> {
        if (this.isDisposed || (checkGeneration && !checkGeneration())) {
            this.outputChannel.appendLine('[LSP] Aborting restart: superseded or client manager is disposed.');
            return 'superseded';
        }

        this.outputChannel.appendLine('[LSP] Restarting Kubescape Language Server...');
        await this.internalStop();

        // Re-check disposed and generation state after stop completes
        if (this.isDisposed || (checkGeneration && !checkGeneration())) {
            this.outputChannel.appendLine('[LSP] Aborting restart: superseded or client manager was disposed during stop.');
            return 'superseded';
        }

        await this.internalStart(executablePath, checkGeneration);
        return 'restarted';
    }

    private async internalStart(
        executablePath: string,
        checkGeneration?: () => boolean
    ): Promise<void> {
        if (this.isDisposed || (checkGeneration && !checkGeneration())) {
            this.outputChannel.appendLine('[LSP] Cannot start: superseded or client manager is disposed.');
            return;
        }

        if (this.isRunning() && this.currentExecutablePath === executablePath) {
            this.outputChannel.appendLine('[LSP] Language client is already running with target executable.');
            return;
        }

        if (this.client || this.currentProcess) {
            await this.internalStop();
        }

        // Re-check disposed state after stop
        if (this.isDisposed || (checkGeneration && !checkGeneration())) {
            this.outputChannel.appendLine('[LSP] Cannot start: superseded or client manager was disposed during stop.');
            return;
        }

        this.outputChannel.appendLine(`[LSP] Launching Kubescape Language Server: ${executablePath} lsp`);

        const serverOptions = createServerOptions(executablePath);

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

        let initTimer: NodeJS.Timeout | null = null;
        let didTimeout = false;

        const startPromise = client.start();

        const timeoutPromise = new Promise<never>((_, reject) => {
            initTimer = setTimeout(() => {
                didTimeout = true;
                reject(new Error('INITIALIZATION_TIMEOUT'));
            }, this.initTimeoutMs);
        });

        try {
            await Promise.race([startPromise, timeoutPromise]);
            this.currentProcess = getChildProcess(client);

            // Re-check disposal state after startup settles
            if (this.isDisposed || (checkGeneration && !checkGeneration())) {
                this.outputChannel.appendLine(
                    '[LSP] Client manager was disposed or superseded during startup. Stopping server...'
                );
                await this.internalStop();
                return;
            }

            this.outputChannel.appendLine('[LSP] Kubescape Language Server successfully started.');
        } catch (err: any) {
            if (didTimeout || err?.message === 'INITIALIZATION_TIMEOUT') {
                this.outputChannel.appendLine(
                    `[LSP Error] Server initialization timed out after ${this.initTimeoutMs}ms. Terminating process...`
                );

                const proc = getChildProcess(client) || this.currentProcess;
                let terminated = true;
                if (proc) {
                    terminated = await terminateProcess(proc, Math.max(200, this.stopTimeoutMs));
                }

                startPromise.catch(() => {});

                try {
                    await client.dispose();
                } catch {
                    // Ignore dispose failure on timed-out client
                }

                if (!terminated && proc && proc.pid) {
                    this.currentProcess = proc;
                    this.client = null;
                    this.currentExecutablePath = null;
                    throw new Error(
                        `Kubescape Language Server initialization timed out after ${this.initTimeoutMs}ms, ` +
                        `and the process (PID ${proc.pid}) failed to terminate. Cannot safely start or replace the server while the process remains alive.`
                    );
                }

                this.client = null;
                this.currentProcess = null;
                this.currentExecutablePath = null;

                throw new Error(
                    `Kubescape Language Server initialization timed out after ${this.initTimeoutMs}ms. The process was terminated.`
                );
            }

            this.outputChannel.appendLine(`[LSP] Failed to start language server: ${err?.message || err}`);

            const proc = getChildProcess(client) || this.currentProcess;
            let terminated = true;
            if (proc) {
                terminated = await terminateProcess(proc, Math.max(200, this.stopTimeoutMs));
            }

            try {
                await client.dispose();
            } catch {
                // Ignore dispose failure
            }

            if (!terminated && proc && proc.pid) {
                this.currentProcess = proc;
                this.client = null;
                this.currentExecutablePath = null;
                throw new Error(
                    `Failed to start language server (${err?.message || err}), ` +
                    `and the process (PID ${proc.pid}) failed to terminate. Cannot safely start or replace the server while the process remains alive.`
                );
            }

            this.client = null;
            this.currentProcess = null;
            this.currentExecutablePath = null;
            throw err;
        } finally {
            if (initTimer) {
                clearTimeout(initTimer);
                initTimer = null;
            }
        }
    }

    private async internalStop(): Promise<void> {
        if (!this.client && !this.currentProcess) {
            this.currentExecutablePath = null;
            return;
        }

        const clientToStop = this.client;
        let proc = getChildProcess(clientToStop) || this.currentProcess;

        try {
            if (clientToStop) {
                if (clientToStop.state === State.Running) {
                    this.outputChannel.appendLine('[LSP] Stopping Kubescape Language Server...');
                    await clientToStop.stop();
                    this.outputChannel.appendLine('[LSP] Kubescape Language Server stopped.');
                } else {
                    await clientToStop.dispose();
                }
            }
        } catch (err: any) {
            this.outputChannel.appendLine(`[LSP] Error stopping language server via client: ${err?.message || err}`);
        }

        // Confirm process termination
        proc = proc || getChildProcess(clientToStop) || this.currentProcess;
        if (proc && proc.pid) {
            const isDead = await waitForProcessExit(proc, this.stopTimeoutMs);
            if (!isDead) {
                this.outputChannel.appendLine(
                    `[LSP] Process PID ${proc.pid} did not exit after shutdown signal. Forcing termination...`
                );
                const forceExited = await terminateProcess(proc, Math.max(200, this.stopTimeoutMs));
                if (!forceExited) {
                    this.currentProcess = proc;
                    throw new Error(
                        `Failed to terminate Kubescape Language Server process (PID ${proc.pid}). ` +
                        `Cannot safely start or replace the server while the old process remains alive.`
                    );
                }
            }
        }

        this.client = null;
        this.currentProcess = null;
        this.currentExecutablePath = null;
    }

    public dispose(): void {
        if (this.isDisposed) {
            return;
        }
        this.isDisposed = true;
        if (this.shutdownPromise) {
            void this.shutdownPromise.finally(() => {
                this.queue.dispose();
            });
        } else {
            this.queue.dispose();
            void this.internalStop().catch((err) => {
                this.outputChannel.appendLine(`[LSP Error] Error during disposal: ${err?.message || err}`);
            });
        }
    }
}

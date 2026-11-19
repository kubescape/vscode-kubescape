import * as cp from 'child_process';
import { waitForProcessExit, terminateProcess } from './process';

/**
 * A strictly serialized asynchronous operation queue ensuring that lifecycle
 * operations (start, stop, restart) execute in strict order without concurrency
 * hazards or overlapping processes.
 */
export class LifecycleQueue {
    private queue: Promise<void> = Promise.resolve();
    private isDisposed: boolean = false;

    /**
     * Enqueues an operation onto the sequential execution chain.
     * The returned promise resolves or rejects with the operation's result.
     * Any failure in an operation does not break subsequent queued operations.
     */
    public enqueue<T>(op: () => Promise<T>): Promise<T> {
        if (this.isDisposed) {
            return Promise.reject(new Error('Lifecycle queue is disposed'));
        }

        return new Promise<T>((resolve, reject) => {
            this.queue = this.queue
                .then(async () => {
                    if (this.isDisposed) {
                        reject(new Error('Lifecycle queue is disposed'));
                        return;
                    }
                    try {
                        const result = await op();
                        resolve(result);
                    } catch (err) {
                        reject(err);
                    }
                })
                .catch(() => {
                    // Swallow internal errors on the queue promise so subsequent tasks run
                });
        });
    }

    /**
     * Marks the queue as disposed, preventing future tasks from executing.
     */
    public dispose(): void {
        this.isDisposed = true;
    }
}

/**
 * Common interface for a managed language client across its lifecycle states.
 */
export interface ILifecycleClient {
    state: number; // 1 = Stopped, 2 = Starting, 3 = Running
    _serverProcess?: cp.ChildProcess | null;
    process?: cp.ChildProcess | null;
    start(): Promise<void>;
    stop(): Promise<void>;
    dispose(): Promise<void> | void;
}

export interface LifecycleControllerOptions {
    initTimeoutMs?: number;
    stopTimeoutMs?: number;
    log?: (msg: string) => void;
}

function extractChildProcess(client: any): cp.ChildProcess | null {
    if (!client) {
        return null;
    }
    return client._serverProcess ?? client.process ?? null;
}

/**
 * Generic controller orchestrating serialized start, stop, and restart
 * operations for an ILifecycleClient with bounded initialization, process
 * termination confirmation, and disposal safety.
 */
export class LifecycleController<TClient extends ILifecycleClient> {
    private client: TClient | null = null;
    private currentProcess: cp.ChildProcess | null = null;
    private currentExecutablePath: string | null = null;
    private queue: LifecycleQueue = new LifecycleQueue();
    private isDisposed: boolean = false;
    private initTimeoutMs: number;
    private stopTimeoutMs: number;
    private log: (msg: string) => void;

    constructor(
        private readonly clientFactory: (executablePath: string) => TClient,
        optionsOrLog?: ((msg: string) => void) | LifecycleControllerOptions
    ) {
        if (typeof optionsOrLog === 'function') {
            this.log = optionsOrLog;
            this.initTimeoutMs = 15000;
            this.stopTimeoutMs = 3000;
        } else {
            this.log = optionsOrLog?.log ?? (() => {});
            this.initTimeoutMs = optionsOrLog?.initTimeoutMs ?? 15000;
            this.stopTimeoutMs = optionsOrLog?.stopTimeoutMs ?? 3000;
        }
    }

    public getClient(): TClient | null {
        return this.client;
    }

    public isRunning(): boolean {
        return this.client !== null && this.client.state === 3;
    }

    public getCurrentExecutablePath(): string | null {
        return this.currentExecutablePath;
    }

    public getIsDisposed(): boolean {
        return this.isDisposed;
    }

    public async start(executablePath: string): Promise<void> {
        if (this.isDisposed) {
            throw new Error('Cannot start language client: Controller has been disposed.');
        }
        return this.queue.enqueue(() => this.internalStart(executablePath));
    }

    public async stop(): Promise<void> {
        return this.queue.enqueue(() => this.internalStop());
    }

    public async restart(executablePath: string): Promise<void> {
        if (this.isDisposed) {
            throw new Error('Cannot restart language client: Controller has been disposed.');
        }
        return this.queue.enqueue(() => this.internalRestart(executablePath));
    }

    private async internalRestart(executablePath: string): Promise<void> {
        if (this.isDisposed) {
            this.log('[LSP] Aborting restart: controller is disposed.');
            return;
        }

        this.log(`[LSP] Restarting language client for: ${executablePath}`);
        await this.internalStop();

        // Re-check disposed state after stop completes
        if (this.isDisposed) {
            this.log('[LSP] Aborting restart: controller was disposed during stop.');
            return;
        }

        await this.internalStart(executablePath);
    }

    private async internalStart(executablePath: string): Promise<void> {
        if (this.isDisposed) {
            this.log('[LSP] Cannot start: controller is disposed.');
            return;
        }

        if (this.isRunning() && this.currentExecutablePath === executablePath) {
            this.log('[LSP] Client is already running with target executable.');
            return;
        }

        if (this.client || this.currentProcess) {
            await this.internalStop();
        }

        // Re-check disposed state after stop
        if (this.isDisposed) {
            this.log('[LSP] Cannot start: controller was disposed during stop.');
            return;
        }

        this.log(`[LSP] Starting client for: ${executablePath}`);

        const client = this.clientFactory(executablePath);
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
            this.currentProcess = extractChildProcess(client);
            this.log('[LSP] Client successfully started.');
        } catch (err: any) {
            if (didTimeout || err?.message === 'INITIALIZATION_TIMEOUT') {
                this.log(
                    `[LSP Error] Server initialization timed out after ${this.initTimeoutMs}ms. Terminating process...`
                );

                const proc = extractChildProcess(client) || this.currentProcess;
                if (proc) {
                    await terminateProcess(proc, 3000);
                }

                startPromise.catch(() => {});

                try {
                    await client.dispose();
                } catch {
                    // Ignore dispose failure on timed-out client
                }

                this.client = null;
                this.currentProcess = null;
                this.currentExecutablePath = null;

                throw new Error(
                    `Kubescape Language Server initialization timed out after ${this.initTimeoutMs}ms. The process was terminated.`
                );
            }

            this.log(`[LSP] Client failed to start: ${err?.message || err}`);

            const proc = extractChildProcess(client) || this.currentProcess;
            if (proc) {
                await terminateProcess(proc, 2000);
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
        let proc = extractChildProcess(clientToStop) || this.currentProcess;

        try {
            if (clientToStop) {
                if (clientToStop.state === 3 || clientToStop.state === 2) {
                    this.log('[LSP] Stopping client...');
                    await clientToStop.stop();
                    this.log('[LSP] Client stopped.');
                } else {
                    await clientToStop.dispose();
                }
            }
        } catch (err: any) {
            this.log(`[LSP] Error stopping client: ${err?.message || err}`);
        }

        // Confirm process termination
        proc = proc || extractChildProcess(clientToStop) || this.currentProcess;
        if (proc && proc.pid) {
            const isDead = await waitForProcessExit(proc, this.stopTimeoutMs);
            if (!isDead) {
                this.log(
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
        this.queue.dispose();
        void this.internalStop();
    }
}

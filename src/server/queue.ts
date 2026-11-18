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
    start(): Promise<void>;
    stop(): Promise<void>;
    dispose(): Promise<void> | void;
}

/**
 * Generic controller orchestrating serialized start, stop, and restart
 * operations for an ILifecycleClient.
 */
export class LifecycleController<TClient extends ILifecycleClient> {
    private client: TClient | null = null;
    private currentExecutablePath: string | null = null;
    private queue: LifecycleQueue = new LifecycleQueue();
    private isDisposed: boolean = false;

    constructor(
        private readonly clientFactory: (executablePath: string) => TClient,
        private readonly log: (msg: string) => void = () => {}
    ) {}

    public getClient(): TClient | null {
        return this.client;
    }

    public isRunning(): boolean {
        return this.client !== null && this.client.state === 3;
    }

    public getCurrentExecutablePath(): string | null {
        return this.currentExecutablePath;
    }

    public async start(executablePath: string): Promise<void> {
        return this.queue.enqueue(() => this.internalStart(executablePath));
    }

    public async stop(): Promise<void> {
        return this.queue.enqueue(() => this.internalStop());
    }

    public async restart(executablePath: string): Promise<void> {
        return this.queue.enqueue(() => this.internalRestart(executablePath));
    }

    private async internalRestart(executablePath: string): Promise<void> {
        this.log(`[LSP] Restarting language client for: ${executablePath}`);
        await this.internalStop();
        await this.internalStart(executablePath);
    }

    private async internalStart(executablePath: string): Promise<void> {
        if (this.isRunning() && this.currentExecutablePath === executablePath) {
            this.log('[LSP] Client is already running with target executable.');
            return;
        }

        if (this.client) {
            await this.internalStop();
        }

        this.log(`[LSP] Starting client for: ${executablePath}`);
        try {
            const client = this.clientFactory(executablePath);
            this.client = client;
            this.currentExecutablePath = executablePath;

            await client.start();
            this.log('[LSP] Client successfully started.');
        } catch (err: any) {
            this.log(`[LSP] Client failed to start: ${err?.message || err}`);
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
            if (clientToStop.state === 3 || clientToStop.state === 2) {
                this.log('[LSP] Stopping client...');
                await clientToStop.stop();
                this.log('[LSP] Client stopped.');
            } else {
                await clientToStop.dispose();
            }
        } catch (err: any) {
            this.log(`[LSP] Error stopping client: ${err?.message || err}`);
        }
    }

    public dispose(): void {
        this.isDisposed = true;
        this.queue.dispose();
        void this.internalStop();
    }
}

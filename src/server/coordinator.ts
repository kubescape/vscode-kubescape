export interface IOutputChannel {
    appendLine(value: string): void;
}

export interface IDisposable {
    dispose(): void;
}

export interface ILanguageClientManager {
    isRunning(): boolean;
    getCurrentExecutablePath(): string | null;
    restart(executablePath: string): Promise<void>;
}

export type ExecutableResolver = () => Promise<string>;

/**
 * Coordinates executable discovery and language server lifecycle transitions.
 * Enforces monotonically increasing request generation tokens to guarantee that
 * slow or out-of-order discovery results cannot overwrite newer selections or
 * launch servers after disposal.
 */
export class ServerLifecycleCoordinator implements IDisposable {
    private currentGeneration: number = 0;
    private isDisposed: boolean = false;
    private clientManager: ILanguageClientManager;
    private outputChannel: IOutputChannel;
    private resolver: ExecutableResolver;

    constructor(
        clientManager: ILanguageClientManager,
        outputChannel: IOutputChannel,
        resolver: ExecutableResolver
    ) {
        this.clientManager = clientManager;
        this.outputChannel = outputChannel;
        this.resolver = resolver;
    }

    public getGeneration(): number {
        return this.currentGeneration;
    }

    public getIsDisposed(): boolean {
        return this.isDisposed;
    }

    /**
     * Triggers a serialized startup or restart with a monotonically increasing generation token.
     * If another request arrives while discovery is in-flight, this request is discarded.
     */
    public async triggerRestart(reason: string): Promise<void> {
        if (this.isDisposed) {
            return;
        }

        const requestGen = ++this.currentGeneration;
        this.outputChannel.appendLine(
            `[LSP Coordinator] Triggering restart (reason: ${reason}, generation: ${requestGen})...`
        );

        let exePath: string;
        try {
            exePath = await this.resolver();
        } catch (err: any) {
            if (this.isDisposed || requestGen !== this.currentGeneration) {
                this.outputChannel.appendLine(
                    `[LSP Coordinator] Suppressing discovery error for superseded generation ${requestGen} (current: ${this.currentGeneration}).`
                );
                return;
            }
            throw err;
        }

        // Check generation immediately after async discovery completes
        if (this.isDisposed || requestGen !== this.currentGeneration) {
            this.outputChannel.appendLine(
                `[LSP Coordinator] Discarding stale discovery result "${exePath}" for generation ${requestGen} (current: ${this.currentGeneration}, disposed: ${this.isDisposed}).`
            );
            return;
        }

        // Avoid redundant restarts when target executable is already running (unless manual)
        if (
            this.clientManager.isRunning() &&
            this.clientManager.getCurrentExecutablePath() === exePath &&
            reason !== 'manual'
        ) {
            this.outputChannel.appendLine(
                `[LSP Coordinator] Server is already running with target executable "${exePath}". Skipping restart.`
            );
            return;
        }

        // Check generation again immediately before acting
        if (this.isDisposed || requestGen !== this.currentGeneration) {
            return;
        }

        await this.clientManager.restart(exePath);
    }

    public dispose(): void {
        if (this.isDisposed) {
            return;
        }
        this.isDisposed = true;
        this.currentGeneration++; // Invalidate all pending discovery promises
    }
}

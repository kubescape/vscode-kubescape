import { RestartResult } from './queue';

export { RestartResult };

export interface IOutputChannel {
    appendLine(value: string): void;
}

export interface IDisposable {
    dispose(): void;
}

export interface ILanguageClientManager {
    isRunning(): boolean;
    getCurrentExecutablePath(): string | null;
    restart(executablePath: string, checkGeneration?: () => boolean): Promise<RestartResult>;
}

export type ExecutableResolver = () => Promise<string>;

export type WorkspaceFoldersProvider = () => string[];

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
    private getWorkspaceFolders?: WorkspaceFoldersProvider;
    private lastAppliedWorkspaceFolders: string[] = [];

    constructor(
        clientManager: ILanguageClientManager,
        outputChannel: IOutputChannel,
        resolver: ExecutableResolver,
        getWorkspaceFolders?: WorkspaceFoldersProvider
    ) {
        this.clientManager = clientManager;
        this.outputChannel = outputChannel;
        this.resolver = resolver;
        this.getWorkspaceFolders = getWorkspaceFolders;
    }

    public getGeneration(): number {
        return this.currentGeneration;
    }

    public getIsDisposed(): boolean {
        return this.isDisposed;
    }

    public getLastAppliedWorkspaceFolders(): string[] {
        return [...this.lastAppliedWorkspaceFolders];
    }

    private areFolderListsEqual(a: string[], b: string[]): boolean {
        if (a.length !== b.length) {
            return false;
        }
        const sortedA = [...a].sort();
        const sortedB = [...b].sort();
        return sortedA.every((val, idx) => val === sortedB[idx]);
    }

    /**
     * Triggers a serialized startup or restart with a monotonically increasing generation token.
     * If another request arrives while discovery is in-flight, this request is discarded.
     */
    public async triggerRestart(reason: string): Promise<RestartResult> {
        if (this.isDisposed) {
            return 'superseded';
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
                return 'superseded';
            }
            throw err;
        }

        // Check generation immediately after async discovery completes
        if (this.isDisposed || requestGen !== this.currentGeneration) {
            this.outputChannel.appendLine(
                `[LSP Coordinator] Discarding stale discovery result "${exePath}" for generation ${requestGen} (current: ${this.currentGeneration}, disposed: ${this.isDisposed}).`
            );
            return 'superseded';
        }

        const currentFolders = this.getWorkspaceFolders ? this.getWorkspaceFolders() : [];
        const foldersChanged = !this.areFolderListsEqual(currentFolders, this.lastAppliedWorkspaceFolders);

        // Avoid redundant restarts when target executable is already running (unless manual, workspace, or folders changed)
        if (
            this.clientManager.isRunning() &&
            this.clientManager.getCurrentExecutablePath() === exePath &&
            reason !== 'manual' &&
            reason !== 'workspace' &&
            !foldersChanged
        ) {
            this.outputChannel.appendLine(
                `[LSP Coordinator] Server is already running with target executable "${exePath}". Skipping restart.`
            );
            return 'unchanged';
        }

        // Check generation again immediately before acting
        if (this.isDisposed || requestGen !== this.currentGeneration) {
            return 'superseded';
        }

        const result = await this.clientManager.restart(
            exePath,
            () => !this.isDisposed && requestGen === this.currentGeneration
        );
        if (result === 'restarted') {
            this.lastAppliedWorkspaceFolders = [...currentFolders];
        }
        return result;
    }

    public dispose(): void {
        if (this.isDisposed) {
            return;
        }
        this.isDisposed = true;
        this.currentGeneration++; // Invalidate all pending discovery promises
    }
}

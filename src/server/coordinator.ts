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
    private pendingRestarts: number = 0;
    private runningServerValid: boolean = false;

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
        this.runningServerValid = clientManager.isRunning();
    }

    public getGeneration(): number {
        return this.currentGeneration;
    }

    public getIsDisposed(): boolean {
        return this.isDisposed;
    }

    public getPendingRestarts(): number {
        return this.pendingRestarts;
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

        // A manual restart explicitly invalidates any existing running server
        if (reason === 'manual') {
            this.runningServerValid = false;
        }

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
            this.runningServerValid = false;
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

        // Avoid redundant restarts ONLY when no restart is in flight, the running server
        // is valid with matching executable, and workspace folders are unchanged. Requests
        // still in discovery do not count: a newer request supersedes them.
        const canSkip =
            this.pendingRestarts === 0 &&
            this.runningServerValid &&
            this.clientManager.isRunning() &&
            this.clientManager.getCurrentExecutablePath() === exePath &&
            reason !== 'manual' &&
            reason !== 'workspace' &&
            !foldersChanged;

        if (canSkip) {
            this.outputChannel.appendLine(
                `[LSP Coordinator] Server is already running with target executable "${exePath}". Skipping restart.`
            );
            return 'unchanged';
        }

        // Check generation again immediately before acting
        if (this.isDisposed || requestGen !== this.currentGeneration) {
            return 'superseded';
        }

        this.pendingRestarts++;
        let result: RestartResult;
        try {
            result = await this.clientManager.restart(
                exePath,
                () => !this.isDisposed && requestGen === this.currentGeneration
            );
        } finally {
            this.pendingRestarts--;
        }
        if (result === 'restarted') {
            this.runningServerValid = true;
            this.lastAppliedWorkspaceFolders = [...currentFolders];
        } else if (result !== 'unchanged') {
            this.runningServerValid = false;
        }
        return result;
    }

    public dispose(): void {
        if (this.isDisposed) {
            return;
        }
        this.isDisposed = true;
        this.runningServerValid = false;
        this.currentGeneration++; // Invalidate all pending discovery promises
    }
}

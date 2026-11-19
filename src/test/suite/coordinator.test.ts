import * as assert from 'assert';
import { ServerLifecycleCoordinator } from '../../server/coordinator';

class Deferred<T> {
    public promise: Promise<T>;
    public resolve!: (val: T) => void;
    public reject!: (err: any) => void;

    constructor() {
        this.promise = new Promise<T>((res, rej) => {
            this.resolve = res;
            this.reject = rej;
        });
    }
}

describe('ServerLifecycleCoordinator Generation & Invalidation Tests (Finding 3)', () => {
    let mockOutputChannel: any;
    let restartCalls: string[];
    let running: boolean;
    let currentExe: string | null;
    let mockClientManager: any;

    beforeEach(() => {
        restartCalls = [];
        running = false;
        currentExe = null;

        mockOutputChannel = {
            appendLine: () => {},
        };

        mockClientManager = {
            isRunning: () => running,
            getCurrentExecutablePath: () => currentExe,
            restart: async (exePath: string) => {
                restartCalls.push(exePath);
                running = true;
                currentExe = exePath;
            },
        };
    });

    it('discards stale discovery result when a newer request resolves first', async () => {
        const deferredA = new Deferred<string>();
        const deferredB = new Deferred<string>();

        let callCount = 0;
        const resolver = async () => {
            callCount++;
            if (callCount === 1) {
                return await deferredA.promise;
            } else {
                return await deferredB.promise;
            }
        };

        const coordinator = new ServerLifecycleCoordinator(mockClientManager, mockOutputChannel, resolver);

        // 1. Request A starts first (generation 1)
        const promiseA = coordinator.triggerRestart('request-A');
        assert.strictEqual(coordinator.getGeneration(), 1);

        // 2. Request B starts second (generation 2)
        const promiseB = coordinator.triggerRestart('request-B');
        assert.strictEqual(coordinator.getGeneration(), 2);

        // 3. Request B resolves FIRST
        deferredB.resolve('/path/to/kubescape-B');
        await promiseB;

        assert.deepStrictEqual(restartCalls, ['/path/to/kubescape-B']);
        assert.strictEqual(mockClientManager.getCurrentExecutablePath(), '/path/to/kubescape-B');

        // 4. Request A resolves LATER
        deferredA.resolve('/path/to/kubescape-A');
        await promiseA;

        // 5. Verify that Request A was discarded and never replaced B!
        assert.deepStrictEqual(
            restartCalls,
            ['/path/to/kubescape-B'],
            'Stale request A must not replace the active executable from request B'
        );
        assert.strictEqual(mockClientManager.getCurrentExecutablePath(), '/path/to/kubescape-B');
    });

    it('invalidates in-flight discovery requests upon disposal', async () => {
        const deferred = new Deferred<string>();
        const resolver = async () => await deferred.promise;

        const coordinator = new ServerLifecycleCoordinator(mockClientManager, mockOutputChannel, resolver);

        const restartPromise = coordinator.triggerRestart('test');
        assert.strictEqual(coordinator.getGeneration(), 1);

        // Dispose before discovery completes
        coordinator.dispose();
        assert.strictEqual(coordinator.getIsDisposed(), true);

        // Complete discovery
        deferred.resolve('/path/to/kubescape');
        await restartPromise;

        // Verify restart was never called after disposal
        assert.deepStrictEqual(restartCalls, [], 'Restart must not be enqueued when coordinator is disposed');
    });

    it('skips redundant restart when server is already running with target executable', async () => {
        running = true;
        currentExe = '/usr/local/bin/kubescape';

        const resolver = async () => '/usr/local/bin/kubescape';
        const coordinator = new ServerLifecycleCoordinator(mockClientManager, mockOutputChannel, resolver);

        // Non-manual trigger (e.g. config or workspace)
        await coordinator.triggerRestart('config');
        assert.deepStrictEqual(restartCalls, [], 'Should not restart if target executable is already running');

        // Manual trigger ALWAYS restarts
        await coordinator.triggerRestart('manual');
        assert.deepStrictEqual(restartCalls, ['/usr/local/bin/kubescape'], 'Manual trigger must force restart');
    });

    it('suppresses errors from superseded discovery requests', async () => {
        const deferredA = new Deferred<string>();
        const deferredB = new Deferred<string>();

        let callCount = 0;
        const resolver = async () => {
            callCount++;
            if (callCount === 1) {
                return await deferredA.promise;
            } else {
                return await deferredB.promise;
            }
        };

        const coordinator = new ServerLifecycleCoordinator(mockClientManager, mockOutputChannel, resolver);

        // Start request A, then B
        const promiseA = coordinator.triggerRestart('A');
        const promiseB = coordinator.triggerRestart('B');

        // B resolves successfully
        deferredB.resolve('/path/to/kubescape-B');
        await promiseB;

        // A rejects with an error
        deferredA.reject(new Error('Discovery failed for A'));

        // promiseA must not reject because it was superseded
        await assert.doesNotReject(promiseA);
    });
});

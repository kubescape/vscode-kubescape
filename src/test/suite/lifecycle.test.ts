/* eslint-disable @typescript-eslint/naming-convention */
import * as assert from 'assert';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { LifecycleController, ILifecycleClient } from '../../server/queue';

function encodeFrame(msg: any): Buffer {
    const json = JSON.stringify(msg);
    const len = Buffer.byteLength(json, 'utf8');
    return Buffer.from(`Content-Length: ${len}\r\n\r\n${json}`, 'utf8');
}

class LspTestClient {
    private proc: cp.ChildProcess;
    private buffer: Buffer = Buffer.alloc(0);
    private messageQueue: any[] = [];
    private waiters: Array<(msg: any) => void> = [];

    constructor(mockServerScript: string, env: Record<string, string> = {}) {
        this.proc = cp.spawn(process.execPath, [mockServerScript], {
            stdio: ['pipe', 'pipe', 'pipe'],
            env: { ...process.env, ...env },
        });

        this.proc.stdout?.on('data', (chunk: Buffer) => {
            this.buffer = Buffer.concat([this.buffer, chunk]);
            while (true) {
                const headerEnd = this.buffer.indexOf('\r\n\r\n');
                if (headerEnd === -1) {
                    break;
                }
                const headerStr = this.buffer.slice(0, headerEnd).toString('ascii');
                const match = /Content-Length:\s*(\d+)/i.exec(headerStr);
                if (!match) {
                    break;
                }
                const contentLength = parseInt(match[1], 10);
                const bodyStart = headerEnd + 4;
                const totalLength = bodyStart + contentLength;
                if (this.buffer.length < totalLength) {
                    break;
                }
                const body = this.buffer.slice(bodyStart, totalLength);
                this.buffer = this.buffer.slice(totalLength);
                const msg = JSON.parse(body.toString('utf8'));

                if (this.waiters.length > 0) {
                    const next = this.waiters.shift()!;
                    next(msg);
                } else {
                    this.messageQueue.push(msg);
                }
            }
        });
    }

    public send(msg: any): void {
        this.proc.stdin?.write(encodeFrame(msg));
    }

    public async nextMessage(timeoutMs: number = 5000): Promise<any> {
        if (this.messageQueue.length > 0) {
            return this.messageQueue.shift()!;
        }
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                const idx = this.waiters.indexOf(resolve);
                if (idx !== -1) {
                    this.waiters.splice(idx, 1);
                }
                reject(new Error(`Timeout waiting for LSP message after ${timeoutMs}ms`));
            }, timeoutMs);

            this.waiters.push((msg) => {
                clearTimeout(timer);
                resolve(msg);
            });
        });
    }

    public async waitForExit(timeoutMs: number = 5000): Promise<number | null> {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.proc.kill('SIGKILL');
                reject(new Error('Process did not exit in time'));
            }, timeoutMs);

            this.proc.on('exit', (code) => {
                clearTimeout(timer);
                resolve(code);
            });
        });
    }

    public getPid(): number | undefined {
        return this.proc.pid;
    }

    public isAlive(): boolean {
        return this.proc.exitCode === null && !this.proc.killed;
    }

    public kill(): void {
        if (this.isAlive()) {
            this.proc.kill('SIGKILL');
        }
    }
}

describe('LSP Lifecycle & Protocol Tests', () => {
    let mockServerPath: string;
    let tmpDir: string;
    let recordFile: string;

    before(() => {
        mockServerPath = path.resolve(__dirname, '../mockLspServer.js');
    });

    beforeEach(async () => {
        tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ks-lifecycle-'));
        recordFile = path.join(tmpDir, 'record.log');
    });

    afterEach(async () => {
        try {
            await fs.promises.rm(tmpDir, { recursive: true, force: true });
        } catch {
            // ignore
        }
    });

    it('performs complete initialize, notification, and shutdown/exit handshake', async () => {
        const client = new LspTestClient(mockServerPath, { MOCK_LSP_RECORD_FILE: recordFile });

        // 1. Initialize
        client.send({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: {
                processId: process.pid,
                rootUri: 'file:///workspace',
                capabilities: {},
            },
        });

        const initResp = await client.nextMessage();
        assert.strictEqual(initResp.id, 1);
        assert.ok(initResp.result?.capabilities?.textDocumentSync);
        assert.strictEqual(initResp.result.capabilities.textDocumentSync.save, true);

        // 2. Initialized notification
        client.send({ jsonrpc: '2.0', method: 'initialized', params: {} });

        // 3. Document synchronization notifications
        const docUri = 'file:///workspace/pod.yaml';
        client.send({
            jsonrpc: '2.0',
            method: 'textDocument/didOpen',
            params: {
                textDocument: { uri: docUri, languageId: 'yaml', version: 1, text: 'kind: Pod\n' },
            },
        });

        client.send({
            jsonrpc: '2.0',
            method: 'textDocument/didChange',
            params: {
                textDocument: { uri: docUri, version: 2 },
                contentChanges: [{ text: 'kind: Pod\nmetadata:\n  name: x\n' }],
            },
        });

        client.send({
            jsonrpc: '2.0',
            method: 'textDocument/didSave',
            params: {
                textDocument: { uri: docUri },
            },
        });

        client.send({
            jsonrpc: '2.0',
            method: 'textDocument/didClose',
            params: {
                textDocument: { uri: docUri },
            },
        });

        // Kubescape clears diagnostics on didClose
        const closeDiagMsg = await client.nextMessage();
        assert.strictEqual(closeDiagMsg.method, 'textDocument/publishDiagnostics');
        assert.strictEqual(closeDiagMsg.params?.uri, docUri);
        assert.deepStrictEqual(closeDiagMsg.params?.diagnostics, []);

        // 4. Shutdown
        client.send({ jsonrpc: '2.0', id: 2, method: 'shutdown' });
        const shutdownResp = await client.nextMessage();
        assert.strictEqual(shutdownResp.id, 2);
        assert.strictEqual(shutdownResp.result, null);

        // 5. Exit
        client.send({ jsonrpc: '2.0', method: 'exit' });
        const exitCode = await client.waitForExit();
        assert.strictEqual(exitCode, 0);

        // Verify recorded messages were received in exact sequence
        const recorded = fs
            .readFileSync(recordFile, 'utf8')
            .trim()
            .split('\n')
            .map(line => JSON.parse(line));

        const methods = recorded.map(r => r.method);
        assert.deepStrictEqual(methods, [
            'initialize',
            'initialized',
            'textDocument/didOpen',
            'textDocument/didChange',
            'textDocument/didSave',
            'textDocument/didClose',
            'shutdown',
            'exit',
        ]);
    });

    it('receives diagnostics notification upon didSave when server is in diagnostic mode', async () => {
        const client = new LspTestClient(mockServerPath, {
            MOCK_LSP_PUBLISH_DIAGNOSTICS: '1',
        });

        client.send({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: { processId: null, rootUri: 'file:///workspace', capabilities: {} },
        });
        await client.nextMessage();
        client.send({ jsonrpc: '2.0', method: 'initialized', params: {} });

        client.send({
            jsonrpc: '2.0',
            method: 'textDocument/didSave',
            params: { textDocument: { uri: 'file:///workspace/pod.yaml' } },
        });

        const diagMsg = await client.nextMessage();
        assert.strictEqual(diagMsg.method, 'textDocument/publishDiagnostics');
        assert.strictEqual(diagMsg.params?.uri, 'file:///workspace/pod.yaml');
        assert.strictEqual(diagMsg.params?.diagnostics?.length, 3);
        assert.strictEqual(diagMsg.params.diagnostics[0].code, 'C-0017');

        client.kill();
    });

    it('handles unexpected process exit cleanly without hanging', async () => {
        const client = new LspTestClient(mockServerPath, {
            MOCK_LSP_CRASH_ON_INIT: '1',
        });

        client.send({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: { processId: null, rootUri: null, capabilities: {} },
        });

        const exitCode = await client.waitForExit();
        assert.strictEqual(exitCode, 2);
    });

    it('terminates child process cleanly on kill without leaving orphaned zombies', async () => {
        const client = new LspTestClient(mockServerPath);
        const pid = client.getPid();
        assert.ok(pid);

        client.kill();
        await client.waitForExit();

        // Verify process is gone
        let isRunning = false;
        try {
            process.kill(pid!, 0);
            isRunning = true;
        } catch {
            isRunning = false;
        }
        assert.strictEqual(isRunning, false);
    });
});

describe('Language Client Lifecycle Controller & Queue Tests', () => {
    class MockLanguageClient implements ILifecycleClient {
        public state: number = 1; // 1 = Stopped, 2 = Starting, 3 = Running
        public startCallCount: number = 0;
        public stopCallCount: number = 0;
        public disposeCallCount: number = 0;
        public executablePath: string;
        public startDelayMs: number = 0;
        public shouldFailStart: boolean = false;

        constructor(executablePath: string) {
            this.executablePath = executablePath;
        }

        public async start(): Promise<void> {
            this.state = 2; // Starting
            this.startCallCount++;
            if (this.startDelayMs > 0) {
                await new Promise((r) => setTimeout(r, this.startDelayMs));
            }
            if (this.shouldFailStart) {
                this.state = 1; // Stopped
                throw new Error('Simulated start failure');
            }
            this.state = 3; // Running
        }

        public async stop(): Promise<void> {
            this.stopCallCount++;
            this.state = 1; // Stopped
        }

        public async dispose(): Promise<void> {
            this.disposeCallCount++;
            this.state = 1; // Stopped
        }
    }

    let createdClients: MockLanguageClient[] = [];
    let defaultStartDelayMs = 0;
    let nextStartShouldFail = false;

    const mockFactory = (exePath: string): MockLanguageClient => {
        const client = new MockLanguageClient(exePath);
        client.startDelayMs = defaultStartDelayMs;
        client.shouldFailStart = nextStartShouldFail;
        nextStartShouldFail = false;
        createdClients.push(client);
        return client;
    };

    beforeEach(() => {
        createdClients = [];
        defaultStartDelayMs = 0;
        nextStartShouldFail = false;
    });

    it('executes two rapid restart requests sequentially without losing the final state', async () => {
        const manager = new LifecycleController<MockLanguageClient>(mockFactory);
        defaultStartDelayMs = 15;

        await manager.start('/bin/initial');
        assert.strictEqual(manager.getCurrentExecutablePath(), '/bin/initial');
        assert.strictEqual(createdClients.length, 1);

        // Fire two rapid restarts concurrently
        const p1 = manager.restart('/bin/restart-1');
        const p2 = manager.restart('/bin/restart-2');

        await Promise.all([p1, p2]);

        assert.strictEqual(manager.isRunning(), true);
        assert.strictEqual(manager.getCurrentExecutablePath(), '/bin/restart-2');
        assert.strictEqual(createdClients.length, 3);

        // Previous clients must be stopped
        assert.strictEqual(createdClients[0].state, 1);
        assert.strictEqual(createdClients[1].state, 1);
        assert.strictEqual(createdClients[2].state, 3);

        await manager.stop();
    });

    it('handles restart requested while startup is in progress', async () => {
        const manager = new LifecycleController<MockLanguageClient>(mockFactory);
        defaultStartDelayMs = 30;

        // Start initiated (takes 30ms)
        const startPromise = manager.start('/bin/client-a');

        // Restart requested immediately while client-a is starting
        const restartPromise = manager.restart('/bin/client-b');

        await Promise.all([startPromise, restartPromise]);

        assert.strictEqual(manager.isRunning(), true);
        assert.strictEqual(manager.getCurrentExecutablePath(), '/bin/client-b');
        assert.strictEqual(createdClients.length, 2);
        assert.strictEqual(createdClients[0].state, 1); // client-a stopped
        assert.strictEqual(createdClients[1].state, 3); // client-b running

        await manager.stop();
    });

    it('handles stop requested while startup is in progress', async () => {
        const manager = new LifecycleController<MockLanguageClient>(mockFactory);
        defaultStartDelayMs = 30;

        const startPromise = manager.start('/bin/client-a');
        const stopPromise = manager.stop();

        await Promise.all([startPromise, stopPromise]);

        assert.strictEqual(manager.isRunning(), false);
        assert.strictEqual(manager.getClient(), null);
        assert.strictEqual(manager.getCurrentExecutablePath(), null);
        assert.strictEqual(createdClients[0].state, 1);
    });

    it('recovers cleanly from failed startup and allows subsequent successful restart', async () => {
        const manager = new LifecycleController<MockLanguageClient>(mockFactory);
        nextStartShouldFail = true;

        await assert.rejects(
            manager.start('/bin/bad-path'),
            /Simulated start failure/
        );

        assert.strictEqual(manager.isRunning(), false);
        assert.strictEqual(manager.getClient(), null);
        assert.strictEqual(manager.getCurrentExecutablePath(), null);

        // Now restart with good path should succeed
        await manager.restart('/bin/good-path');

        assert.strictEqual(manager.isRunning(), true);
        assert.strictEqual(manager.getCurrentExecutablePath(), '/bin/good-path');
        assert.strictEqual(createdClients.length, 2);
        assert.strictEqual(createdClients[1].state, 3);

        await manager.stop();
    });

    it('safely handles repeated stop calls without throwing or corrupting state', async () => {
        const manager = new LifecycleController<MockLanguageClient>(mockFactory);

        await manager.start('/bin/app');
        assert.strictEqual(manager.isRunning(), true);

        // Call stop 3 times sequentially and concurrently
        await manager.stop();
        await manager.stop();
        await manager.stop();

        assert.strictEqual(manager.isRunning(), false);
        assert.strictEqual(manager.getClient(), null);
        assert.strictEqual(manager.getCurrentExecutablePath(), null);
    });

    it('ensures no overlapping running client instances during rapid lifecycle transitions', async () => {
        const manager = new LifecycleController<MockLanguageClient>(mockFactory);
        defaultStartDelayMs = 10;

        // Trigger sequence: start -> restart -> restart -> stop -> start
        const ops = [
            manager.start('/bin/p1'),
            manager.restart('/bin/p2'),
            manager.restart('/bin/p3'),
            manager.stop(),
            manager.start('/bin/p4'),
        ];

        await Promise.all(ops);

        assert.strictEqual(manager.isRunning(), true);
        assert.strictEqual(manager.getCurrentExecutablePath(), '/bin/p4');

        // Only the final client should be running
        const runningClients = createdClients.filter((c) => c.state === 3);
        assert.strictEqual(runningClients.length, 1);
        assert.strictEqual(createdClients[createdClients.length - 1].state, 3);

        manager.dispose();
        assert.strictEqual(createdClients[createdClients.length - 1].state, 1);
    });
});

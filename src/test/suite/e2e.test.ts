import * as assert from 'assert';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

function encodeFrame(msg: any): Buffer {
    const json = JSON.stringify(msg);
    const len = Buffer.byteLength(json, 'utf8');
    return Buffer.from(`Content-Length: ${len}\r\n\r\n${json}`, 'utf8');
}

function findKubescapeBinary(): string | undefined {
    if (process.env.KUBESCAPE_BIN_PATH && fs.existsSync(process.env.KUBESCAPE_BIN_PATH)) {
        return path.resolve(process.env.KUBESCAPE_BIN_PATH);
    }
    const pathDirs = (process.env.PATH || '').split(path.delimiter);
    for (const d of pathDirs) {
        if (!d) {
            continue;
        }
        const p = path.join(d, process.platform === 'win32' ? 'kubescape.exe' : 'kubescape');
        if (fs.existsSync(p)) {
            return p;
        }
    }
    return undefined;
}

describe('Real Kubescape LSP End-to-End Test', function () {
    this.timeout(120000);
    let binPath: string;

    before(() => {
        const found = findKubescapeBinary();
        if (!found) {
            throw new Error(
                'Kubescape binary with LSP support not found. ' +
                'Please install Kubescape with built-in LSP support or set KUBESCAPE_BIN_PATH environment variable to run integration tests.'
            );
        }

        // Verify that the binary supports `lsp`
        try {
            const check = cp.spawnSync(found, ['lsp', '--help'], { encoding: 'utf8', timeout: 5000 });
            if (check.status !== 0 && !check.stdout?.includes('lsp') && !check.stderr?.includes('lsp')) {
                throw new Error(
                    `Found binary at "${found}", but "${found} lsp --help" exited with status ${check.status}: ${check.stderr || check.stdout}`
                );
            }
        } catch (err: any) {
            throw new Error(
                `Found binary at "${found}", but verifying LSP capability failed: ${err.message}. ` +
                'Ensure the binary has the built-in Language Server command (PR #5064).'
            );
        }

        binPath = found;
    });

    let tmpDir: string;
    let proc: cp.ChildProcess;
    let buffer: Buffer;
    let messageQueue: any[];
    let waiters: Array<(msg: any) => void>;

    function nextMessage(timeoutMs: number = 60000): Promise<any> {
        if (messageQueue.length > 0) {
            return Promise.resolve(messageQueue.shift()!);
        }
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                const idx = waiters.indexOf(resolve);
                if (idx !== -1) {
                    waiters.splice(idx, 1);
                }
                reject(new Error(`Timeout waiting for LSP message after ${timeoutMs}ms`));
            }, timeoutMs);

            waiters.push((msg) => {
                clearTimeout(timer);
                resolve(msg);
            });
        });
    }

    beforeEach(async () => {
        tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ks-e2e-'));
        buffer = Buffer.alloc(0);
        messageQueue = [];
        waiters = [];

        proc = cp.spawn(binPath, ['lsp'], {
            stdio: ['pipe', 'pipe', 'pipe'],
            cwd: tmpDir,
        });

        proc.stderr?.on('data', (chunk: Buffer) => {
            // Drain stderr to prevent pipe buffer exhaustion and log in debug
            if (process.env.DEBUG_LSP) {
                console.error(`[real kubescape stderr] ${chunk.toString('utf8')}`);
            }
        });

        proc.stdout?.on('data', (chunk: Buffer) => {
            buffer = Buffer.concat([buffer, chunk]);
            while (true) {
                const headerEnd = buffer.indexOf('\r\n\r\n');
                if (headerEnd === -1) {
                    break;
                }
                const headerStr = buffer.slice(0, headerEnd).toString('ascii');
                const match = /Content-Length:\s*(\d+)/i.exec(headerStr);
                if (!match) {
                    break;
                }
                const contentLength = parseInt(match[1], 10);
                const bodyStart = headerEnd + 4;
                const totalLength = bodyStart + contentLength;
                if (buffer.length < totalLength) {
                    break;
                }
                const body = buffer.slice(bodyStart, totalLength);
                buffer = buffer.slice(totalLength);
                const msg = JSON.parse(body.toString('utf8'));

                if (waiters.length > 0) {
                    const next = waiters.shift()!;
                    next(msg);
                } else {
                    messageQueue.push(msg);
                }
            }
        });
    });

    afterEach(async () => {
        if (proc && proc.exitCode === null && !proc.killed) {
            proc.kill('SIGKILL');
        }
        try {
            await fs.promises.rm(tmpDir, { recursive: true, force: true });
        } catch {
            // ignore
        }
    });

    it('spawns real kubescape lsp, initializes, scans saved manifest, and publishes diagnostics', async () => {
        // Create an insecure Kubernetes Pod manifest
        const manifestPath = path.join(tmpDir, 'insecure-pod.yaml');
        const manifestContent = `apiVersion: v1
kind: Pod
metadata:
  name: test-insecure-pod
spec:
  hostIPC: true
  hostNetwork: true
  hostPID: true
  containers:
  - name: nginx
    image: nginx:latest
    securityContext:
      privileged: true
      allowPrivilegeEscalation: true
      runAsUser: 0
`;
        await fs.promises.writeFile(manifestPath, manifestContent, 'utf8');
        const fileUri = `file://${manifestPath}`;

        // 1. Initialize
        proc.stdin?.write(encodeFrame({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: {
                processId: process.pid,
                rootUri: `file://${tmpDir}`,
                capabilities: {},
            },
        }));

        const initResp = await nextMessage();
        assert.strictEqual(initResp.id, 1);
        assert.ok(initResp.result?.capabilities?.textDocumentSync, 'Server must advertise textDocumentSync');
        assert.strictEqual(initResp.result.capabilities.textDocumentSync.save, true, 'Server must advertise save sync');

        // 2. Initialized notification
        proc.stdin?.write(encodeFrame({
            jsonrpc: '2.0',
            method: 'initialized',
            params: {},
        }));

        // 3. didOpen notification
        proc.stdin?.write(encodeFrame({
            jsonrpc: '2.0',
            method: 'textDocument/didOpen',
            params: {
                textDocument: {
                    uri: fileUri,
                    languageId: 'yaml',
                    version: 1,
                    text: manifestContent,
                },
            },
        }));

        // 4. didSave notification (triggers the Kubescape scan)
        proc.stdin?.write(encodeFrame({
            jsonrpc: '2.0',
            method: 'textDocument/didSave',
            params: {
                textDocument: {
                    uri: fileUri,
                },
            },
        }));

        // 5. Await publishDiagnostics notification
        let diagMsg: any;
        const deadline = Date.now() + 90000;
        while (Date.now() < deadline) {
            const msg = await nextMessage(60000);
            if (msg.method === 'textDocument/publishDiagnostics') {
                diagMsg = msg;
                break;
            }
        }

        assert.ok(diagMsg, 'Expected textDocument/publishDiagnostics notification');
        assert.strictEqual(diagMsg.params?.uri, fileUri);
        const diags = diagMsg.params?.diagnostics;
        assert.ok(Array.isArray(diags), 'Diagnostics should be an array');
        assert.ok(diags.length > 0, `Expected findings for insecure pod, got ${diags.length}`);

        // Verify diagnostic structure adheres to LSP & Kubescape contract
        for (const d of diags) {
            assert.strictEqual(d.source, 'kubescape', 'Diagnostic source must be kubescape');
            assert.ok(typeof d.message === 'string' && d.message.length > 0, 'Message must be non-empty');
            assert.ok(d.code, 'Diagnostic must have a control ID code');
            assert.ok([1, 2, 3].includes(d.severity), `Diagnostic severity must be 1, 2, or 3, got ${d.severity}`);
            assert.ok(d.range && typeof d.range.start.line === 'number', 'Range must have start line');
            assert.ok(typeof d.range.start.character === 'number', 'Range must have start character');
        }

        // 6. Shutdown
        proc.stdin?.write(encodeFrame({
            jsonrpc: '2.0',
            id: 2,
            method: 'shutdown',
        }));

        const shutdownResp = await nextMessage();
        assert.strictEqual(shutdownResp.id, 2);
        assert.strictEqual(shutdownResp.result, null);

        // 7. Exit
        proc.stdin?.write(encodeFrame({
            jsonrpc: '2.0',
            method: 'exit',
        }));

        const exitCode = await new Promise<number | null>((resolve) => {
            proc.on('exit', (code) => resolve(code));
        });
        assert.strictEqual(exitCode, 0);
    });
});

import * as assert from 'assert';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { shouldScanDocumentOnSave } from '../../server/manifestFilter';

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
            if (
                check.status !== 0 ||
                (check.stderr && check.stderr.includes('unknown command')) ||
                !(check.stdout?.toLowerCase().includes('language server') || check.stdout?.includes('kubescape lsp'))
            ) {
                throw new Error(
                    `Found binary at "${found}", but "${found} lsp --help" does not support the LSP command (status ${check.status}): ${check.stderr || check.stdout}`
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

    it('preserves complete multi-resource findings in realistic multi-manifest workspace across save filter (Section 3 Audit)', async () => {
        // Create realistic multi-resource fixtures:
        // 1. ServiceAccount
        const saPath = path.join(tmpDir, 'serviceaccount.yaml');
        const saContent = `apiVersion: v1
kind: ServiceAccount
metadata:
  name: privileged-sa
  namespace: default
`;
        await fs.promises.writeFile(saPath, saContent, 'utf8');

        // 2. ClusterRole with wildcards
        const rolePath = path.join(tmpDir, 'clusterrole.yaml');
        const roleContent = `apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: privileged-cluster-role
rules:
- apiGroups: ["*"]
  resources: ["*"]
  verbs: ["*"]
`;
        await fs.promises.writeFile(rolePath, roleContent, 'utf8');

        // 3. ClusterRoleBinding
        const bindingPath = path.join(tmpDir, 'rolebinding.yaml');
        const bindingContent = `apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: privileged-binding
subjects:
- kind: ServiceAccount
  name: privileged-sa
  namespace: default
roleRef:
  kind: ClusterRole
  name: privileged-cluster-role
  apiGroup: rbac.authorization.k8s.io
`;
        await fs.promises.writeFile(bindingPath, bindingContent, 'utf8');

        // 4. Pod referencing the ServiceAccount
        const podPath = path.join(tmpDir, 'pod.yaml');
        const podContent = `apiVersion: v1
kind: Pod
metadata:
  name: bound-workload
  namespace: default
spec:
  serviceAccountName: privileged-sa
  containers:
  - name: web
    image: nginx
    securityContext:
      privileged: true
      allowPrivilegeEscalation: true
`;
        await fs.promises.writeFile(podPath, podContent, 'utf8');

        // 5. Non-Kubernetes package.json file
        const packageJsonPath = path.join(tmpDir, 'package.json');
        const packageJsonContent = JSON.stringify({ name: 'k8s-project', version: '1.0.0' });
        await fs.promises.writeFile(packageJsonPath, packageJsonContent, 'utf8');

        // 6. Plain config.json (no apiVersion/kind) and kustomization.yaml referencing it
        const indirectConfigPath = path.join(tmpDir, 'app-config.json');
        const indirectConfigContent = JSON.stringify({ insecure: true, debug: false });
        await fs.promises.writeFile(indirectConfigPath, indirectConfigContent, 'utf8');

        const kustomizePath = path.join(tmpDir, 'kustomization.yaml');
        const kustomizeContent = `apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
configMapGenerator:
- name: generated-config
  files:
  - app-config.json
resources:
- pod.yaml
- serviceaccount.yaml
- clusterrole.yaml
- rolebinding.yaml
`;
        await fs.promises.writeFile(kustomizePath, kustomizeContent, 'utf8');

        // Verify Candidate Filter behavior:
        // A. package.json save must be suppressed
        const packageDoc = {
            uri: { scheme: 'file', fsPath: packageJsonPath },
            languageId: 'json',
            fileName: packageJsonPath,
            getText: () => packageJsonContent,
        };
        assert.strictEqual(shouldScanDocumentOnSave(packageDoc), false, 'package.json must be filtered out');

        // B. pod.yaml save must be forwarded
        const podDoc = {
            uri: { scheme: 'file', fsPath: podPath },
            languageId: 'yaml',
            fileName: podPath,
            getText: () => podContent,
        };
        assert.strictEqual(shouldScanDocumentOnSave(podDoc), true, 'pod.yaml must be forwarded as scan candidate');

        // C. app-config.json save must be forwarded as indirect Kustomize dependency
        const indirectDoc = {
            uri: { scheme: 'file', fsPath: indirectConfigPath },
            languageId: 'json',
            fileName: indirectConfigPath,
            getText: () => indirectConfigContent,
        };
        assert.strictEqual(shouldScanDocumentOnSave(indirectDoc), true, 'app-config.json must be forwarded as indirect dependency');

        // 1. Initialize LSP server with multi-resource workspace
        proc.stdin?.write(encodeFrame({
            jsonrpc: '2.0',
            id: 10,
            method: 'initialize',
            params: {
                processId: process.pid,
                rootUri: `file://${tmpDir}`,
                capabilities: {},
            },
        }));

        const initResp = await nextMessage();
        assert.strictEqual(initResp.id, 10);

        // 2. Initialized
        proc.stdin?.write(encodeFrame({
            jsonrpc: '2.0',
            method: 'initialized',
            params: {},
        }));

        // 3. didOpen for pod.yaml
        const podUri = `file://${podPath}`;
        proc.stdin?.write(encodeFrame({
            jsonrpc: '2.0',
            method: 'textDocument/didOpen',
            params: {
                textDocument: {
                    uri: podUri,
                    languageId: 'yaml',
                    version: 1,
                    text: podContent,
                },
            },
        }));

        // Normalization and sorting helpers for deep equivalence verification
        const normalizeDiag = (d: any) => ({
            code: String(d.code),
            message: String(d.message),
            severity: Number(d.severity),
            source: String(d.source),
            href: d.codeDescription?.href ? String(d.codeDescription.href) : undefined,
            startLine: d.range?.start?.line,
            startChar: d.range?.start?.character,
            endLine: d.range?.end?.line,
            endChar: d.range?.end?.character,
        });
        const sortDiags = (arr: any[]) => arr.slice().sort((a, b) =>
            (a.startLine - b.startLine) ||
            (a.startChar - b.startChar) ||
            a.code.localeCompare(b.code) ||
            a.message.localeCompare(b.message)
        );

        // Helper to await diagnostics for a given URI
        const awaitDiagnostics = async (uri: string, timeoutMs = 90000): Promise<any[]> => {
            const deadline = Date.now() + timeoutMs;
            while (Date.now() < deadline) {
                const msg = await nextMessage(60000);
                if (msg.method === 'textDocument/publishDiagnostics' && msg.params?.uri === uri) {
                    return msg.params?.diagnostics || [];
                }
            }
            throw new Error(`Timeout waiting for publishDiagnostics for ${uri}`);
        };

        // 4. Baseline Save (Unfiltered Path):
        // Directly send didSave for pod.yaml as baseline scan
        proc.stdin?.write(encodeFrame({
            jsonrpc: '2.0',
            method: 'textDocument/didSave',
            params: {
                textDocument: { uri: podUri },
            },
        }));

        const rawBaselineDiags = await awaitDiagnostics(podUri);
        assert.ok(Array.isArray(rawBaselineDiags) && rawBaselineDiags.length > 0, 'Baseline must produce security findings');
        const baselineDiags = sortDiags(rawBaselineDiags.map(normalizeDiag));
        assert.ok(baselineDiags.length >= 3, `Expected at least 3 control findings, got ${baselineDiags.length}`);

        // 5. Test Non-Candidate Save (Optimized Path: Suppressed):
        // Verify saving package.json is suppressed and does not emit didSave
        let didSaveTriggeredForNonCandidate = false;
        if (shouldScanDocumentOnSave(packageDoc)) {
            didSaveTriggeredForNonCandidate = true;
            proc.stdin?.write(encodeFrame({
                jsonrpc: '2.0',
                method: 'textDocument/didSave',
                params: {
                    textDocument: { uri: `file://${packageJsonPath}` },
                },
            }));
        }
        assert.strictEqual(didSaveTriggeredForNonCandidate, false, 'Non-candidate package.json must NOT trigger didSave');

        // 6. Test Candidate Save (Optimized Path: Forwarded):
        // Verify saving pod.yaml is evaluated as candidate and forwarded
        let didSaveTriggeredForCandidate = false;
        if (shouldScanDocumentOnSave(podDoc)) {
            didSaveTriggeredForCandidate = true;
            proc.stdin?.write(encodeFrame({
                jsonrpc: '2.0',
                method: 'textDocument/didSave',
                params: {
                    textDocument: { uri: podUri },
                },
            }));
        }
        assert.strictEqual(didSaveTriggeredForCandidate, true, 'Candidate pod.yaml MUST trigger didSave');

        const rawOptimizedDiags = await awaitDiagnostics(podUri);
        const optimizedDiags = sortDiags(rawOptimizedDiags.map(normalizeDiag));

        // 7. Complete Deep Equivalence Check:
        // Confirm the complete normalized diagnostic set is 100% identical between baseline and optimized paths
        assert.deepStrictEqual(optimizedDiags, baselineDiags, 'Optimized scan diagnostics must be 100% identical to baseline diagnostics');

        // 8. Test Indirect Dependency Save via Real LSP:
        // Indirect dependency app-config.json was already verified as forwarded by shouldScanDocumentOnSave(indirectDoc) above.
        // Send didOpen then didSave for indirect dependency to real Kubescape LSP

        // Send didOpen then didSave for indirect dependency to real Kubescape LSP
        proc.stdin?.write(encodeFrame({
            jsonrpc: '2.0',
            method: 'textDocument/didOpen',
            params: {
                textDocument: {
                    uri: `file://${indirectConfigPath}`,
                    languageId: 'json',
                    version: 1,
                    text: indirectConfigContent,
                },
            },
        }));

        proc.stdin?.write(encodeFrame({
            jsonrpc: '2.0',
            method: 'textDocument/didSave',
            params: {
                textDocument: { uri: `file://${indirectConfigPath}` },
            },
        }));

        // Real LSP server must trigger a workspace scan and publish diagnostics
        const rawIndirectDiags = await awaitDiagnostics(podUri);
        const indirectDiags = sortDiags(rawIndirectDiags.map(normalizeDiag));
        assert.deepStrictEqual(indirectDiags, baselineDiags, 'Indirect dependency save must trigger scan preserving full workspace findings');

        // 9. Shutdown & Exit
        proc.stdin?.write(encodeFrame({
            jsonrpc: '2.0',
            id: 20,
            method: 'shutdown',
        }));
        await nextMessage();

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

import * as assert from 'assert';

interface MockLspDiagnostic {
    range: {
        start: { line: number; character: number };
        end: { line: number; character: number };
    };
    severity: number;
    code: string;
    source: string;
    message: string;
}

interface MockPublishDiagnosticsParams {
    uri: string;
    version?: number;
    diagnostics: MockLspDiagnostic[];
}

/**
 * Diagnostic tracking model that mirrors the Language Client's internal diagnostics collection.
 */
class DiagnosticStore {
    private store = new Map<string, MockLspDiagnostic[]>();

    public handlePublishDiagnostics(params: MockPublishDiagnosticsParams): void {
        if (!params.diagnostics || params.diagnostics.length === 0) {
            this.store.delete(params.uri);
        } else {
            this.store.set(params.uri, params.diagnostics);
        }
    }

    public get(uri: string): MockLspDiagnostic[] {
        return this.store.get(uri) || [];
    }

    public has(uri: string): boolean {
        return this.store.has(uri);
    }
}

describe('Diagnostics Handling & Contract Tests', () => {
    let store: DiagnosticStore;

    beforeEach(() => {
        store = new DiagnosticStore();
    });

    it('preserves all severities correctly: Error (1), Warning (2), Information (3)', () => {
        const docUri = 'file:///workspace/pod.yaml';
        const params: MockPublishDiagnosticsParams = {
            uri: docUri,
            version: 1,
            diagnostics: [
                {
                    range: { start: { line: 5, character: 4 }, end: { line: 5, character: 18 } },
                    severity: 1, // Error
                    code: 'C-0017',
                    source: 'kubescape',
                    message: 'Host IPC privilege enabled',
                },
                {
                    range: { start: { line: 12, character: 6 }, end: { line: 12, character: 20 } },
                    severity: 2, // Warning
                    code: 'C-0034',
                    source: 'kubescape',
                    message: 'Service account token is mounted',
                },
                {
                    range: { start: { line: 20, character: 0 }, end: { line: 20, character: 10 } },
                    severity: 3, // Information
                    code: 'C-0055',
                    source: 'kubescape',
                    message: 'Resource limits not configured',
                },
            ],
        };

        store.handlePublishDiagnostics(params);
        const diags = store.get(docUri);
        assert.strictEqual(diags.length, 3);

        assert.strictEqual(diags[0].severity, 1);
        assert.strictEqual(diags[0].code, 'C-0017');
        assert.strictEqual(diags[0].source, 'kubescape');
        assert.strictEqual(diags[0].message, 'Host IPC privilege enabled');
        assert.deepStrictEqual(diags[0].range, { start: { line: 5, character: 4 }, end: { line: 5, character: 18 } });

        assert.strictEqual(diags[1].severity, 2);
        assert.strictEqual(diags[1].code, 'C-0034');

        assert.strictEqual(diags[2].severity, 3);
        assert.strictEqual(diags[2].code, 'C-0055');
    });

    it('clears diagnostics when empty diagnostics list is published', () => {
        const docUri = 'file:///workspace/deployment.yaml';
        store.handlePublishDiagnostics({
            uri: docUri,
            version: 1,
            diagnostics: [
                {
                    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 10 } },
                    severity: 1,
                    code: 'C-0017',
                    source: 'kubescape',
                    message: 'Fix required',
                },
            ],
        });
        assert.strictEqual(store.get(docUri).length, 1);

        // Scan after fix returns clean (empty list)
        store.handlePublishDiagnostics({
            uri: docUri,
            version: 2,
            diagnostics: [],
        });
        assert.strictEqual(store.get(docUri).length, 0);
        assert.strictEqual(store.has(docUri), false);
    });

    it('updates and replaces diagnostics on subsequent scan versions', () => {
        const docUri = 'file:///workspace/service.yaml';
        store.handlePublishDiagnostics({
            uri: docUri,
            version: 1,
            diagnostics: [
                {
                    range: { start: { line: 1, character: 0 }, end: { line: 1, character: 5 } },
                    severity: 1,
                    code: 'C-0001',
                    source: 'kubescape',
                    message: 'Initial issue',
                },
            ],
        });

        // Second scan has a different issue
        store.handlePublishDiagnostics({
            uri: docUri,
            version: 2,
            diagnostics: [
                {
                    range: { start: { line: 8, character: 2 }, end: { line: 8, character: 15 } },
                    severity: 2,
                    code: 'C-0002',
                    source: 'kubescape',
                    message: 'Subsequent issue',
                },
            ],
        });

        const current = store.get(docUri);
        assert.strictEqual(current.length, 1);
        assert.strictEqual(current[0].code, 'C-0002');
        assert.strictEqual(current[0].message, 'Subsequent issue');
    });

    it('tracks diagnostics independently across multiple open documents', () => {
        const doc1 = 'file:///workspace/pod1.yaml';
        const doc2 = 'file:///workspace/pod2.yaml';

        store.handlePublishDiagnostics({
            uri: doc1,
            diagnostics: [
                {
                    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
                    severity: 1,
                    code: 'C-0017',
                    source: 'kubescape',
                    message: 'Doc 1 error',
                },
            ],
        });

        store.handlePublishDiagnostics({
            uri: doc2,
            diagnostics: [
                {
                    range: { start: { line: 2, character: 0 }, end: { line: 2, character: 5 } },
                    severity: 2,
                    code: 'C-0034',
                    source: 'kubescape',
                    message: 'Doc 2 warning',
                },
            ],
        });

        assert.strictEqual(store.get(doc1).length, 1);
        assert.strictEqual(store.get(doc1)[0].message, 'Doc 1 error');

        assert.strictEqual(store.get(doc2).length, 1);
        assert.strictEqual(store.get(doc2)[0].message, 'Doc 2 warning');

        // Clearing doc1 leaves doc2 unaffected
        store.handlePublishDiagnostics({ uri: doc1, diagnostics: [] });
        assert.strictEqual(store.get(doc1).length, 0);
        assert.strictEqual(store.get(doc2).length, 1);
    });
});

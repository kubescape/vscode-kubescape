import * as assert from 'assert';
import { FORCE_SAVE_COMMAND, saveToTriggerScan } from '../../scanYaml';
import {
    forceScanForDocument,
    clearForcedScan,
    isScanForcedForDocument,
    shouldScanDocumentOnSave,
    resetForceScanState,
    ScannableDocument
} from '../../server/manifestFilter';

/**
 * A document that records how it was saved, like a TextDocument whose save()
 * does nothing when it has no unsaved changes.
 */
function fakeDocument(isDirty: boolean, uri = 'file:///workspace/test.yaml') {
    const calls: string[] = [];
    const document = {
        isDirty,
        fileName: uri.replace('file://', ''),
        uri: { scheme: 'file', fsPath: uri.replace('file://', ''), toString: () => uri },
        save: async () => {
            calls.push('document.save');
            return true;
        },
    };
    const executeCommand = async (command: string) => {
        calls.push(command);
    };
    return { document, executeCommand, calls };
}

describe('Kubescape: Scan YAML', () => {
    beforeEach(() => {
        resetForceScanState();
    });

    afterEach(() => {
        resetForceScanState();
    });

    it('saves a document without unsaved changes with the command Ctrl+S runs', async () => {
        const { document, executeCommand, calls } = fakeDocument(false);
        await saveToTriggerScan(document, executeCommand);
        // TextDocument.save() would write nothing here, so no didSave would reach the server.
        assert.deepStrictEqual(calls, [FORCE_SAVE_COMMAND]);
        assert.strictEqual(FORCE_SAVE_COMMAND, 'workbench.action.files.save');
    });

    it('saves a document with unsaved changes directly', async () => {
        const { document, executeCommand, calls } = fakeDocument(true);
        const result = await saveToTriggerScan(document, executeCommand);
        assert.deepStrictEqual(calls, ['document.save']);
        assert.strictEqual(result, true);
    });

    it('returns false when document.save() fails or cancels', async () => {
        const document = {
            isDirty: true,
            save: async () => false,
        };
        const executeCommand = async () => {};
        const result = await saveToTriggerScan(document, executeCommand);
        assert.strictEqual(result, false);
    });

    describe('Save Lifecycle Verification (Finding A1)', () => {
        it('preserves successful clean-document save when workbench command returns void/undefined and didSave fires', async () => {
            const { document, calls } = fakeDocument(false, 'file:///workspace/clean.yaml');
            let listenerCallback: ((doc: any) => void) | null = null;
            const onDidSaveTextDocument = (listener: (doc: any) => void) => {
                listenerCallback = listener;
                return { dispose: () => { listenerCallback = null; } };
            };

            const executeCommand = async (cmd: string) => {
                calls.push(cmd);
                // Simulate VS Code firing onDidSaveTextDocument while executeCommand runs
                listenerCallback?.(document);
                return undefined; // VS Code save command returns void (undefined)
            };

            const result = await saveToTriggerScan(document, executeCommand, onDidSaveTextDocument);
            assert.strictEqual(result, true, 'Clean document save returning void must succeed when matching didSave fires');
            assert.deepStrictEqual(calls, [FORCE_SAVE_COMMAND]);
        });

        it('returns false for read-only or unsuccessful save when command returns false', async () => {
            const { document } = fakeDocument(false, 'file:///workspace/readonly.yaml');
            const onDidSaveTextDocument = () => ({ dispose: () => {} });
            const executeCommand = async () => false;

            const result = await saveToTriggerScan(document, executeCommand, onDidSaveTextDocument);
            assert.strictEqual(result, false, 'Unsuccessful save returning false must report failure');
        });

        it('returns false when save command returns void/undefined but no matching didSave event occurs', async () => {
            const { document } = fakeDocument(false, 'file:///workspace/failed.yaml');
            const onDidSaveTextDocument = () => ({ dispose: () => {} });
            // Command completes with void, but document was read-only/error so didSave never fired
            const executeCommand = async () => undefined;

            const result = await saveToTriggerScan(document, executeCommand, onDidSaveTextDocument);
            assert.strictEqual(result, false, 'Save must report failure if no matching didSave occurred');
        });

        it('returns false when didSave fires for an unrelated document', async () => {
            const { document } = fakeDocument(false, 'file:///workspace/target.yaml');
            let listenerCallback: ((doc: any) => void) | null = null;
            const onDidSaveTextDocument = (listener: (doc: any) => void) => {
                listenerCallback = listener;
                return { dispose: () => { listenerCallback = null; } };
            };

            const executeCommand = async () => {
                // Fire didSave for a different document
                listenerCallback?.({
                    fileName: '/workspace/other.yaml',
                    uri: { scheme: 'file', fsPath: '/workspace/other.yaml', toString: () => 'file:///workspace/other.yaml' }
                });
                return undefined;
            };

            const result = await saveToTriggerScan(document, executeCommand, onDidSaveTextDocument);
            assert.strictEqual(result, false, 'didSave for a different document must not satisfy target save');
        });

        it('ensures a later ordinary save is evaluated normally after a failed manual attempt', async () => {
            const genericDoc: ScannableDocument = {
                fileName: '/workspace/config.json',
                languageId: 'json',
                uri: { scheme: 'file', fsPath: '/workspace/config.json', toString: () => 'file:///workspace/config.json' },
                getText: () => JSON.stringify({ key: 'val' }),
            };

            // 1. User attempts manual scan, arming override
            const overrideKey = forceScanForDocument(genericDoc);
            assert.strictEqual(isScanForcedForDocument(genericDoc), true);

            // 2. Save fails (no didSave), so scanYaml caller cleans up the pending override
            const onDidSaveTextDocument = () => ({ dispose: () => {} });
            const saved = await saveToTriggerScan(
                { isDirty: false, fileName: genericDoc.fileName, uri: genericDoc.uri, save: async () => false },
                async () => undefined,
                onDidSaveTextDocument
            );
            assert.strictEqual(saved, false);
            if (!saved) {
                clearForcedScan(overrideKey);
            }

            // 3. Override is revoked and no longer active
            assert.strictEqual(isScanForcedForDocument(genericDoc), false);

            // 4. Later ordinary save arrives: must be evaluated by normal heuristics and suppressed
            const shouldScan = shouldScanDocumentOnSave(genericDoc);
            assert.strictEqual(shouldScan, false, 'Ordinary save after failed manual attempt must not be forced');
        });
    });
});

import * as assert from 'assert';
import { FORCE_SAVE_COMMAND, saveToTriggerScan } from '../../scanYaml';
import {
    armForcedScan,
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

const noopOnDidSave = () => ({ dispose: () => {} });

/**
 * A fake onDidSaveTextDocument whose listeners can be fired by the test.
 */
function fakeSaveEvents() {
    const listeners = new Set<(doc: any) => void>();
    return {
        onDidSave: (listener: (doc: any) => void) => {
            listeners.add(listener);
            return { dispose: () => { listeners.delete(listener); } };
        },
        fire: (doc: any) => listeners.forEach((l) => l(doc)),
        count: () => listeners.size,
    };
}

describe('Kubescape: Scan YAML', () => {
    beforeEach(() => {
        resetForceScanState();
    });

    afterEach(() => {
        resetForceScanState();
    });

    it('saves a document without unsaved changes with the command Ctrl+S runs', async () => {
        const { document, calls } = fakeDocument(false);
        const events = fakeSaveEvents();
        const executeCommand = async (command: string) => {
            calls.push(command);
            events.fire(document);
        };
        await saveToTriggerScan(document, executeCommand, events.onDidSave);
        // TextDocument.save() would write nothing here, so no didSave would reach the server.
        assert.deepStrictEqual(calls, [FORCE_SAVE_COMMAND]);
        assert.strictEqual(FORCE_SAVE_COMMAND, 'workbench.action.files.save');
    });

    it('saves a document with unsaved changes directly', async () => {
        const { document, executeCommand, calls } = fakeDocument(true);
        const result = await saveToTriggerScan(document, executeCommand, noopOnDidSave);
        assert.deepStrictEqual(calls, ['document.save']);
        assert.strictEqual(result, true);
    });

    it('returns false when document.save() fails or cancels', async () => {
        const document = {
            isDirty: true,
            save: async () => false,
        };
        const executeCommand = async () => {};
        const result = await saveToTriggerScan(document, executeCommand, noopOnDidSave);
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

        it('returns false and disposes the listener when the save command rejects', async () => {
            const { document } = fakeDocument(false, 'file:///workspace/reject.yaml');
            const events = fakeSaveEvents();
            const executeCommand = async () => {
                throw new Error('save failed');
            };
            await assert.rejects(
                saveToTriggerScan(document, executeCommand, events.onDidSave),
                /save failed/
            );
            assert.strictEqual(events.count(), 0, 'Listener must be disposed after rejection');
        });

        it('registers the listener before the command runs and counts a didSave that arrives before the command resolves', async () => {
            const { document } = fakeDocument(false, 'file:///workspace/early.yaml');
            const events = fakeSaveEvents();
            let listenersAtCommandStart = -1;
            let resolveCommand!: () => void;
            const executeCommand = () => {
                listenersAtCommandStart = events.count();
                return new Promise<undefined>((resolve) => {
                    resolveCommand = () => resolve(undefined);
                });
            };

            const pending = saveToTriggerScan(document, executeCommand, events.onDidSave);
            assert.strictEqual(listenersAtCommandStart, 1, 'Listener must be registered before the command is invoked');
            events.fire(document); // didSave first ...
            resolveCommand(); // ... command resolves afterwards, with void
            assert.strictEqual(await pending, true);
            assert.strictEqual(events.count(), 0);
        });

        it('ignores a didSave for a different URI even when it fires before the command resolves', async () => {
            const { document } = fakeDocument(false, 'file:///workspace/mine.yaml');
            const events = fakeSaveEvents();
            const executeCommand = async () => {
                events.fire({
                    fileName: '/workspace/other.yaml',
                    uri: { scheme: 'file', fsPath: '/workspace/other.yaml', toString: () => 'file:///workspace/other.yaml' },
                });
                return undefined;
            };
            assert.strictEqual(await saveToTriggerScan(document, executeCommand, events.onDidSave), false);
        });

        it('does not let a revoked or consumed attempt disturb a newer attempt after a failed save', async () => {
            const doc: ScannableDocument = {
                fileName: '/workspace/overlap.json',
                languageId: 'json',
                uri: { scheme: 'file', fsPath: '/workspace/overlap.json', toString: () => 'file:///workspace/overlap.json' },
                getText: () => '{"k":1}',
            };
            const older = armForcedScan(doc, 'owner');
            const newer = armForcedScan(doc, 'owner');
            older.revoke(); // e.g. older invocation's save produced no didSave
            assert.strictEqual(isScanForcedForDocument(doc, 'owner'), true);
            assert.strictEqual(newer.isActive, true);
            newer.complete();
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

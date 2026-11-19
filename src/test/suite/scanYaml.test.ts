import * as assert from 'assert';
import { FORCE_SAVE_COMMAND, saveToTriggerScan } from '../../scanYaml';

/**
 * A document that records how it was saved, like a TextDocument whose save()
 * does nothing when it has no unsaved changes.
 */
function fakeDocument(isDirty: boolean) {
    const calls: string[] = [];
    const document = {
        isDirty,
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
    it('saves a document without unsaved changes with the command Ctrl+S runs', async () => {
        const { document, executeCommand, calls } = fakeDocument(false);
        await saveToTriggerScan(document, executeCommand);
        // TextDocument.save() would write nothing here, so no didSave would reach the server.
        assert.deepStrictEqual(calls, [FORCE_SAVE_COMMAND]);
        assert.strictEqual(FORCE_SAVE_COMMAND, 'workbench.action.files.save');
    });

    it('saves a document with unsaved changes directly', async () => {
        const { document, executeCommand, calls } = fakeDocument(true);
        await saveToTriggerScan(document, executeCommand);
        assert.deepStrictEqual(calls, ['document.save']);
    });
});

/**
 * The part of a VS Code text document the "Kubescape: Scan YAML" command uses.
 */
export interface SavableDocument {
    readonly isDirty: boolean;
    save(): PromiseLike<boolean>;
}

/**
 * The VS Code command Ctrl+S runs. It saves the active editor even when it has
 * no unsaved changes.
 */
export const FORCE_SAVE_COMMAND = 'workbench.action.files.save';

/**
 * Saves the active document so that the language server, which scans on
 * didSave, scans it.
 *
 * TextDocument.save() writes nothing for a document without unsaved changes,
 * so VS Code sends no didSave and nothing is scanned. Such a document is saved
 * with the command Ctrl+S runs instead, which writes it anyway.
 */
export async function saveToTriggerScan(
    document: SavableDocument,
    executeCommand: (command: string) => PromiseLike<unknown>
): Promise<boolean> {
    if (document.isDirty) {
        return Boolean(await document.save());
    }
    const res = await executeCommand(FORCE_SAVE_COMMAND);
    return res !== false;
}

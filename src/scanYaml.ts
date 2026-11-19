import { getDocumentKey } from './server/manifestFilter';

/**
 * The part of a VS Code text document the "Kubescape: Scan YAML" command uses.
 */
export interface SavableDocument {
    readonly isDirty: boolean;
    readonly uri?: { scheme: string; fsPath?: string; path?: string; toString?(): string };
    readonly fileName?: string;
    save(): PromiseLike<boolean>;
}

/**
 * Event listener registration interface matching vscode.workspace.onDidSaveTextDocument.
 */
export type DidSaveListener = (listener: (doc: any) => void) => { dispose(): void };

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
 *
 * When onDidSaveTextDocument is provided, the function verifies that a matching
 * didSave event actually occurred for the document, rather than assuming a void
 * return from workbench.action.files.save implies success.
 */
export async function saveToTriggerScan(
    document: SavableDocument,
    executeCommand: (command: string) => PromiseLike<unknown>,
    onDidSaveTextDocument?: DidSaveListener
): Promise<boolean> {
    if (document.isDirty) {
        return Boolean(await document.save());
    }

    if (onDidSaveTextDocument) {
        let saved = false;
        const targetKey = getDocumentKey(document as any);
        const sub = onDidSaveTextDocument((savedDoc) => {
            if (getDocumentKey(savedDoc) === targetKey) {
                saved = true;
            }
        });
        try {
            const res = await executeCommand(FORCE_SAVE_COMMAND);
            if (res === false) {
                return false;
            }
            return saved;
        } finally {
            sub.dispose();
        }
    }

    const res = await executeCommand(FORCE_SAVE_COMMAND);
    return res !== false;
}

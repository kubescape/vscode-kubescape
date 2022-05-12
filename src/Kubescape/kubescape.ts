import * as vscode from 'vscode'

import * as scan from './scan'

import { Logger } from '../utils/log'

export async function scanYaml() {
    const currentFile = vscode.window.activeTextEditor
    if (!currentFile) {
        Logger.error("Could not locate open directories")
        return
    }

    if (currentFile.document.languageId !== "yaml") {
        Logger.error("Not an YAML configuration file");
        return;
    }

    scan.kubescapeScanYaml(currentFile.document, true)
}
import * as vscode from 'vscode'

import * as install from './install'
import * as scan from './scan'
import * as contextHelper from '../utils/context'

import { Logger } from '../utils/log'

export async function doctor() {
    let kubescapeBinaryInfo = await install.isKubescapeInstalled();
    if (!kubescapeBinaryInfo.isInPath) {
        if (kubescapeBinaryInfo.location == "") {
            let options : string[] = ["Yes", "No"]
            vscode.window.showInformationMessage("Kubescape is not installed, install now?", ...options).then(selected => {
                switch (selected) {
                    case options[0]:
                        /* Install kubescape */
                        install.ensureKubescapeTool() 
                        break;
                    case options[1]:
                        break;
                    default: break;
                }
             })
            return;
        } else {
            Logger.warning(`Kubescape is found at ${kubescapeBinaryInfo.location}, but not in system path`, true);
        }
    } else {
        Logger.debug('Kubescape is installed correctly', true);
    }
}

export async function scanYaml() {
    const context = contextHelper.getExtensionContext()
    if (!context)
    {
        Logger.debug("Extension context is not properly loaded")
        return
    }
    
    const currentFile = vscode.window.activeTextEditor
    if (!currentFile) {
        Logger.error("Could not locate open directories")
        return
    }

    if (currentFile.document.languageId !== "yaml") {
        Logger.error("Not an YAML configuration file");
        return;
    }

    scan.kubescapeScanYaml(currentFile.document.uri.fsPath, "nsa", true)
}
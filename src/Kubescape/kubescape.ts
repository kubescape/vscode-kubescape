import * as vscode from 'vscode'

import * as install from './install'
import * as scan from './scan'
import * as logger from '../utils/log'
import * as contextHelper from '../utils/context'

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
            logger.logWarning(`Kubescape is found at ${kubescapeBinaryInfo.location}, but not in system path`);
        }
    } else {
        logger.logDebug('Kubescape is installed correctly');
    }
}

export async function scanYaml() {
    const context = contextHelper.getExtensionContext()
    if (!context)
    {
        logger.logDebug("Extension context is not properly loaded")
        return
    }
    
    const currentFile = vscode.window.activeTextEditor
    if (!currentFile) {
        logger.logError("Could not locate open directories")
        return
    }

    if (!currentFile.document.fileName.includes(".yaml")) {
        logger.logError("Not an YAML configuration file", true);
        return;
    }

    scan.kubescapeScanYaml(currentFile.document.uri.fsPath, "nsa")
}
import * as vscode from 'vscode'

import { AbortController } from 'abort-controller';


import * as install from './install'
import * as scan from './scan'
import * as info from './info'

import { Logger } from '../utils/log'

export async function doctor() {
    let kubescapeBinaryInfo = await install.isKubescapeInstalled();
    if (!kubescapeBinaryInfo.isInstalled) {
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
        Logger.debug('Kubescape is installed correctly', true);
    }
}

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

    scan.kubescapeScanYaml(currentFile.document.uri.fsPath, "nsa", true)
}

export async function listAvailableFrameworks() {

    let cancel = new AbortController()
    vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: "Listing supported frameworks",
        cancellable: cancel !== null
    }, async (_, canc) => {
        if (cancel) {
            canc.onCancellationRequested(()=>{
                cancel.abort()
            })
        }
        let frameworks = await info.getAvailableFrameworks()

        if (frameworks.length) {

            vscode.window.showQuickPick(frameworks).then(picked => {
                if (picked) {
                    vscode.env.clipboard.writeText(picked)
                    Logger.info(`${picked} has been copied to clipboard`, true)
                }
            })
        }

    })
}
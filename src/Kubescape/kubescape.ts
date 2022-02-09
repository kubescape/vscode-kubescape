import * as vscode from 'vscode'
import { AbortController } from 'abort-controller'

import * as install from './install'
import * as scan from './scan'
import * as info from './info'
import * as kubescapeConfig from './config'
import * as ui from '../utils/ui'

import { Logger } from '../utils/log'
import { CONFIG_VERSION_TIER, ERROR_KUBESCAPE_NOT_INSTALLED } from './globals';

export async function doctor() {
    let kubescapeBinaryInfo = info.KubescapeBinaryInfo.instance
    if (!kubescapeBinaryInfo.isInstalled) {
        let options : string[] = ["Yes", "No"]
        vscode.window.showInformationMessage("Kubescape is not installed, install now?", ...options).then(selected => {
            switch (selected) {
                case options[0]:
                    /* Choose between version tiers */
                    const config = kubescapeConfig.getKubescapeConfig()
                    const needsLatest = config[CONFIG_VERSION_TIER] && config[CONFIG_VERSION_TIER] === "latest"
                    install.updateKubescape(needsLatest)
                    break;
                case options[1]:
                    break;
                default: break;
            }
         })
        return;
    } else {
        Logger.debug(`Kubescape is installed correctly ${kubescapeBinaryInfo.version} (${kubescapeBinaryInfo.isLatestVersion ? 'latest' : 'stable'})`, true);
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

    scan.kubescapeScanYaml(currentFile.document, true)
}

export async function installFromAvailableFrameworks() {

    const kubescapeBinaryInfo = info.KubescapeBinaryInfo.instance
    if (!kubescapeBinaryInfo.isInstalled) {
        Logger.error(ERROR_KUBESCAPE_NOT_INSTALLED, true)
        return
    }

    const cancel = new AbortController
    ui.progress("Checking for available frameworks", cancel, false, async ()=>{
        const availableFrameworks = await kubescapeBinaryInfo.getUninstalledFramework()
        if (availableFrameworks.length) {
            vscode.window.showQuickPick(availableFrameworks).then(picked => {
                if (picked) {
                    kubescapeBinaryInfo.installFrameworks([picked])
                }
            })
        } else {
            Logger.info("All available frameworks are installed.", true)
        }
    })   
}
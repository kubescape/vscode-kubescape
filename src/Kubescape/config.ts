import vscode = require('vscode');

import * as path from 'path'

import { expend } from '../utils/path'
import { getExtensionContext } from '../utils/context'
import { PACKAGE_STABLE_BUILD } from './globals';

const CONFIG_SCAN_ON_SAVE = "scanOnSave"
const CONFIG_SCAN_FRAMEWORKS = "scanFrameworks"
const CONFIG_REQUIRED_FRAMEWORKS = "requiredFrameworks"
const CONFIG_DIR_PATH = "dirPath"
const CONFIG_VERSION_TIER = "versionTier"
const CONFIG_CUSTOM_FRAMEWORKS_DIR = "customFrameworksDir"

export class KubescapeConfig {
    private static _instance: KubescapeConfig = new KubescapeConfig();

    private configuration : vscode.WorkspaceConfiguration

    private constructor() {
        if (!KubescapeConfig._instance) {
            KubescapeConfig._instance = this
        }

        this.configuration = vscode.workspace.getConfiguration('kubescape')
    }

    static get instance() : KubescapeConfig {
        return this._instance
    }

    get kubescapeDir(): string {

        /* Enable override from configuration */
        if (this.configuration[CONFIG_DIR_PATH]) {
            return expend(this.configuration[CONFIG_DIR_PATH])
        }

        const extensionContext = getExtensionContext()
        if (!extensionContext) {
            throw new Error("The extension is not loaded properly!")
        }

        return path.join(extensionContext.extensionPath, "install")
    }

    get scanOnSave(): boolean {
        return !!this.configuration[CONFIG_SCAN_ON_SAVE] && 
            this.configuration[CONFIG_SCAN_ON_SAVE] !== "none"
    }

    get kubescapeVersion(): string {
        if (this.configuration[CONFIG_VERSION_TIER] && 
            this.configuration[CONFIG_VERSION_TIER] === "latest") return "latest"
        
        return PACKAGE_STABLE_BUILD
    }

    get scanFrameworks() : string[] {
        if (this.configuration[CONFIG_SCAN_FRAMEWORKS]) {
            return this.configuration[CONFIG_SCAN_FRAMEWORKS]
        }

        return ['all']
    }

    get requiredFrameworks() : string[] {
        if (this.configuration[CONFIG_REQUIRED_FRAMEWORKS]) {
            return this.configuration[CONFIG_REQUIRED_FRAMEWORKS]
        }

        return ['all']
    }

    get customFrameworkDirectory() : string | undefined {
        const fDir = this.configuration[CONFIG_CUSTOM_FRAMEWORKS_DIR]
        if (fDir && fDir.length > 0) {
            /* Get custom frameworks from specified directories */
            return expend(fDir)
        } 
    
        return undefined
    }
}

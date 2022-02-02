import * as vscode from 'vscode'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import * as stream from 'stream'

import fetch from 'node-fetch'

import { exec } from 'child_process'
import { AbortController } from 'abort-controller';
import { promisify } from 'util'


import * as kubescapeConfig  from './config'

import { Logger } from '../utils/log' 
import { expend } from '../utils/path' 
import { getExtensionContext } from '../utils/context'
import { 
    PACKAGE_NAME, 
    PACKAGE_BASE_URL, 
    IS_WINDOWS, 
    CONFIG_DIR_PATH, 
    CONFIG_VERSION_TIER, 
    PACKAGE_DOWNLOAD_BASE_URL, 
    PACKAGE_STABLE_BUILD 
} from './globals'
import { getKubescapeVersion, KubescapeVersion } from './info'

export class KubescapeBinaryInfo {
    isInstalled : boolean
    path : string

    constructor() {
        this.isInstalled = false
        this.path = ""
    }
}

async function downloadFile(url : string, downloadPath : string, fileName : string, executable = false) : Promise<string> {
    let localPath = path.resolve(__dirname, downloadPath, fileName)
    try {
        let cancel = new AbortController()
        const opts =
        {
            location: vscode.ProgressLocation.Notification,
            cancellable: cancel !== null,
            title: 'Downloading Kubescape tool'
        }

        await vscode.window.withProgress(opts, async (progress, canc) => {
            if (cancel) {
                canc.onCancellationRequested((_) => cancel.abort());
            }

            const response = await fetch(url, { signal: cancel.signal })
            if (!response.ok || !response.body) {
                Logger.error(`Failed to download ${url}`)
                throw new Error
            }

            const size = Number(response.headers.get('content-length'))

            let read = 0;
            let lastFraction = 0;

            response.body.on('data', (chunk: Buffer) => {
                read += chunk.length
                const fraction = read / size
                if (fraction > lastFraction) {
                    progress.report({
                        message: 'Downloading...',
                        increment: 100 * (fraction - lastFraction)
                    })
                    lastFraction = fraction
                }
            })

            const out = fs.createWriteStream(localPath)
            await promisify(stream.pipeline)(response.body, out).catch(e => {
                fs.unlink(localPath, (_) => null)
                throw new Error
            })


            if (executable) {
                await fs.promises.chmod(localPath, fs.constants.S_IRWXU | fs.constants.S_IRWXG | fs.constants.S_IXOTH)
            }
            Logger.info(`Successfully downloaded ${fileName} into ${downloadPath}`, true)
        })
    } catch {
        Logger.error(`Could not download ${url}`, true);
        localPath = ""
    } finally {
        return localPath
    }

}

async function getKubescapePath() : Promise<string> {
    /* Enable override from configuration */
    let kubescape_dir : string = await new Promise<string>(resolve => {
        const textEditor = vscode.window.activeTextEditor
        if (textEditor)
        {
            const config = kubescapeConfig.getKubescapeConfig(textEditor.document.uri)
            if (config[CONFIG_DIR_PATH]) {
                let dir = expend(config[CONFIG_DIR_PATH])
    
                fs.stat(dir, err => {
                    if (!err) { 
                        resolve(dir)
                    } 
                    Logger.error(`The path ${dir} does not exists and therefore ignored`)
                    resolve("")
                })
            }
        }
        resolve("")
    })

    return new Promise<string>(resolve => {
        if (kubescape_dir.length <= 0) {
            const extensioContext = getExtensionContext()
            if (!extensioContext) {
                Logger.error("The extension is not loaded properly!", true)
                throw new Error
            } else {
                kubescape_dir = path.join(extensioContext.extensionPath, "install")
                fs.promises.mkdir(kubescape_dir, {recursive : true})
                resolve(kubescape_dir)
            }
        }
    })
}

async function getLetestVersionUrl() {
    let res = await fetch(PACKAGE_BASE_URL)
    let obj = await res.json()
    return obj.html_url.replace("/tag/", "/download/")
}

export async function isKubescapeInstalled() : Promise<KubescapeBinaryInfo> {
    const localPath = await getKubescapePath();
    const platform = os.platform();
    const kubescapeName = "kubescape" + (platform == "win32" ? ".exe" : "");
    const searchedPath = expend(localPath + "/" + kubescapeName)

    return new Promise<KubescapeBinaryInfo>(resolve => {
        let binayInfo = new KubescapeBinaryInfo()
        fs.stat(searchedPath, err => {
            if (!err) {
                binayInfo.isInstalled = true
                binayInfo.path = searchedPath
            }
            resolve(binayInfo)
        })
    })
}

export async function ensureKubescapeTool() {
    let kubescapeBinaryInfo = await isKubescapeInstalled()

    let needsUpdate = !kubescapeBinaryInfo.isInstalled

    /* Choose between version tiers */
    const config = kubescapeConfig.getKubescapeConfig()
    const needsLatest = config[CONFIG_VERSION_TIER] && config[CONFIG_VERSION_TIER] === "latest"

    if (!needsUpdate) {
        const kubescapeVersion = await getKubescapeVersion()

        /* kubescape exists - check letest version */
        needsUpdate = kubescapeVersion.isLatest != needsLatest

        if (!needsUpdate && !needsLatest) {
            /* not latest version - verify stable version  */
            needsUpdate = kubescapeVersion.version !== PACKAGE_STABLE_BUILD
        } 
    }

    if (needsUpdate) {

        /* set download url */
        let binaryUrl: string

        /* platform information */
        let pkg = vscode.extensions.getExtension(PACKAGE_NAME)?.packageJSON;
        let pp = pkg.config.platformPackages;
        let platform = os.platform();
        let platformPackage = pp.platforms[platform];
        if (platformPackage == undefined) {
            Logger.error(`Platform '${platform}' is not supported`, true);
            return false;
        }

        if (needsLatest) {
            binaryUrl = await getLetestVersionUrl();
        } else {
            binaryUrl = `${PACKAGE_DOWNLOAD_BASE_URL}/${PACKAGE_STABLE_BUILD}`
        }

        binaryUrl += `/${platformPackage}`


        let kubescapeDir = await getKubescapePath()

        const kubescapeName = "kubescape" + (IS_WINDOWS ? ".exe" : "");
        const kubescapeFullPath = await downloadFile(binaryUrl, kubescapeDir, kubescapeName, !IS_WINDOWS);
        if (kubescapeFullPath.length > 0) {
            kubescapeBinaryInfo.isInstalled = true
        }
    }

    return kubescapeBinaryInfo.isInstalled
}

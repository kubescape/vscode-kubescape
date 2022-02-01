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
import { PACKAGE_NAME, PACKAGE_BASE_URL, IS_WINDOWS, CONFIG_DIR_PATH } from './globals'

export class KubescapeBinaryInfo {
    isInPath : boolean
    location : string

    constructor() {
        this.isInPath = false
        this.location = ""
    }
}

export var kubescapeBinaryInfo : KubescapeBinaryInfo;

async function downloadFile(url : string, downloadPath : string, fileName : string, executable = false) : Promise<string> {
    let localPath = path.resolve(__dirname, downloadPath, fileName)
    try {
        let cancel = new AbortController()
        const opts =
        {
            location: vscode.ProgressLocation.Notification,
            cancellable: cancel !== null,
            title: 'Downloading Kubescape latest version'
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

            response.body.on('data', (chunk: Buffer) => {
                read += chunk.length
                progress.report({
                    message: 'Downloading...',
                    increment: read / size
                })
            })

            const out = fs.createWriteStream(localPath)
            await promisify(stream.pipeline)(response.body, out).catch(e => {
                fs.unlink(localPath, (_) => null)
                throw new Error
            })


            if (executable) {
                fs.chmod(
                    localPath,
                    fs.constants.S_IRWXU | fs.constants.S_IRWXG | fs.constants.S_IXOTH,
                    () => { }
                )
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

function getKubescapePath() {
    let kubescape_dir = path.join(os.homedir(), ".kubescape")

    /* override from configuration */
    const textEditor = vscode.window.activeTextEditor
    if (textEditor)
    {
        const config = kubescapeConfig.getKubescapeConfig(textEditor.document.uri)
		if (config[CONFIG_DIR_PATH]) {
            kubescape_dir = expend(config[CONFIG_DIR_PATH])
		}
    }

    fs.stat(kubescape_dir, (err) => {
        if (err) {
            fs.mkdir(kubescape_dir, { recursive: true }, () => { })
        }
    })

    return kubescape_dir
}

async function getPlatformPackageUrl(platformPackage : string) {
    let res = await fetch(PACKAGE_BASE_URL)
    let obj = await res.json()
    return obj.html_url.replace("/tag/", "/download/") + "/" + platformPackage
}

// It might be better to download to context.extensionPath
export async function isKubescapeInstalled() : Promise<KubescapeBinaryInfo> {
    return new Promise((resolve, _) => {
        let result = new KubescapeBinaryInfo()

        let searchProg : string
        if (IS_WINDOWS) {
            searchProg = 'where'
        } else {
            searchProg = 'which'
        }

        exec(`${searchProg} kubescape`, async (err, stdout, stderr) => {
            if (err) {
                Logger.debug("Kubescape in not in system path");

                // Check if kubescape is in the default path
                const localPath = getKubescapePath();
                const platform = os.platform();
                const kubescapeName = "kubescape" + (platform == "win32" ? ".exe" : "");

                const searchedPath = expend(localPath + "/" + kubescapeName)
                fs.stat(searchedPath, (err) => {
                    if (!err) {
                        result.location = searchedPath
                    }
                    resolve(result);
                })
            } else {
                result.isInPath = true
                result.location = stdout.trimEnd()
                resolve(result);
            }
        })
    })
}

export async function ensureKubescapeTool() {
    kubescapeBinaryInfo = await isKubescapeInstalled();

    if (!kubescapeBinaryInfo.isInPath && kubescapeBinaryInfo.location == "") {
        let pkg = vscode.extensions.getExtension(PACKAGE_NAME)?.packageJSON;
        let pp = pkg.config.platformPackages;
        let platform = os.platform();
        let platformPackage = pp.platforms[platform];
        if (platformPackage == undefined) {
            Logger.error(`Platform '${platform}' is not supported`, true);
            return false;
        }

        let kubescapeDir = getKubescapePath()

        const binaryUrl = await getPlatformPackageUrl(platformPackage);
        const kubescapeName = "kubescape" + (IS_WINDOWS ? ".exe" : "");
        kubescapeBinaryInfo.location = await downloadFile(binaryUrl, kubescapeDir, kubescapeName, !IS_WINDOWS);
    }

    return kubescapeBinaryInfo.isInPath || kubescapeBinaryInfo.location.length > 0
}

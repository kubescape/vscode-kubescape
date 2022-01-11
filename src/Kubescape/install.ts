import * as vscode from 'vscode'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import axios from 'axios'
import { exec } from 'child_process'

import { Logger } from '../utils/log' 
import { PACKAGE_NAME, PACKAGE_BASE_URL, IS_WINDOWS } from './globals'

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
        vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                cancellable: false,
                title: 'Downloading Kubescape latest version'
            },
            async () => {

                let response = await axios({
                    method: 'GET',
                    url: url,
                    responseType: 'stream'
                })
                
                const writer = response.data.pipe(fs.createWriteStream(localPath));
                await new Promise((fulfill) => writer.on("close", fulfill))

                if (executable) {
                    fs.chmod(
                        localPath,
                        fs.constants.S_IRWXU | fs.constants.S_IRWXG | fs.constants.S_IXOTH,
                        () => { }
                    )
                }
                Logger.info(`Successfully downloaded ${fileName} into ${downloadPath}`, true)

            }
        )
    } catch {
        Logger.error(`Could not download ${url}`, true);
        localPath = ""
    }

    return localPath
}

function getKubescapePath() {
    const kubescape_dir = path.join(os.homedir(), ".kubescape")

    fs.stat(kubescape_dir, (err) => {
        if (err) {
            fs.mkdir(kubescape_dir, { recursive: true }, () => { })
        }
    })

    return kubescape_dir
}

async function getPlatformPackageUrl(platformPackage : string) {
    let res = await axios.get(PACKAGE_BASE_URL)
    return res.data.html_url.replace("/tag/", "/download/") + "/" + platformPackage
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

                const searchedPath = localPath + "/" + kubescapeName
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

    return true
}

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
import * as ui from '../utils/ui'

import { Logger } from '../utils/log' 
import { expend } from '../utils/path' 
import { getExtensionContext } from '../utils/context'
import { 
    PACKAGE_NAME, 
    PACKAGE_BASE_URL, 
    IS_WINDOWS, 
    CONFIG_DIR_PATH, 
    PACKAGE_DOWNLOAD_BASE_URL, 
    PACKAGE_STABLE_BUILD,
    COMMAND_GET_HELP,
} from './globals'

type KubescapePath = {
    fullPath : string,
    baseDir : string
}

async function downloadFile(url : string, downloadPath : string, fileName : string, executable = false) : Promise<string> {
    let localPath = path.resolve(__dirname, downloadPath, fileName)
    try {
        const cancel = new AbortController()
        await ui.progress("Downloading Kubescape", cancel, false, async(progress) => {
            const response = await fetch(url, { signal: cancel.signal })
            if (!response.ok || !response.body) {
                Logger.error(`Failed to download ${url}`)
                throw new Error
            }

            const size = Number(response.headers.get('content-length'))
            let read = 0;

            response.body.on('data', (chunk: Buffer) => {
                read += chunk.length
                progress(read, size)
            })

            const out = fs.createWriteStream(localPath)
            await promisify(stream.pipeline)(response.body, out).catch(e => {
                fs.unlink(localPath, (_) => null)
                throw new Error
            })

            if (executable) {
                await fs.promises.chmod(localPath, fs.constants.S_IRWXU | fs.constants.S_IRWXG | fs.constants.S_IXOTH)
            }
            Logger.info(`Successfully downloaded ${fileName} into ${downloadPath}`, false)
        })
    } catch {
        Logger.error(`Could not download ${url}`, true);
        localPath = ""
    } finally {
        return localPath
    }

}


function getOsKubescapeName(directory : string) {
    const platform = os.platform();
    const kubescapeName = "kubescape" + (platform == "win32" ? ".exe" : "");
    return expend(directory + "/" + kubescapeName)
}

export async function isKubescapeInstalled(kubescapePath : string): Promise<boolean> {
    return new Promise<boolean>(resolve => {
        fs.stat(kubescapePath, err => {
            if (err) {
                resolve(false)
                return
            } 

            exec(`${kubescapePath} ${COMMAND_GET_HELP}`, err => {
                /* broken binary */
                if (err) {
                    resolve(false)
                    return
                }

                resolve(true)
            })
        })
    })
}

export async function getKubescapeDir() : Promise<string> {
    /* Enable override from configuration */
    let kubescape_dir = await new Promise<string | undefined>(resolve => {
        const config = kubescapeConfig.getKubescapeConfig()
        if (!config[CONFIG_DIR_PATH]) {
           resolve(undefined) 
           return
        } 

        let dir = expend(config[CONFIG_DIR_PATH])

        fs.stat(dir, err => {
            if (!err) {
                resolve(dir)
                return
            }
            Logger.error(`The path ${dir} does not exists and therefore ignored`)
            resolve(undefined)
        })
    })

    if (!kubescape_dir || kubescape_dir.length <= 0) {
        kubescape_dir = await new Promise<string>(resolve => {
            const extensioContext = getExtensionContext()
            if (!extensioContext) {
                Logger.error("The extension is not loaded properly!", true)
                throw new Error
            } else {
                kubescape_dir = path.join(extensioContext.extensionPath, "install")
                fs.promises.mkdir(kubescape_dir, { recursive: true })
                resolve(kubescape_dir)
            }
        })
    }

    return kubescape_dir
}

export async function getKubescapePath() : Promise<KubescapePath> {
    let kubescape_dir = await getKubescapeDir()
    return {
        baseDir : kubescape_dir,
        fullPath : getOsKubescapeName(kubescape_dir)
    }
}

async function getLetestVersionUrl() {
    let res = await fetch(PACKAGE_BASE_URL)
    let obj = await res.json()
    return obj.html_url.replace("/tag/", "/download/")
}

export async function updateKubescape(needsLatest : boolean) : Promise<boolean> {
    /* set download url */
    let binaryUrl: string

    /* platform information */
    const pkg = vscode.extensions.getExtension(PACKAGE_NAME)?.packageJSON;
    const pp = pkg.config.platformPackages
    const platform = os.platform()
    const platformPackage = pp.platforms[platform]

    if (platformPackage == undefined) {
        Logger.error(`Platform '${platform}' is not supported`, true);
        return false
    }

    if (needsLatest) {
        binaryUrl = await getLetestVersionUrl();
    } else {
        binaryUrl = `${PACKAGE_DOWNLOAD_BASE_URL}/${PACKAGE_STABLE_BUILD}`
    }

    binaryUrl += `/${platformPackage}`

    const kubescapeDir = await getKubescapeDir()

    const kubescapeName = "kubescape" + (IS_WINDOWS ? ".exe" : "");
    const kubescapeFullPath = await downloadFile(binaryUrl, kubescapeDir, kubescapeName, !IS_WINDOWS);
    if (kubescapeFullPath.length > 0) {
        return true
    }

    return false
}

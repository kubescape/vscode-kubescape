import * as vscode from 'vscode'
import { exec } from 'child_process'


import * as install from './install'

import { Logger } from '../utils/log'
import { 
    ERROR_KUBESCAPE_NOT_INSTALLED, 
    COMMAND_LIST_FRAMEWORKS, 
    COMMAND_GET_VERSION ,
} from './globals'

export class KubescapeVersion {
    version : string
    isLatest : boolean

    constructor() {
        this.version = "unknown"
        this.isLatest = true
    }
}

export async function getAvailableFrameworks() : Promise<string[]> {
    let kubescapeInfo = await install.isKubescapeInstalled()
    if (!kubescapeInfo.isInstalled) {
        Logger.error(ERROR_KUBESCAPE_NOT_INSTALLED, true)
    }

    const cmd = `${kubescapeInfo.path} ${COMMAND_LIST_FRAMEWORKS}`
    return new Promise<string[]>(resolve => {
        return exec(cmd, async (err, stdout, stderr) => {

            let result: string[] = []
            if (err) {
                Logger.error(stderr)
                resolve(result)
            }

            // const lineRegex = new RegExp(/\* .+\n/)
            const lineRegex = /\* .+\n/g

            stdout.match(lineRegex)?.forEach((element) => {
                result.push(element.replace("* ", "").trimEnd())
            });

            resolve(result)
        })
    })
}

export async function getKubescapeVersion() : Promise<KubescapeVersion> {
    const kubescapeInfo = await install.isKubescapeInstalled()
    if (!kubescapeInfo.isInstalled) {
        Logger.error(ERROR_KUBESCAPE_NOT_INSTALLED, true)
    }

    const cmd = `${kubescapeInfo.path} ${COMMAND_GET_VERSION}`
    return new Promise<KubescapeVersion>(resolve=> {
        let kubescapeVersion = new KubescapeVersion
        exec(cmd,async (err, stdout, stderr) => {
            if (err) {
                Logger.error(stderr)                
                throw Error
            }

            // v2.0.144
            const verRegex = /v\d+\.\d+\.\d+/g

            let match = stdout.match(verRegex)
            if (match) {
                kubescapeVersion.version = match[0]
            }

            match = stderr.match(verRegex)
            if (match && match[0] !== kubescapeVersion.version) {
                kubescapeVersion.isLatest = false
            }

            resolve(kubescapeVersion)
        })
    })
}

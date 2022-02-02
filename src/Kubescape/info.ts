import * as vscode from 'vscode'
import { exec } from 'child_process'


import * as install from './install'

import { Logger } from '../utils/log'
import { ERROR_KUBESCAPE_NOT_INSTALLED, COMMAND_LIST_FRAMEWORKS } from './globals'


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
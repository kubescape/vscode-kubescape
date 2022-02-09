import * as fs from 'fs'
import * as path from 'path'
import { exec } from 'child_process'
import AbortController from 'abort-controller'

import * as install from './install'
import * as kubescapeConfig from './config'
import * as ui from '../utils/ui'
import '../utils/extensionMethods'

import { Logger } from '../utils/log'
import { expend } from '../utils/path'
import { 
    KubescapeVersion,
    KubescapePath,
    KubescapeFramework
} from './types' 
import {
    ERROR_KUBESCAPE_NOT_INSTALLED,
    COMMAND_GET_VERSION,
    COMMAND_DOWNLOAD_ARTIFACTS,
    CONFIG_SCAN_FRAMEWORKS,
    COMMAND_LIST_FRAMEWORKS,
    COMMAND_DOWNLOAD_FRAMEWORK,
    CONFIG_VERSION_TIER,
    PACKAGE_STABLE_BUILD,
    CONFIG_CUSTOM_FRAMWORKS_DIR,
    CONFIG_REQUIRED_FRAMEWORKS
} from './globals'


function appendToFrameworks(to : any, from : KubescapeFramework[]) {
    for (let framework of from) {
        const key = framework.name
        if (to && !to[key]) {
            to[key] = framework
        }
    }
}

function resolveKubescapeFrameworks(frameworkOutputs: string[]): KubescapeFramework[] {
    return frameworkOutputs.map(frameworkOutput => {
        const parts = frameworkOutput.split(':')
        const frameworkName = parts[1].extractBetween("'")
        const frameworkPath = parts[2].extractBetween("'")

        return {
            name: frameworkName.toLocaleLowerCase(),
            location: frameworkPath,
            isInstalled: false
        }
    })
}


export class KubescapeBinaryInfo {
    private static _instance: KubescapeBinaryInfo = new KubescapeBinaryInfo()

    private _isInitialized : boolean
    private _isInstalled: boolean
    private _path: KubescapePath | undefined
    private _frameworkDir: string | undefined
    private _versionInfo : KubescapeVersion | undefined
    private _frameworks : any | undefined

    private constructor() {
        if (!KubescapeBinaryInfo._instance) {
            KubescapeBinaryInfo._instance = this
        }

        this._isInitialized = false
        this._isInstalled = false
        this._path = undefined
        this._versionInfo = undefined
        this._frameworks = undefined
    }

    static get instance() : KubescapeBinaryInfo {
        return this._instance
    }

    get isInstalled() : boolean {
        return this._isInstalled
    }

    get path() : string {
        if (!this._path) {
            Logger.error(ERROR_KUBESCAPE_NOT_INSTALLED, true)
            throw new Error
        }
        return this._path.fullPath
    }

    get directory() : string {
        if (!this._path) {
            Logger.error(ERROR_KUBESCAPE_NOT_INSTALLED, true)
            throw new Error
        }
        return this._path.baseDir
    }

    get version() : string {
        if (this._versionInfo) {
            return this._versionInfo.version
        }

        throw new Error
    }

    get isLatestVersion() : boolean {
        if (this._versionInfo) {
            return this._versionInfo.isLatest
        }

        throw new Error
    }

    get frameworkDirectory() : string {
        if (!this._frameworkDir) {
            Logger.error(ERROR_KUBESCAPE_NOT_INSTALLED, true)
            throw new Error
        }

        return this._frameworkDir
    }

    get frameworksNames() : string [] {
        /* check if already cached */
        if (this._frameworks) {
            return Object.keys(this._frameworks).reduce((filtered: string [], frameworkName : string) => {
                if (this._frameworks[frameworkName].isInstalled) {
                    filtered.push(frameworkName)
                }
                return filtered
            }, [])
        }

        return []
    }

    get frameworks() : KubescapeFramework[] {
        /* check if already cached */
        if (this._frameworks) {
            return Object.keys(this._frameworks).map(frameworkName => this._frameworks[frameworkName])
        }

        return []
    }

    async getInstalledFrameworks(): Promise<KubescapeFramework[]> {
        let files = await fs.promises.readdir(this.frameworkDirectory)
        let frameworkFiles = await new Promise<string[]>(resolve => {
            resolve(files.filter(file => {
                if (file.endsWith('.json')) {
                    try {
                        const f_text = fs.readFileSync(path.join(this.frameworkDirectory, file), "utf8")
                        const obj = f_text.toJson()
                        if (obj['controls']) {
                            return true
                        }

                        return false

                    } catch {
                        return false
                    }

                }
                return false
            }))
        })

        return frameworkFiles.map(frameworkFile => {
            return {
                name: frameworkFile.split('.')[0].toLocaleLowerCase(),
                isInstalled: false,
                location: expend(`${this.frameworkDirectory}/${frameworkFile}`)
            }
        })
    }

    private async getKubescapeVersion(): Promise<KubescapeVersion> {
        if (!this.isInstalled) {
            Logger.error(ERROR_KUBESCAPE_NOT_INSTALLED, true)
        }

        const cmd = `${this.path} ${COMMAND_GET_VERSION}`

        let verInfo = new KubescapeVersion
        return new Promise<KubescapeVersion>(resolve=> {
            exec(cmd, async (err, stdout, stderr) => {
                if (err) {
                    Logger.error(stderr)
                    throw Error
                }
    
                const verRegex = /v\d+\.\d+\.\d+/g
    
                let match = stdout.match(verRegex)
                if (match) {
                    verInfo.version = match[0]
    
                    match = stderr.match(verRegex)
                    if (match && match[0] !== verInfo.version) {
                        verInfo.isLatest = false
                    }
                }

                resolve(verInfo)
            })
        })
    }

    private async downloadMissingFrameworks(requiredFrameworks: string[]): Promise<string[]> {
        const promises = requiredFrameworks.map(framework => 
            new Promise<string>((resolve, reject) => {
                const cmd = `${this.path} ${COMMAND_DOWNLOAD_FRAMEWORK} ${framework} -o ${this.frameworkDirectory}`
                exec(cmd, (err, stdout, stderr) => {
                    if (err) {
                        Logger.error(`Could not download framework ${framework}. Reason:\n${stderr}`)
                        reject(stderr)
                    }

                    /* match download artifacts command output */
                    resolve(stdout.replace("'framework'", `'framework': '${framework}'`))
                })
            })
        )

        return Promise.all(promises)
    }

    private async downloadAllFrameworks(): Promise<string[]> {
        /* download all */
        const cmd = `${this.path} ${COMMAND_DOWNLOAD_ARTIFACTS} --output ${this.frameworkDirectory}`
        return new Promise<string[]>(resolve => {
            exec(cmd, (err, stdout, stderr) => {
                let results: string[] = []
                if (err) {
                    Logger.error(`Unable to download artifacts:\n${stderr}`)
                    resolve(results)
                }

                const lineRegex = /\'framework'.+/g
                stdout.match(lineRegex)?.forEach((e) => {
                    results.push(e)
                })

                resolve(results)
            })
        })
    }

    async getUninstalledFramework(): Promise<string[]> {
        const cmd = `${this.path} ${COMMAND_LIST_FRAMEWORKS}`

        return new Promise<string[]>(resolve => {
            exec(cmd, (err, stdout, stderr) => {
                let result: string[] = []

                if (err) {
                    /* on error return empty but don't define in cache */
                    Logger.error(stderr)
                    resolve(result)
                }

                // const lineRegex = new RegExp(/\* .+\n/)
                const lineRegex = /\* .+\n/g

                stdout.match(lineRegex)?.forEach((element) => {
                    result.push(element.replace("* ", "").trimEnd())
                });

                resolve(result.filter(framework => {
                    return !this._frameworks[framework.toLocaleLowerCase()]
                }))
            })
        })
    }

    async installFrameworks(frameworks : string[]) {
        let frameworksNeedsDownload : string[] = []        
        for (let framework of frameworks) {
            if (this._frameworks && this._frameworks[framework]) {
                this._frameworks[framework].isInstalled = true
            } else {
                frameworksNeedsDownload.push(framework)
            }
        }

        if (frameworksNeedsDownload.length > 0) {
            const newInstalledFrameworks = await this.downloadMissingFrameworks(frameworksNeedsDownload)
            appendToFrameworks(this._frameworks, resolveKubescapeFrameworks(newInstalledFrameworks))
        }
    }

    async setup () {
        const cancel = new AbortController()
        await ui.progress("Initializing kubescape", cancel, true, async(progress) => {
            /* initialize only once */
            if (this._isInitialized) return

            const tasksCount = 5
            let completedTasks = 0

            /* 1. Get kubescape path */
            /* ---------------------------------------------------------------*/
            this._path = await install.getKubescapePath()
            completedTasks++
            progress(completedTasks, tasksCount)

            /* 2. Check installation state */
            /* ---------------------------------------------------------------*/
            this._isInstalled = await install.isKubescapeInstalled(this.path)
            let needsUpdate = !this.isInstalled
            completedTasks++
            progress(completedTasks, tasksCount)

            /* 3. Query config to choose between version tiers */
            /* ---------------------------------------------------------------*/
            const config = kubescapeConfig.getKubescapeConfig()
            const needsLatest = config[CONFIG_VERSION_TIER] && config[CONFIG_VERSION_TIER] === "latest"

            if (!needsUpdate) {
                /* kubescape exists - check letest version */
                this._versionInfo = await this.getKubescapeVersion()
                needsUpdate = needsLatest && !this.isLatestVersion

                if (!needsUpdate && !needsLatest) {
                    /* not latest version - verify stable version  */
                    needsUpdate = this.version !== PACKAGE_STABLE_BUILD
                }
            }
            completedTasks++
            progress(completedTasks, tasksCount)

            /* 4. Install kubescape if needed */
            /* ---------------------------------------------------------------*/
            if (needsUpdate) {
                this._isInstalled = await install.updateKubescape(needsLatest)
                if (!this.isInstalled) {
                    Logger.error(ERROR_KUBESCAPE_NOT_INSTALLED)
                    cancel.abort()
                    return
                }

                /* Get version again after update */
                this._versionInfo = await this.getKubescapeVersion()
            }
            completedTasks++
            progress(completedTasks, tasksCount)

            /* 5. Initialize frameworks */
            /* ---------------------------------------------------------------*/
            this._frameworks = {}

            this._frameworkDir = config[CONFIG_CUSTOM_FRAMWORKS_DIR] 
            if (this._frameworkDir && this._frameworkDir.length > 0) {
                /* Get custom frameworks from specified directories */
                try {
                    this._frameworkDir = expend(this._frameworkDir)
                    await fs.promises.access(this._frameworkDir)
                } catch {
                    /* Fallback to kubescape directory */
                    Logger.warning(`Cannot access ${this._frameworkDir}. Using fallback instead.`)
                    this._frameworkDir = this.directory
                }
            } else {
                /* Get available frameworks from kubescape directory */
                this._frameworkDir = this.directory
            }
            appendToFrameworks(this._frameworks, await this.getInstalledFrameworks())

            /* Get required frameworks */
            let requiredFrameworks : string[] | undefined = config[CONFIG_REQUIRED_FRAMEWORKS]
            if (requiredFrameworks && !requiredFrameworks.includes('all')) {
                /* Download only required frameworks (filter out availables) */
                requiredFrameworks = requiredFrameworks.filter(framework => {
                    return !this._frameworks[framework]
                })
    
                if (requiredFrameworks.length > 0) {
                    await this.installFrameworks(requiredFrameworks)
                }
            } else {
                /* Download all artifatcs including all frameworks */
                const allFrameworks = await this.downloadAllFrameworks()
                appendToFrameworks(this._frameworks, resolveKubescapeFrameworks(allFrameworks))
            }

            /* Get scan frameworks */
            let scanFrameworks : string[] = config[CONFIG_SCAN_FRAMEWORKS]
            if (!scanFrameworks || scanFrameworks.includes('all')) {
                /* Use all the available frameworks */
                scanFrameworks = Object.keys(this._frameworks)
            }
            for (let framworkName of scanFrameworks) {
                this._frameworks[framworkName].isInstalled = true
            }

            completedTasks++
            progress(completedTasks, tasksCount)
        })
    }
}
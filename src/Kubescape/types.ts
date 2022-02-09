export class KubescapeVersion {
    version: string
    isLatest: boolean

    constructor() {
        this.version = "unknown"
        this.isLatest = true
    }
}

export type KubescapePath = {
    fullPath : string,
    baseDir : string
}

export type KubescapeFramework = {
    name : string,
    isInstalled : boolean,
    location : string
}
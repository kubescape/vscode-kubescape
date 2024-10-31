export class KubescapeVersion {
    version: string;
    isLatest: boolean;

    constructor() {
        this.version = "unknown";
        this.isLatest = true;
    }
}

export type KubescapePath = {
    fullPath : string,
    baseDir : string,
    isCustom : boolean
};

export type KubescapeFramework = {
    name : string,
    isInstalled : boolean,
    location : string
};

export type KubescapeDir = {
    directory : string,
    isCustom : boolean
};

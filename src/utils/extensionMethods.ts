export {}
declare global {
    export interface String { 
        extractBetween(surround : string) : string
        toJson() : any
        toJsonArray() : any
    }
}

String.prototype.extractBetween = function(this: string, surround : string) {
    return this.substring(
        this.indexOf(surround) + 1,
        this.lastIndexOf(surround)
    )
}

String.prototype.toJson = function() : any {
    let obj
    let str = this.toString()

    try {
        obj = JSON.parse(str)
    } catch {
        obj = {}
    }

    return obj 
}

String.prototype.toJsonArray = function() : any {
    let obj
    let str = this.toString()

    try {
        if (this[0] !== '[') {
            str = '[' + str + ']'
        }

        obj = JSON.parse(str)
    } catch {
        obj = []
    }

    return obj 
}
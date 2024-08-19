export interface IYamlRange {
    startIndex: number;
    endIndex: number;
    startRowIndex: number;
    endRowIndex: number;
}

export interface IYamlRangeWithFixSteps extends IYamlRange {
    fixSteps: null | string[];
}
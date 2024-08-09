import { match } from "assert";
import { Logger } from "../log";
import { IYamlRangeWithFixSteps } from "./types";


export type IYamlHighlight = {
    startIndex: number
    endIndex: number
}

type startIndexAccType = { startIndex: number; prevIndent: number; tempMatch: RegExpMatchArray | null; };

function checkAndUpdateIndent(startIndexAcc : startIndexAccType, index : number) : boolean {
  if (index >= startIndexAcc.prevIndent) {
    startIndexAcc.prevIndent = index
    return true
  } else {
    return false
  }
}

export class YamlParse {

  static getRangeFromPathWithFixSteps(path: string, lines: string[], currentLineIndex: number = 0, currentStepIndex: number = 0): IYamlRangeWithFixSteps {

    const steps: string[] = this.splitPathToSteps(path);
    const noOfSteps: number = steps.length;
    const noOfLines: number = lines.length;
    let startIndex: number = -1;
    let endIndex: number = -1;
    let startRow: number = -1;
    let endRow: number = -1;
    let fixSteps: string[] = [];
    let matchNotFound: boolean = false;
    let regExpForArray: RegExp = new RegExp(/\[\d+]/);
    let isStepWithArray: boolean;
    const regExpForArrayIndex: RegExp = new RegExp(/\d+/);
    const indentArray: string = '- ';
    let currentIndex: number = -1;

    for(currentStepIndex; currentStepIndex<noOfSteps; currentStepIndex++){

      const step = steps[currentStepIndex];
      if(matchNotFound){
        fixSteps.push(step);
      }
      else{
        // Still misses edge case, where somewherere more nested something is present and should be considered. Will be added later. These types of errors are anyways not supposed to occur
        let regExpForStep: RegExp;
        isStepWithArray = regExpForArray.test(steps[currentStepIndex]);
        if(isStepWithArray){
          regExpForStep = new RegExp(step.replace(regExpForArray, '').trim() + "\s*:");
        }
        else{
          regExpForStep = new RegExp(step+"\s*:");
        }

        matchNotFound = true;

        for(; currentLineIndex<noOfLines; currentLineIndex++){
          const line: string = lines[currentLineIndex];
          let searchStartIndex: number = line.search(regExpForStep);

          if(searchStartIndex !== -1){
            if(isStepWithArray){
              const match = step.match(regExpForArrayIndex);
              const arrayIndex: number = match ? +match[0] : 0;
              let arrayIndexCount: number = 0;
              let arrayIndent: number | null = null;
              while(currentLineIndex++ && currentLineIndex<noOfLines){
                const nextLine: string = lines[currentLineIndex];
                const nextLineIndent = nextLine.indexOf(indentArray);
                if(nextLineIndent === -1){
                  continue;
                }
                else{
                  if(arrayIndent === null){
                    arrayIndent = nextLineIndent;
                  }
                }
                if(nextLineIndent === arrayIndent){
                  if(arrayIndexCount === arrayIndex){
                    startIndex = nextLineIndent;
                    endIndex = nextLine.length;
                    startRow = currentLineIndex;
                    endRow = currentLineIndex;
                    matchNotFound = false;
                    currentIndex = nextLineIndent;
                    break;
                  }
                  else{
                    arrayIndexCount++;
                  }
                }
              }
            }
            else{
              if(searchStartIndex > currentIndex){
                startIndex = searchStartIndex;
                endIndex = line.length;
                startRow = currentLineIndex;
                endRow = currentLineIndex;
                matchNotFound = false;
                currentIndex = searchStartIndex;
                break;
              }
            }
          }
          else{
            continue;
          }
        }
        if(matchNotFound){
          fixSteps.push(step);
        }
      }

    }

    return {
      startIndex: startIndex,
      endIndex: endIndex,
      startRowIndex: startRow,
      endRowIndex: endRow,
      fixSteps: fixSteps.length === steps.length? [] : fixSteps
    }
  }

  static splitPathToSteps(path: string): string[] {
    const splitRegExp = new RegExp(/[a-zA-Z]+|\[[^[]+]/, 'g');
    const trimRegExp = new RegExp(/[^[\]\d]+/);

    return path.match(splitRegExp)?.reduce((acc: string[], step: string) => {
      const trimRegExpResult: RegExpExecArray | null = trimRegExp.exec(step);
      if(trimRegExpResult) {
        acc.push(trimRegExpResult[0]);
      }
      else{
        acc[acc.length - 1] = acc[acc.length - 1] + step;
      }
      return acc;
    }, []) || [];
  }

  static getStartAndEndIndexes(steps: string[], lines: string[]): IYamlHighlight {
    const startIndexAcc = YamlParse.getStartIndexAcc(steps, lines);
    const startIndex = startIndexAcc.startIndex;
    const endIndex = YamlParse.getEndIndex(startIndex, lines, !!startIndexAcc.tempMatch);

    return { startIndex, endIndex };
  }


  static getStartIndexAcc(steps: string[], lines: string[]): startIndexAccType {

    const indentArray = '- ';
    const regExpForArray = new RegExp(/\[\d+]/);
    const regExpForArrayIndex = new RegExp(/\d+/);

    let flag = false;
    return steps.reduce((startIndexAcc: startIndexAccType, step: string, stepIndex: number) => {
      if(flag){
        return startIndexAcc;
      }
      const stepWithOutArr = step.replace(regExpForArray, '') + ':';

      if (startIndexAcc.tempMatch) {
        handleArrayMatch(startIndexAcc, lines, indentArray, indentArray);
      } else {
        let temp = lines.findIndex((line: string, indexLine: number) => {
          if (indexLine > startIndexAcc.startIndex) {
            return checkAndUpdateIndent(startIndexAcc, line.indexOf(stepWithOutArr))
          }

          return false;
        });
        if(temp !== -1){
          startIndexAcc.startIndex = temp;
        }
        else{
          flag = true;
          return startIndexAcc;
        }
      }

      startIndexAcc.tempMatch = step.match(regExpForArrayIndex);

      const isLastItem = stepIndex === (steps.length - 1);

      if (isLastItem && startIndexAcc.tempMatch) {
        handleArrayMatch(startIndexAcc, lines, indentArray, indentArray)
      }

      return startIndexAcc;
    }, { startIndex: -1, prevIndent: 0, tempMatch: null });
  }

  static getEndIndex(startIndex: number, lines: string[], isArrElement: boolean): number {
    const indent = ' ';
    const regExp = isArrElement ? new RegExp(/-/) : new RegExp(/\w/);
    const regExpResult: RegExpExecArray | null = regExp.exec(lines[startIndex]);
    const controlIndex = regExpResult?.index || 0;
    const firstParallelLineIndex = lines.findIndex((line: string, lineIndex: number) => {
      if (lineIndex > startIndex) {
        return line[controlIndex] !== indent;
      }

      return false;
    });

    return firstParallelLineIndex - 1;
  }
}

function handleArrayMatch(startIndexAcc: startIndexAccType, lines: string[], indentArray: string, searchTerm: string) {
  if (startIndexAcc.tempMatch) {

    const arrayIndex = +startIndexAcc.tempMatch[0];
    let controlIndex: number | null = null;

    // find first indentation of array
    let arrayIndent: number;
    lines.findIndex((line: string, indexLine: number) => {
      if (indexLine > startIndexAcc.startIndex) {
        arrayIndent = line.indexOf(indentArray);
        if (arrayIndent >= startIndexAcc.prevIndent) {
          return true;
        }

        return false;
      }

      return false;
    });

    startIndexAcc.startIndex = lines.findIndex((line: string, indexLine: number) => {
      if (indexLine > startIndexAcc.startIndex) {
        if (controlIndex !== arrayIndex && line.indexOf(indentArray) === arrayIndent) {
          controlIndex = controlIndex === null ? 0 : controlIndex + 1;
        }

        if (controlIndex === arrayIndex) {
          return checkAndUpdateIndent(startIndexAcc, line.indexOf(searchTerm));
        }

        return false;
      }

      return false;
    });
  }
}

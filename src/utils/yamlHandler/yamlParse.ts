import { Logger } from "../log";


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

export class YamlHighlighter {

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
    const startIndexAcc = YamlHighlighter.getStartIndexAcc(steps, lines);
    const startIndex = startIndexAcc.startIndex;
    const endIndex = YamlHighlighter.getEndIndex(startIndex, lines, !!startIndexAcc.tempMatch);

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

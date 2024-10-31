import * as vscode from 'vscode';
import { Logger } from '../../../utils/log';
import { get } from 'http';
import { VscodeUi } from '../../../utils/ui';
import { KubescapeApi } from '@kubescape/install';
import { DiagnosticReportsCollection } from '../../diagnostics/diagnosticsReportCollection';
import { KubescapePanelWebviewProvider } from '../../../ui/kubescapePanel/kubescapePanel';

export async function kubescapeImageScan(document: vscode.TextDocument, lines: string[]): Promise<void> {

    if (!document || document.isUntitled) {
        Logger.error("Could not locate open directories");
        return;
    }

    let images: {
        image: string,
        line: number
    }[];

    if(document.languageId == "yaml") {
        images = getImagesFromYaml(lines);
    }
    else if(document.languageId == "dockerfile") { //dockerfile
        KubescapePanelWebviewProvider.loadingPanel();
        images = getImagesFromDockerFile(lines);
    }
    else{
        Logger.error("Not a valid yaml or dockerfile");
        return;
    }

    // do parallel image scan
    // Use Promise.all to wait for all image scans to complete
    await Promise.all(images.map(image => 
        getImageScanReport(image, document.uri)
    ));
}

export function getImagesFromDockerFile(lines: string[]) {
    const images = [];
    // in each element of array add the image name and the line number
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.includes("FROM")) {
            const image = line.split(" ")[1];
            images.push({image: image, line: i});
        }
    }
    return images;
}

export function getImagesFromYaml(lines: string[]): {image: string, line: number}[] {
    const images = [];
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.includes("image")) {
            // Split the string by colon and get the part after "image:"
            const parts = line.split(':');
            if(parts.length < 2) {
                Logger.error("Invalid image tag");
                continue;
            }           
            // Join all parts except the first one (in case the image tag contains colons)
            const image = parts.slice(1).join(':').trim();
            images.push({image: image, line: i});
        }
    }
    return images;
}


export async function getImageScanReport(image: {image: string, line: number}, currentFileUri: vscode.Uri) {
    const problem = DiagnosticReportsCollection.instance;
    const kubescapeApi = KubescapeApi.instance;
    Logger.debug(currentFileUri.fsPath);
    const imageScanReport = await kubescapeApi.scanImage(new VscodeUi, image.image, currentFileUri.fsPath);
    problem.addImageVulnerabilityReport(imageScanReport, currentFileUri.fsPath, image);
    return imageScanReport;
}

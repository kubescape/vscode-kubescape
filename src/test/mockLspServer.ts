/**
 * A mock Language Server Protocol server running over stdio for testing.
 * Implements standard LSP framing and protocol messages.
 */

import * as fs from 'fs';

function send(msg: any): void {
    const json = JSON.stringify(msg);
    const len = Buffer.byteLength(json, 'utf8');
    process.stdout.write(`Content-Length: ${len}\r\n\r\n${json}`);
}

function log(text: string): void {
    process.stderr.write(`[mockLspServer] ${text}\n`);
}

let buffer = Buffer.alloc(0);

// Record received calls/notifications in a log file if requested
const recordFile = process.env.MOCK_LSP_RECORD_FILE;
function record(entry: any): void {
    if (recordFile) {
        fs.appendFileSync(recordFile, JSON.stringify(entry) + '\n');
    }
}

if (process.env.MOCK_LSP_CRASH_IMMEDIATELY === '1') {
    log('Crashing immediately as instructed by env');
    process.exit(1);
}

if (process.env.MOCK_LSP_STALL === '1') {
    log('Stalling without reading input');
    setInterval(() => {}, 100000);
}

process.stdin.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);

    while (true) {
        const headerEnd = buffer.indexOf('\r\n\r\n');
        if (headerEnd === -1) {
            break;
        }

        const headerStr = buffer.slice(0, headerEnd).toString('ascii');
        const match = /Content-Length:\s*(\d+)/i.exec(headerEnd > 0 ? headerStr : '');
        if (!match) {
            break;
        }

        const contentLength = parseInt(match[1], 10);
        const bodyStart = headerEnd + 4;
        const totalLength = bodyStart + contentLength;

        if (buffer.length < totalLength) {
            break; // Wait for full frame
        }

        const body = buffer.slice(bodyStart, totalLength);
        buffer = buffer.slice(totalLength);

        handleMessage(JSON.parse(body.toString('utf8')));
    }
});

let isShuttingDown = false;

function handleMessage(msg: any): void {
    record(msg);

    if (process.env.MOCK_LSP_MALFORMED_RESPONSE === '1') {
        process.stdout.write('INVALID NOT JSON CONTENT\r\n\r\n');
        return;
    }

    if (msg.method === 'initialize') {
        if (process.env.MOCK_LSP_CRASH_ON_INIT === '1') {
            log('Exiting on initialize request');
            process.exit(2);
        }

        send({
            jsonrpc: '2.0',
            id: msg.id,
            result: {
                capabilities: {
                    textDocumentSync: {
                        openClose: true,
                        change: 1, // Full
                        save: true,
                    },
                },
            },
        });
        return;
    }

    if (msg.method === 'initialized') {
        log('Client initialized');
        return;
    }

    if (msg.method === 'textDocument/didOpen') {
        log(`didOpen: ${msg.params?.textDocument?.uri}`);
        return;
    }

    if (msg.method === 'textDocument/didChange') {
        log(`didChange: ${msg.params?.textDocument?.uri}`);
        return;
    }

    if (msg.method === 'textDocument/didSave') {
        log(`didSave: ${msg.params?.textDocument?.uri}`);
        const uri = msg.params?.textDocument?.uri;

        if (process.env.MOCK_LSP_PUBLISH_DIAGNOSTICS === '1') {
            send({
                jsonrpc: '2.0',
                method: 'textDocument/publishDiagnostics',
                params: {
                    uri: uri,
                    version: 1,
                    diagnostics: [
                        {
                            range: {
                                start: { line: 0, character: 0 },
                                end: { line: 0, character: 10 },
                            },
                            severity: 1, // Error
                            code: 'C-0017',
                            source: 'kubescape',
                            message: 'Container hostIPC is set to true',
                        },
                        {
                            range: {
                                start: { line: 5, character: 2 },
                                end: { line: 5, character: 20 },
                            },
                            severity: 2, // Warning
                            code: 'C-0034',
                            source: 'kubescape',
                            message: 'Automatic mounting of ServiceAccountToken is not disabled',
                        },
                        {
                            range: {
                                start: { line: 10, character: 0 },
                                end: { line: 10, character: 5 },
                            },
                            severity: 3, // Information
                            code: 'C-0055',
                            source: 'kubescape',
                            message: 'Resource requests or limits are missing',
                        },
                    ],
                },
            });
        } else if (process.env.MOCK_LSP_EMPTY_DIAGNOSTICS === '1') {
            send({
                jsonrpc: '2.0',
                method: 'textDocument/publishDiagnostics',
                params: {
                    uri: uri,
                    version: 2,
                    diagnostics: [],
                },
            });
        }
        return;
    }

    if (msg.method === 'textDocument/didClose') {
        log(`didClose: ${msg.params?.textDocument?.uri}`);
        // Clearing diagnostics on close as Kubescape server does
        send({
            jsonrpc: '2.0',
            method: 'textDocument/publishDiagnostics',
            params: {
                uri: msg.params?.textDocument?.uri,
                diagnostics: [],
            },
        });
        return;
    }

    if (msg.method === 'shutdown') {
        isShuttingDown = true;
        send({
            jsonrpc: '2.0',
            id: msg.id,
            result: null,
        });
        return;
    }

    if (msg.method === 'exit') {
        const exitCode = isShuttingDown ? 0 : 1;
        log(`Exit received, exiting with code ${exitCode}`);
        process.exit(exitCode);
    }
}

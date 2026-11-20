/**
 * Waits for a JSON-RPC message accepted by `predicate`, ignoring every other message.
 * The whole wait is bounded by one absolute deadline: each nextMessage() call receives only
 * the time that remains, so unrelated messages neither extend nor shorten the overall timeout,
 * and a message read after the deadline is never accepted.
 */
export async function awaitJsonRpcMessage(
    nextMessage: (timeoutMs: number) => Promise<any>,
    predicate: (msg: any) => boolean,
    description: string,
    timeoutMs: number = 30000,
    now: () => number = Date.now
): Promise<any> {
    const deadline = now() + timeoutMs;
    for (;;) {
        const remaining = deadline - now();
        if (remaining <= 0) {
            break;
        }
        let msg: any;
        try {
            msg = await nextMessage(remaining);
        } catch (err) {
            if (now() >= deadline) {
                break;
            }
            throw err;
        }
        if (now() > deadline) {
            break;
        }
        if (msg && predicate(msg)) {
            return msg;
        }
    }
    throw new Error(`Timeout waiting for ${description}`);
}

/**
 * True only for a JSON-RPC response (not a request or notification) carrying the expected id:
 * it has no `method` and has either `result` (including null) or `error`.
 */
export function isJsonRpcResponse(msg: any, id: number): boolean {
    if (!msg || typeof msg !== 'object' || msg.id !== id) {
        return false;
    }
    if (Object.prototype.hasOwnProperty.call(msg, 'method')) {
        return false;
    }
    return Object.prototype.hasOwnProperty.call(msg, 'result') || Object.prototype.hasOwnProperty.call(msg, 'error');
}

/**
 * Waits for the JSON-RPC response with the given id under one absolute deadline.
 */
export function awaitJsonRpcResponse(
    nextMessage: (timeoutMs: number) => Promise<any>,
    id: number,
    timeoutMs: number = 30000,
    now: () => number = Date.now
): Promise<any> {
    return awaitJsonRpcMessage(nextMessage, (m) => isJsonRpcResponse(m, id), `response id ${id}`, timeoutMs, now);
}

/**
 * Waits for a textDocument/publishDiagnostics notification for `uri` under one absolute deadline
 * and resolves with its diagnostics.
 */
export async function awaitDiagnosticsForUri(
    nextMessage: (timeoutMs: number) => Promise<any>,
    uri: string,
    timeoutMs: number = 90000,
    now: () => number = Date.now
): Promise<any[]> {
    const msg = await awaitJsonRpcMessage(
        nextMessage,
        (m) => m.method === 'textDocument/publishDiagnostics' && m.params?.uri === uri,
        `publishDiagnostics for ${uri}`,
        timeoutMs,
        now
    );
    return msg.params?.diagnostics || [];
}

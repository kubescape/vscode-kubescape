/**
 * Waits for the JSON-RPC response with the given id, ignoring notifications and
 * responses with other ids. The whole wait is bounded by one absolute deadline:
 * every nextMessage() call receives only the time that remains, so unrelated
 * messages neither extend nor shorten the overall timeout.
 */
export async function awaitJsonRpcResponse(
    nextMessage: (timeoutMs: number) => Promise<any>,
    id: number,
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
        if (msg && msg.id === id) {
            return msg;
        }
    }
    throw new Error(`Timeout waiting for response id ${id}`);
}

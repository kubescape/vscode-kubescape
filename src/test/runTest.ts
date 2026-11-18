import * as path from 'path';
import { runTests } from '@vscode/test-electron';

async function main() {
    try {
        const extensionDevelopmentPath = path.resolve(__dirname, '../../');
        const extensionTestsPath = path.resolve(__dirname, './suite/index');

        // Run the integration test suite inside VS Code
        await runTests({
            extensionDevelopmentPath,
            extensionTestsPath,
        });
    } catch (err) {
        console.error('Failed to run VS Code integration tests', err);
        process.exit(1);
    }
}

main();

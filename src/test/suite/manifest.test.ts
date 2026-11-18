import * as assert from 'assert';
import * as path from 'path';

/**
 * Manifest document selector evaluator matching the LanguageClient configuration.
 */
interface DocumentSelectorItem {
    scheme: string;
    language?: string;
    pattern?: string;
}

const DOCUMENT_SELECTOR: DocumentSelectorItem[] = [
    { scheme: 'file', language: 'yaml' },
    { scheme: 'file', language: 'json' },
];

function isSupportedDocument(doc: { uri: string; languageId: string }): boolean {
    const isFileScheme = doc.uri.startsWith('file://');
    if (!isFileScheme) {
        return false;
    }
    return doc.languageId === 'yaml' || doc.languageId === 'json';
}

function detectKubernetesManifest(content: string): boolean {
    const trimmed = content.trim();
    if (!trimmed) {
        return false;
    }
    // Simple fast heuristic matching apiVersion and kind
    const hasApiVersion = /(^|\n)\s*apiVersion\s*:\s*[^\s]+/m.test(trimmed);
    const hasKind = /(^|\n)\s*kind\s*:\s*[^\s]+/m.test(trimmed);
    return hasApiVersion && hasKind;
}

function parseMultiDocYaml(content: string): string[] {
    return content
        .split(/(?:^|\n)---\s*(?:\n|$)/)
        .map(doc => doc.replace(/^---\s*$/gm, '').trim())
        .filter(doc => Boolean(doc));
}

describe('Manifest Handling & Document Selector Tests', () => {
    it('supports YAML files with file:// scheme', () => {
        const supported = isSupportedDocument({
            uri: 'file:///workspace/k8s/pod.yaml',
            languageId: 'yaml',
        });
        assert.strictEqual(supported, true);
    });

    it('supports YML files with file:// scheme (mapped to yaml languageId in VS Code)', () => {
        const supported = isSupportedDocument({
            uri: 'file:///workspace/k8s/deployment.yml',
            languageId: 'yaml',
        });
        assert.strictEqual(supported, true);
    });

    it('supports JSON Kubernetes manifests with file:// scheme', () => {
        const supported = isSupportedDocument({
            uri: 'file:///workspace/k8s/service.json',
            languageId: 'json',
        });
        assert.strictEqual(supported, true);
    });

    it('rejects unsupported non-file URI schemes (untitled:, git:, vscode-userdata:)', () => {
        assert.strictEqual(
            isSupportedDocument({ uri: 'untitled:Untitled-1', languageId: 'yaml' }),
            false
        );
        assert.strictEqual(
            isSupportedDocument({ uri: 'git:///repo/pod.yaml', languageId: 'yaml' }),
            false
        );
        assert.strictEqual(
            isSupportedDocument({ uri: 'vscode-userdata:/settings.json', languageId: 'json' }),
            false
        );
    });

    it('rejects unsupported language types (e.g. Dockerfile, Markdown, Shell)', () => {
        assert.strictEqual(
            isSupportedDocument({ uri: 'file:///workspace/Dockerfile', languageId: 'dockerfile' }),
            false
        );
        assert.strictEqual(
            isSupportedDocument({ uri: 'file:///workspace/README.md', languageId: 'markdown' }),
            false
        );
        assert.strictEqual(
            isSupportedDocument({ uri: 'file:///workspace/deploy.sh', languageId: 'shellscript' }),
            false
        );
    });

    it('handles files in nested workspace paths and paths with spaces', () => {
        const nestedPathWithSpaces = 'file:///workspace/My%20Deployments/team-a/subfolder/pod.yaml';
        assert.strictEqual(
            isSupportedDocument({ uri: nestedPathWithSpaces, languageId: 'yaml' }),
            true
        );
    });

    it('identifies valid Kubernetes manifests containing apiVersion and kind', () => {
        const podYaml = `
apiVersion: v1
kind: Pod
metadata:
  name: test-pod
spec:
  containers:
  - name: web
    image: nginx
`;
        assert.strictEqual(detectKubernetesManifest(podYaml), true);
    });

    it('correctly splits and parses multi-document YAML manifests', () => {
        const multiDocYaml = `
apiVersion: v1
kind: Service
metadata:
  name: web-svc
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web-dep
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: web-cfg
`;
        const docs = parseMultiDocYaml(multiDocYaml);
        assert.strictEqual(docs.length, 3);
        assert.ok(docs[0].includes('kind: Service'));
        assert.ok(docs[1].includes('kind: Deployment'));
        assert.ok(docs[2].includes('kind: ConfigMap'));
    });

    it('handles empty manifest documents cleanly', () => {
        assert.strictEqual(detectKubernetesManifest(''), false);
        assert.strictEqual(detectKubernetesManifest('   \n\n  '), false);
        assert.deepStrictEqual(parseMultiDocYaml(''), []);
        assert.deepStrictEqual(parseMultiDocYaml('---\n---'), []);
    });

    it('rejects non-Kubernetes YAML files (missing apiVersion/kind)', () => {
        const genericYaml = `
name: project
version: 1.0.0
dependencies:
  - lodash
`;
        assert.strictEqual(detectKubernetesManifest(genericYaml), false);
    });
});

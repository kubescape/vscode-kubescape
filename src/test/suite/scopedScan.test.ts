import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    isCandidateForKubernetesScan,
    shouldScanDocumentOnSave,
    armForcedScan,
    forceScanForDocument,
    consumeForceScan,
    clearForcedScan,
    resetForceScanState,
    isScanForcedForDocument,
    getDocumentKey,
    isKustomizeDependency,
    isHelmDependency,
    clearForcedScansForOwner,
    clearOwnerState,
    createDidSaveMiddleware,
    createDidOpenMiddleware,
    createDidCloseMiddleware,
    extractKustomizeReferences,
    analyzeKustomization,
    recordDocumentRelevance,
    DOCUMENT_SELECTOR,
    analyzeHelmTemplate,
    setTimeProvider,
    resetTimeProvider,
    ScannableDocument,
} from '../../server/manifestFilter';
import { awaitJsonRpcMessage, awaitJsonRpcResponse, awaitDiagnosticsForUri, isJsonRpcResponse } from './rpcWait';

describe('LSP Save-Time Scoped Scanning & Filter Tests (Second-Pass Audit)', () => {
    beforeEach(() => {
        resetForceScanState();
    });

    afterEach(() => {
        resetForceScanState();
    });

    describe('Manifest Detection Robustness & Edge Cases (Section 1 Audit)', () => {
        it('identifies YAML manifests with double-quoted keys and values', () => {
            const doc: ScannableDocument = {
                uri: { scheme: 'file', fsPath: '/workspace/k8s/quoted.yaml' },
                languageId: 'yaml',
                fileName: '/workspace/k8s/quoted.yaml',
                getText: () => `
"apiVersion": "apps/v1"
"kind": "Deployment"
metadata:
  name: "quoted-deploy"
spec:
  replicas: 1
`,
            };
            assert.strictEqual(isCandidateForKubernetesScan(doc), true);
        });

        it('identifies YAML manifests with single-quoted keys and values', () => {
            const doc: ScannableDocument = {
                uri: { scheme: 'file', fsPath: '/workspace/k8s/single-quoted.yaml' },
                languageId: 'yaml',
                fileName: '/workspace/k8s/single-quoted.yaml',
                getText: () => `
'apiVersion': 'batch/v1'
'kind': 'Job'
metadata:
  name: 'single-quoted-job'
`,
            };
            assert.strictEqual(isCandidateForKubernetesScan(doc), true);
        });

        it('identifies YAML manifests with inline comments and trailing whitespace', () => {
            const doc: ScannableDocument = {
                uri: { scheme: 'file', fsPath: '/workspace/k8s/comments.yaml' },
                languageId: 'yaml',
                fileName: '/workspace/k8s/comments.yaml',
                getText: () => `
# Leading license comments
apiVersion: v1   # Core Kubernetes API version
kind: Service    # Service definition
metadata:
  name: my-service  
spec:
  ports:
  - port: 80
`,
            };
            assert.strictEqual(isCandidateForKubernetesScan(doc), true);
        });

        it('identifies templated manifests with Helm template expressions in apiVersion and kind', () => {
            const doc: ScannableDocument = {
                uri: { scheme: 'file', fsPath: '/workspace/charts/app/templates/custom.yaml' },
                languageId: 'yaml',
                fileName: '/workspace/charts/app/templates/custom.yaml',
                getText: () => `
apiVersion: {{ .Values.apiVersion | default "apps/v1" }}
kind: {{ .Values.kind | default "Deployment" }}
metadata:
  name: {{ .Release.Name }}-app
`,
            };
            assert.strictEqual(isCandidateForKubernetesScan(doc), true);
        });

        it('identifies any YAML file containing Helm template directives {{ ... }} as scan candidate', () => {
            const doc: ScannableDocument = {
                uri: { scheme: 'file', fsPath: '/workspace/deploy/helm-snippet.yaml' },
                languageId: 'yaml',
                fileName: '/workspace/deploy/helm-snippet.yaml',
                getText: () => `
{{- if .Values.enabled }}
someConfig: true
{{- end }}
`,
            };
            assert.strictEqual(isCandidateForKubernetesScan(doc), true);
        });

        it('identifies multi-document YAML where later document defines Kubernetes manifest', () => {
            const doc: ScannableDocument = {
                uri: { scheme: 'file', fsPath: '/workspace/k8s/multi.yaml' },
                languageId: 'yaml',
                fileName: '/workspace/k8s/multi.yaml',
                getText: () => `
# Document 1: simple note
notes: here is some doc
---
# Document 2: Kubernetes Resource
apiVersion: v1
kind: ConfigMap
metadata:
  name: app-config
data:
  KEY: value
`,
            };
            assert.strictEqual(isCandidateForKubernetesScan(doc), true);
        });

        it('identifies Kubernetes JSON manifest containing apiVersion and kind', () => {
            const doc: ScannableDocument = {
                uri: { scheme: 'file', fsPath: '/workspace/k8s/pod.json' },
                languageId: 'json',
                fileName: '/workspace/k8s/pod.json',
                getText: () => JSON.stringify({
                    apiVersion: 'v1',
                    kind: 'Pod',
                    metadata: { name: 'test-pod' },
                    spec: { containers: [{ name: 'web', image: 'nginx' }] },
                }),
            };
            assert.strictEqual(isCandidateForKubernetesScan(doc), true);
        });

        it('identifies Kubernetes JSON List objects with items array', () => {
            const doc: ScannableDocument = {
                uri: { scheme: 'file', fsPath: '/workspace/k8s/list.json' },
                languageId: 'json',
                fileName: '/workspace/k8s/list.json',
                getText: () => JSON.stringify({
                    apiVersion: 'v1',
                    kind: 'List',
                    items: [
                        { apiVersion: 'v1', kind: 'Pod', metadata: { name: 'item-pod' } },
                    ],
                }),
            };
            assert.strictEqual(isCandidateForKubernetesScan(doc), true);
        });

        it('identifies Kustomize files regardless of casing or content', () => {
            for (const name of ['kustomization.yaml', 'kustomization.yml', 'Kustomization']) {
                const doc: ScannableDocument = {
                    uri: { scheme: 'file', fsPath: `/workspace/base/${name}` },
                    languageId: 'yaml',
                    fileName: `/workspace/base/${name}`,
                    getText: () => 'resources:\n  - pod.yaml',
                };
                assert.strictEqual(isCandidateForKubernetesScan(doc), true, `Should accept ${name}`);
            }
        });

        it('identifies Helm Chart.yaml and values files (including values.staging.yaml)', () => {
            const chart: ScannableDocument = {
                uri: { scheme: 'file', fsPath: '/workspace/Chart.yaml' },
                languageId: 'yaml',
                fileName: '/workspace/Chart.yaml',
                getText: () => 'name: mychart\nversion: 1.0.0',
            };
            assert.strictEqual(isCandidateForKubernetesScan(chart), true);

            const values: ScannableDocument = {
                uri: { scheme: 'file', fsPath: '/workspace/values.staging.yaml' },
                languageId: 'yaml',
                fileName: '/workspace/values.staging.yaml',
                getText: () => 'replicas: 2\nenv: staging',
            };
            assert.strictEqual(isCandidateForKubernetesScan(values), true);
        });

        it('forwards ambiguous YAML with partial metadata and spec blocks (conservative policy)', () => {
            // An ambiguous partial YAML patch without apiVersion/kind
            const patchDoc: ScannableDocument = {
                uri: { scheme: 'file', fsPath: '/workspace/patches/resource-patch.yaml' },
                languageId: 'yaml',
                fileName: '/workspace/patches/resource-patch.yaml',
                getText: () => `
metadata:
  name: target-app
spec:
  template:
    spec:
      containers:
      - name: app
`,
            };
            // Under conservative policy, uncertain/ambiguous YAML is forwarded
            assert.strictEqual(isCandidateForKubernetesScan(patchDoc), true);
        });

        it('forwards ambiguous YAML containing kind without apiVersion', () => {
            const ambiguousDoc: ScannableDocument = {
                uri: { scheme: 'file', fsPath: '/workspace/manifests/partial.yaml' },
                languageId: 'yaml',
                fileName: '/workspace/manifests/partial.yaml',
                getText: () => `
kind: Deployment
metadata:
  name: unknown-version
`,
            };
            assert.strictEqual(isCandidateForKubernetesScan(ambiguousDoc), true);
        });

        it('confidently suppresses known non-Kubernetes JSON and YAML files', () => {
            const nonK8sFiles = [
                { path: '/workspace/package.json', lang: 'json', content: '{"name":"app","version":"1.0.0"}' },
                { path: '/workspace/tsconfig.json', lang: 'json', content: '{"compilerOptions":{"target":"es6"}}' },
                { path: '/workspace/.vscode/settings.json', lang: 'json', content: '{"editor.tabSize": 2}' },
                { path: '/workspace/.github/workflows/ci.yaml', lang: 'yaml', content: 'name: CI\non: push\njobs: { build: {} }' },
                { path: '/workspace/docker-compose.yaml', lang: 'yaml', content: 'version: "3"\nservices:\n  db: { image: postgres }' },
                { path: '/workspace/.pre-commit-config.yaml', lang: 'yaml', content: 'repos:\n  - repo: https://github.com/pre-commit/pre-commit-hooks' },
                { path: '/workspace/.gitlab-ci.yml', lang: 'yaml', content: 'stages:\n  - test\ntest_job:\n  script: npm test' },
            ];

            for (const f of nonK8sFiles) {
                const doc: ScannableDocument = {
                    uri: { scheme: 'file', fsPath: f.path },
                    languageId: f.lang,
                    fileName: f.path,
                    getText: () => f.content,
                };
                assert.strictEqual(isCandidateForKubernetesScan(doc), false, `Should suppress ${f.path}`);
            }
        });

        it('forwards Kubernetes manifest stored in .github/workflows/ (strong evidence overrides directory exclusion)', () => {
            const doc: ScannableDocument = {
                uri: { scheme: 'file', fsPath: '/workspace/.github/workflows/embedded-k8s.yaml' },
                languageId: 'yaml',
                fileName: '/workspace/.github/workflows/embedded-k8s.yaml',
                getText: () => `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: runner-deployment
spec:
  replicas: 1
`,
            };
            assert.strictEqual(isCandidateForKubernetesScan(doc), true);
        });

        it('forwards Kubernetes manifest misnamed docker-compose.yaml (strong evidence overrides filename exclusion)', () => {
            const doc: ScannableDocument = {
                uri: { scheme: 'file', fsPath: '/workspace/docker-compose.yaml' },
                languageId: 'yaml',
                fileName: '/workspace/docker-compose.yaml',
                getText: () => `
apiVersion: v1
kind: Pod
metadata:
  name: misnamed-pod
`,
            };
            assert.strictEqual(isCandidateForKubernetesScan(doc), true);
        });

        it('forwards Kubernetes JSON manifest stored in .vscode/ (strong evidence overrides directory exclusion)', () => {
            const doc: ScannableDocument = {
                uri: { scheme: 'file', fsPath: '/workspace/.vscode/k8s-pod.json' },
                languageId: 'json',
                fileName: '/workspace/.vscode/k8s-pod.json',
                getText: () => JSON.stringify({
                    apiVersion: 'v1',
                    kind: 'Pod',
                    metadata: { name: 'vscode-pod' },
                }),
            };
            assert.strictEqual(isCandidateForKubernetesScan(doc), true);
        });

        it('confidently suppresses real GitHub Actions workflows containing ${{ ... }} expressions without Kubernetes resources', () => {
            const doc: ScannableDocument = {
                uri: { scheme: 'file', fsPath: '/workspace/.github/workflows/ci.yaml' },
                languageId: 'yaml',
                fileName: '/workspace/.github/workflows/ci.yaml',
                getText: () => `
name: Build and Test
on:
  push:
    branches: [main]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
    - uses: actions/checkout@v3
    - name: Run CI
      run: |
        echo "Commit: \${{ github.sha }}"
        npm test
      env:
        NODE_AUTH_TOKEN: \${{ secrets.NPM_TOKEN }}
`,
            };
            assert.strictEqual(isCandidateForKubernetesScan(doc), false);
        });

        it('confidently suppresses real docker-compose.yaml files', () => {
            const doc: ScannableDocument = {
                uri: { scheme: 'file', fsPath: '/workspace/docker-compose.yaml' },
                languageId: 'yaml',
                fileName: '/workspace/docker-compose.yaml',
                getText: () => `
version: "3.8"
services:
  web:
    image: nginx:alpine
    ports:
      - "80:80"
  db:
    image: postgres:15
    environment:
      POSTGRES_PASSWORD: secret
`,
            };
            assert.strictEqual(isCandidateForKubernetesScan(doc), false);
        });

        it('identifies Kubernetes YAML flow mappings outside Helm and Kustomize directories (Finding D)', () => {
            const flowDoc: ScannableDocument = {
                uri: { scheme: 'file', fsPath: '/workspace/flow-manifest.yaml' },
                languageId: 'yaml',
                fileName: '/workspace/flow-manifest.yaml',
                getText: () => '{apiVersion: v1, kind: ConfigMap, metadata: {name: app}}',
            };
            assert.strictEqual(isCandidateForKubernetesScan(flowDoc), true, 'Valid YAML flow mapping must be recognized as scan candidate');

            // Arbitrary flow mappings without apiVersion/kind must be suppressed
            const arbitraryFlowDoc: ScannableDocument = {
                uri: { scheme: 'file', fsPath: '/workspace/arbitrary.yaml' },
                languageId: 'yaml',
                fileName: '/workspace/arbitrary.yaml',
                getText: () => '{name: app, count: 5, active: true}',
            };
            assert.strictEqual(isCandidateForKubernetesScan(arbitraryFlowDoc), false, 'Arbitrary YAML flow mappings must be suppressed');
        });
    });

    describe('Indirect Helm & Kustomize Dependency Scanning (Section 3 & 4 Audit)', () => {
        let tempTestDir: string;

        beforeEach(() => {
            tempTestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-indirect-dep-test-'));
        });

        afterEach(() => {
            try {
                fs.rmSync(tempTestDir, { recursive: true, force: true });
            } catch {
                // Best effort cleanup
            }
        });

        it('forwards non-Kubernetes JSON file referenced by Kustomize configMapGenerator', () => {
            const kustomizeDir = path.join(tempTestDir, 'kustomize');
            fs.mkdirSync(kustomizeDir);

            const jsonPath = path.join(kustomizeDir, 'app-settings.json');
            const jsonContent = JSON.stringify({ apiEndpoint: 'https://api.internal', debug: false });
            fs.writeFileSync(jsonPath, jsonContent);

            const kustomizationPath = path.join(kustomizeDir, 'kustomization.yaml');
            fs.writeFileSync(kustomizationPath, `apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
configMapGenerator:
- name: app-config
  files:
  - app-settings.json
`);

            const doc: ScannableDocument = {
                uri: { scheme: 'file', fsPath: jsonPath },
                languageId: 'json',
                fileName: jsonPath,
                getText: () => jsonContent,
            };

            assert.strictEqual(isKustomizeDependency(jsonPath), true, 'Must detect as Kustomize dependency');
            assert.strictEqual(isCandidateForKubernetesScan(doc), true, 'Non-Kubernetes JSON referenced by Kustomize must be forwarded');
            assert.strictEqual(shouldScanDocumentOnSave(doc), true);
        });

        it('forwards non-Kubernetes YAML file referenced by Kustomize configMapGenerator', () => {
            const kustomizeDir = path.join(tempTestDir, 'kustomize-yaml');
            fs.mkdirSync(kustomizeDir);

            const yamlPath = path.join(kustomizeDir, 'server-config.yaml');
            const yamlContent = 'server:\n  port: 8080\n  host: 0.0.0.0\n';
            fs.writeFileSync(yamlPath, yamlContent);

            fs.writeFileSync(path.join(kustomizeDir, 'kustomization.yaml'), `apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
configMapGenerator:
- name: server-config
  files:
  - server-config.yaml
`);

            const doc: ScannableDocument = {
                uri: { scheme: 'file', fsPath: yamlPath },
                languageId: 'yaml',
                fileName: yamlPath,
                getText: () => yamlContent,
            };

            assert.strictEqual(isKustomizeDependency(yamlPath), true);
            assert.strictEqual(isCandidateForKubernetesScan(doc), true, 'Non-Kubernetes YAML referenced by Kustomize must be forwarded');
        });

        it('forwards non-Kubernetes JSON file referenced by Kustomize overlay in base directory', () => {
            const baseDir = path.join(tempTestDir, 'base');
            const overlayDir = path.join(tempTestDir, 'overlay');
            fs.mkdirSync(baseDir);
            fs.mkdirSync(overlayDir);

            const baseJsonPath = path.join(baseDir, 'base-data.json');
            const baseJsonContent = JSON.stringify({ timeoutMs: 5000 });
            fs.writeFileSync(baseJsonPath, baseJsonContent);

            fs.writeFileSync(path.join(baseDir, 'kustomization.yaml'), `apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
configMapGenerator:
- name: base-data
  files:
  - base-data.json
`);

            fs.writeFileSync(path.join(overlayDir, 'kustomization.yaml'), `apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
- ../base
`);

            const doc: ScannableDocument = {
                uri: { scheme: 'file', fsPath: baseJsonPath },
                languageId: 'json',
                fileName: baseJsonPath,
                getText: () => baseJsonContent,
            };

            // Saving base-data.json without modifying kustomization.yaml must trigger scan
            assert.strictEqual(isCandidateForKubernetesScan(doc), true);
        });

        it('forwards non-Kubernetes JSON file consumed by Helm template via .Files.Get', () => {
            const chartDir = path.join(tempTestDir, 'mychart');
            const templatesDir = path.join(chartDir, 'templates');
            fs.mkdirSync(chartDir);
            fs.mkdirSync(templatesDir);

            fs.writeFileSync(path.join(chartDir, 'Chart.yaml'), `apiVersion: v2
name: mychart
version: 0.1.0
`);

            const jsonPath = path.join(chartDir, 'raw-config.json');
            const jsonContent = JSON.stringify({ rateLimit: 100, insecure: false });
            fs.writeFileSync(jsonPath, jsonContent);

            fs.writeFileSync(path.join(templatesDir, 'configmap.yaml'), `apiVersion: v1
kind: ConfigMap
metadata:
  name: my-config
data:
  raw-config.json: |-
{{ .Files.Get "raw-config.json" | indent 4 }}
`);

            const doc: ScannableDocument = {
                uri: { scheme: 'file', fsPath: jsonPath },
                languageId: 'json',
                fileName: jsonPath,
                getText: () => jsonContent,
            };

            assert.strictEqual(isHelmDependency(jsonPath), true, 'Must detect as Helm dependency');
            assert.strictEqual(isCandidateForKubernetesScan(doc), true, 'Non-Kubernetes JSON consumed by Helm .Files.Get must be forwarded');
            assert.strictEqual(shouldScanDocumentOnSave(doc), true);
        });

        it('forwards Helm JSON values files (values.json and values.staging.json)', () => {
            const chartDir = path.join(tempTestDir, 'helm-values-test');
            fs.mkdirSync(chartDir);

            const valuesJsonPath = path.join(chartDir, 'values.json');
            fs.writeFileSync(valuesJsonPath, JSON.stringify({ replicas: 2 }));

            const valuesStagingPath = path.join(chartDir, 'values.staging.json');
            fs.writeFileSync(valuesStagingPath, JSON.stringify({ replicas: 1 }));

            const doc1: ScannableDocument = {
                uri: { scheme: 'file', fsPath: valuesJsonPath },
                languageId: 'json',
                fileName: valuesJsonPath,
                getText: () => '{"replicas": 2}',
            };
            const doc2: ScannableDocument = {
                uri: { scheme: 'file', fsPath: valuesStagingPath },
                languageId: 'json',
                fileName: valuesStagingPath,
                getText: () => '{"replicas": 1}',
            };

            assert.strictEqual(isCandidateForKubernetesScan(doc1), true, 'values.json must be forwarded');
            assert.strictEqual(isCandidateForKubernetesScan(doc2), true, 'values.staging.json must be forwarded');
        });

        it('forwards non-Kubernetes JSON file inside Helm chart files/ directory', () => {
            const chartDir = path.join(tempTestDir, 'helm-files-dir');
            const filesDir = path.join(chartDir, 'files');
            fs.mkdirSync(chartDir);
            fs.mkdirSync(filesDir);

            fs.writeFileSync(path.join(chartDir, 'Chart.yaml'), 'apiVersion: v2\nname: testchart\nversion: 1.0.0\n');
            const fileJsonPath = path.join(filesDir, 'data.json');
            fs.writeFileSync(fileJsonPath, '{"nested": true}');

            const doc: ScannableDocument = {
                uri: { scheme: 'file', fsPath: fileJsonPath },
                languageId: 'json',
                fileName: fileJsonPath,
                getText: () => '{"nested": true}',
            };

            assert.strictEqual(isCandidateForKubernetesScan(doc), true, 'Files in chart files/ directory must be forwarded');
        });

        it('preserves suppression for unrelated package.json and tsconfig.json outside chart or kustomize', () => {
            const appDir = path.join(tempTestDir, 'node-app');
            fs.mkdirSync(appDir);

            const pkgPath = path.join(appDir, 'package.json');
            const tsPath = path.join(appDir, 'tsconfig.json');
            fs.writeFileSync(pkgPath, JSON.stringify({ name: 'unrelated', version: '1.0.0' }));
            fs.writeFileSync(tsPath, JSON.stringify({ compilerOptions: { target: 'es6' } }));

            const pkgDoc: ScannableDocument = {
                uri: { scheme: 'file', fsPath: pkgPath },
                languageId: 'json',
                fileName: pkgPath,
                getText: () => '{"name": "unrelated", "version": "1.0.0"}',
            };
            const tsDoc: ScannableDocument = {
                uri: { scheme: 'file', fsPath: tsPath },
                languageId: 'json',
                fileName: tsPath,
                getText: () => '{"compilerOptions": {"target": "es6"}}',
            };

            assert.strictEqual(isCandidateForKubernetesScan(pkgDoc), false, 'Unrelated package.json must be suppressed');
            assert.strictEqual(isCandidateForKubernetesScan(tsDoc), false, 'Unrelated tsconfig.json must be suppressed');
            assert.strictEqual(shouldScanDocumentOnSave(pkgDoc), false);
            assert.strictEqual(shouldScanDocumentOnSave(tsDoc), false);
        });

        it('discriminates between same-basename files across different directories preventing false-positive cross matches', () => {
            const repoRoot = path.join(tempTestDir, 'mono-repo');
            const billingDir = path.join(repoRoot, 'apps', 'billing');
            const authDir = path.join(repoRoot, 'apps', 'auth');
            fs.mkdirSync(billingDir, { recursive: true });
            fs.mkdirSync(authDir, { recursive: true });

            const billingConfig = path.join(billingDir, 'config.json');
            const authConfig = path.join(authDir, 'config.json');
            fs.writeFileSync(billingConfig, JSON.stringify({ app: 'billing' }));
            fs.writeFileSync(authConfig, JSON.stringify({ app: 'auth' }));

            // Root kustomization.yaml ONLY references apps/billing/config.json
            fs.writeFileSync(path.join(repoRoot, 'kustomization.yaml'), `apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
configMapGenerator:
- name: billing-config
  files:
  - apps/billing/config.json
`);

            const billingDoc: ScannableDocument = {
                uri: { scheme: 'file', fsPath: billingConfig },
                languageId: 'json',
                fileName: billingConfig,
                getText: () => '{"app": "billing"}',
            };
            const authDoc: ScannableDocument = {
                uri: { scheme: 'file', fsPath: authConfig },
                languageId: 'json',
                fileName: authConfig,
                getText: () => '{"app": "auth"}',
            };

            // Billing config must be recognized as dependency
            assert.strictEqual(isKustomizeDependency(billingConfig), true, 'Billing config must be forwarded');
            assert.strictEqual(isCandidateForKubernetesScan(billingDoc), true);

            // Auth config must NOT be falsely recognized just because it shares the basename config.json
            assert.strictEqual(isKustomizeDependency(authConfig), false, 'Auth config must NOT match billing reference');
            assert.strictEqual(isCandidateForKubernetesScan(authDoc), false);
        });

        it('confidently suppresses values.schema.json as a validation schema rather than workload values', () => {
            const chartDir = path.join(tempTestDir, 'schema-chart');
            fs.mkdirSync(chartDir);
            fs.writeFileSync(path.join(chartDir, 'Chart.yaml'), 'apiVersion: v2\nname: schemachart\nversion: 1.0.0\n');

            const schemaPath = path.join(chartDir, 'values.schema.json');
            const schemaContent = JSON.stringify({
                $schema: 'https://json-schema.org/draft-07/schema#',
                properties: { replicas: { type: 'integer' } },
            });
            fs.writeFileSync(schemaPath, schemaContent);

            const doc: ScannableDocument = {
                uri: { scheme: 'file', fsPath: schemaPath },
                languageId: 'json',
                fileName: schemaPath,
                getText: () => schemaContent,
            };

            // Schema edits do not change rendered workloads or security posture; must be suppressed
            assert.strictEqual(isCandidateForKubernetesScan(doc), false, 'values.schema.json must be suppressed');
            assert.strictEqual(shouldScanDocumentOnSave(doc), false);
        });

        it('traverses deeply nested directory architectures beyond 3 levels (depth = 5)', () => {
            const deepDir = path.join(tempTestDir, 'a', 'b', 'c', 'd', 'e');
            fs.mkdirSync(deepDir, { recursive: true });

            const deepJsonPath = path.join(deepDir, 'secret-config.json');
            fs.writeFileSync(deepJsonPath, JSON.stringify({ token: 'abc' }));

            // Root kustomization.yaml references deeply nested path
            fs.writeFileSync(path.join(tempTestDir, 'kustomization.yaml'), `apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
configMapGenerator:
- name: deep-config
  files:
  - a/b/c/d/e/secret-config.json
`);

            const doc: ScannableDocument = {
                uri: { scheme: 'file', fsPath: deepJsonPath },
                languageId: 'json',
                fileName: deepJsonPath,
                getText: () => '{"token": "abc"}',
            };

            assert.strictEqual(isKustomizeDependency(deepJsonPath), true, 'Must traverse beyond 3 parent levels');
            assert.strictEqual(isCandidateForKubernetesScan(doc), true);
        });

        it('forwards non-Kubernetes JSON file consumed by Helm template with computed or variable .Files.Get', () => {
            const chartDir = path.join(tempTestDir, 'computed-chart');
            const templatesDir = path.join(chartDir, 'templates');
            fs.mkdirSync(chartDir);
            fs.mkdirSync(templatesDir);

            fs.writeFileSync(path.join(chartDir, 'Chart.yaml'), 'apiVersion: v2\nname: computed\nversion: 1.0.0\n');
            const confPath = path.join(chartDir, 'dynamic.json');
            fs.writeFileSync(confPath, '{"port": 9090}');

            // Template uses computed expression (printf) with .Files.Get
            fs.writeFileSync(path.join(templatesDir, 'config.yaml'), `apiVersion: v1
kind: ConfigMap
metadata:
  name: dynamic-config
data:
  content: |-
{{ .Files.Get (printf "%s.json" .Values.confName) | indent 4 }}
`);

            const doc: ScannableDocument = {
                uri: { scheme: 'file', fsPath: confPath },
                languageId: 'json',
                fileName: confPath,
                getText: () => '{"port": 9090}',
            };

            assert.strictEqual(isHelmDependency(confPath), true, 'Must detect computed .Files.Get');
            assert.strictEqual(isCandidateForKubernetesScan(doc), true);
        });

        it('invalidates Helm template cache when existing template is edited in-place to add .Files.Get', async () => {
            const chartDir = path.join(tempTestDir, 'helm-add-ref-test');
            const templatesDir = path.join(chartDir, 'templates');
            fs.mkdirSync(chartDir);
            fs.mkdirSync(templatesDir);

            fs.writeFileSync(path.join(chartDir, 'Chart.yaml'), 'apiVersion: v2\nname: addref\nversion: 1.0.0\n');
            const templatePath = path.join(templatesDir, 'configmap.yaml');
            const jsonPath = path.join(chartDir, 'target.json');
            fs.writeFileSync(jsonPath, '{"key": "value"}');

            // 1. Initial template without .Files.Get
            fs.writeFileSync(templatePath, 'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: cm\n');

            const doc: ScannableDocument = {
                uri: { scheme: 'file', fsPath: jsonPath },
                languageId: 'json',
                fileName: jsonPath,
                getText: () => '{"key": "value"}',
            };

            // First evaluation caches: target.json is NOT a dependency
            assert.strictEqual(isHelmDependency(jsonPath), false, 'Initially not a dependency');
            assert.strictEqual(isCandidateForKubernetesScan(doc), false);

            // Wait briefly to ensure mtime changes on disk
            await new Promise((resolve) => setTimeout(resolve, 50));

            // 2. Modify EXISTING template in-place to add .Files.Get "target.json"
            fs.writeFileSync(
                templatePath,
                'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: cm\ndata:\n  raw: |- {{ .Files.Get "target.json" }}\n'
            );

            // Invalidation must detect the template file modification and refresh cache
            assert.strictEqual(isHelmDependency(jsonPath), true, 'Must refresh cache and recognize dependency after in-place edit');
            assert.strictEqual(isCandidateForKubernetesScan(doc), true);
        });

        it('invalidates Helm template cache when existing template is edited in-place to remove .Files.Get (reverse transition)', async () => {
            const chartDir = path.join(tempTestDir, 'helm-remove-ref-test');
            const templatesDir = path.join(chartDir, 'templates');
            fs.mkdirSync(chartDir);
            fs.mkdirSync(templatesDir);

            fs.writeFileSync(path.join(chartDir, 'Chart.yaml'), 'apiVersion: v2\nname: removeref\nversion: 1.0.0\n');
            const templatePath = path.join(templatesDir, 'configmap.yaml');
            const jsonPath = path.join(chartDir, 'target.json');
            fs.writeFileSync(jsonPath, '{"key": "value"}');

            // 1. Initial template with .Files.Get "target.json"
            fs.writeFileSync(
                templatePath,
                'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: cm\ndata:\n  raw: |- {{ .Files.Get "target.json" }}\n'
            );

            const doc: ScannableDocument = {
                uri: { scheme: 'file', fsPath: jsonPath },
                languageId: 'json',
                fileName: jsonPath,
                getText: () => '{"key": "value"}',
            };

            // Initially cached as dependency
            assert.strictEqual(isHelmDependency(jsonPath), true, 'Initially recognized as dependency');
            assert.strictEqual(isCandidateForKubernetesScan(doc), true);

            // Wait briefly to ensure mtime changes on disk
            await new Promise((resolve) => setTimeout(resolve, 50));

            // 2. Modify EXISTING template in-place to REMOVE .Files.Get
            fs.writeFileSync(templatePath, 'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: cm\n');

            // Invalidation must detect the template file edit and refresh cache
            assert.strictEqual(isHelmDependency(jsonPath), false, 'Must refresh cache and suppress target.json after reference removed');
            assert.strictEqual(isCandidateForKubernetesScan(doc), false);
        });

        it('invalidates Kustomize cache when kustomization.yaml is modified or removed', async () => {
            const kDir = path.join(tempTestDir, 'kustomize-inval-test');
            fs.mkdirSync(kDir);
            const kPath = path.join(kDir, 'kustomization.yaml');
            const jsonPath = path.join(kDir, 'app-data.json');
            fs.writeFileSync(jsonPath, '{"data": 123}');

            // 1. Initial kustomization referencing app-data.json
            fs.writeFileSync(kPath, 'apiVersion: kustomize.config.k8s.io/v1beta1\nkind: Kustomization\nconfigMapGenerator:\n- name: my-cm\n  files:\n  - app-data.json\n');

            const doc: ScannableDocument = {
                uri: { scheme: 'file', fsPath: jsonPath },
                languageId: 'json',
                fileName: jsonPath,
                getText: () => '{"data": 123}',
            };

            assert.strictEqual(isKustomizeDependency(jsonPath), true, 'Initially referenced');
            assert.strictEqual(isCandidateForKubernetesScan(doc), true);

            await new Promise((resolve) => setTimeout(resolve, 50));

            // 2. Modify kustomization.yaml in-place to remove app-data.json
            fs.writeFileSync(kPath, 'apiVersion: kustomize.config.k8s.io/v1beta1\nkind: Kustomization\nconfigMapGenerator:\n- name: other-cm\n  files:\n  - other.json\n');

            assert.strictEqual(isKustomizeDependency(jsonPath), false, 'Must invalidate cache when reference is removed');
            assert.strictEqual(isCandidateForKubernetesScan(doc), false);

            await new Promise((resolve) => setTimeout(resolve, 50));

            // 3. Delete kustomization.yaml
            fs.unlinkSync(kPath);
            assert.strictEqual(isKustomizeDependency(jsonPath), false, 'Must detect missing kustomization.yaml and clean cache');
            assert.strictEqual(isCandidateForKubernetesScan(doc), false);
        });

        it('supports single quotes, backticks, and piped invocations for Helm .Files.Get', () => {
            // 1. Single quotes chart
            const singleDir = path.join(tempTestDir, 'helm-single-chart');
            const singleTmplDir = path.join(singleDir, 'templates');
            fs.mkdirSync(singleDir);
            fs.mkdirSync(singleTmplDir);
            fs.writeFileSync(path.join(singleDir, 'Chart.yaml'), 'apiVersion: v2\nname: single\nversion: 1.0.0\n');

            const singleQuotePath = path.join(singleDir, 'single.json');
            const unrefSingle = path.join(singleDir, 'unref.json');
            fs.writeFileSync(singleQuotePath, '{}');
            fs.writeFileSync(unrefSingle, '{}');
            fs.writeFileSync(path.join(singleTmplDir, 'single.yaml'), "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: s\ndata:\n  v: |- {{ .Files.Get 'single.json' }}\n");

            assert.strictEqual(isHelmDependency(singleQuotePath), true, 'Must support single quotes');
            assert.strictEqual(isHelmDependency(unrefSingle), false, 'Unreferenced sibling in single quote chart must not match');

            // 2. Backticks chart
            const backtickDir = path.join(tempTestDir, 'helm-backtick-chart');
            const backtickTmplDir = path.join(backtickDir, 'templates');
            fs.mkdirSync(backtickDir);
            fs.mkdirSync(backtickTmplDir);
            fs.writeFileSync(path.join(backtickDir, 'Chart.yaml'), 'apiVersion: v2\nname: backtick\nversion: 1.0.0\n');

            const backtickPath = path.join(backtickDir, 'backtick.json');
            const unrefBacktick = path.join(backtickDir, 'unref.json');
            fs.writeFileSync(backtickPath, '{}');
            fs.writeFileSync(unrefBacktick, '{}');
            fs.writeFileSync(path.join(backtickTmplDir, 'backtick.yaml'), 'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: b\ndata:\n  v: |- {{ .Files.Get `backtick.json` }}\n');

            assert.strictEqual(isHelmDependency(backtickPath), true, 'Must support backticks');
            assert.strictEqual(isHelmDependency(unrefBacktick), false, 'Unreferenced sibling in backtick chart must not match');

            // 3. Piped chart
            const pipedDir = path.join(tempTestDir, 'helm-piped-chart');
            const pipedTmplDir = path.join(pipedDir, 'templates');
            fs.mkdirSync(pipedDir);
            fs.mkdirSync(pipedTmplDir);
            fs.writeFileSync(path.join(pipedDir, 'Chart.yaml'), 'apiVersion: v2\nname: piped\nversion: 1.0.0\n');

            const pipedPath = path.join(pipedDir, 'piped.json');
            fs.writeFileSync(pipedPath, '{}');
            fs.writeFileSync(path.join(pipedTmplDir, 'piped.yaml'), 'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: p\ndata:\n  v: |- {{ "piped.json" | .Files.Get }}\n');

            assert.strictEqual(isHelmDependency(pipedPath), true, 'Must support piped .Files.Get');
        });

        it('forwards empty file referenced by Kustomize generator and suppresses unrelated empty files (Finding B1)', () => {
            const kustomizeDir = path.join(tempTestDir, 'empty-dep-test');
            fs.mkdirSync(kustomizeDir);
            const emptyGenFile = path.join(kustomizeDir, 'empty-config.json');
            fs.writeFileSync(emptyGenFile, ''); // 0 bytes

            const kPath = path.join(kustomizeDir, 'kustomization.yaml');
            fs.writeFileSync(kPath, `apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
configMapGenerator:
- name: gen-cm
  files:
  - empty-config.json
`);

            const emptyGenDoc: ScannableDocument = {
                uri: { scheme: 'file', fsPath: emptyGenFile },
                languageId: 'json',
                fileName: emptyGenFile,
                getText: () => '',
            };
            assert.strictEqual(shouldScanDocumentOnSave(emptyGenDoc), true, 'Empty file referenced by generator must trigger scan');

            // Unrelated empty file outside Kustomize/Helm must remain suppressed
            const unrelatedEmptyFile = path.join(tempTestDir, 'unrelated-empty.json');
            fs.writeFileSync(unrelatedEmptyFile, '   \n  ');
            const unrelatedEmptyDoc: ScannableDocument = {
                uri: { scheme: 'file', fsPath: unrelatedEmptyFile },
                languageId: 'json',
                fileName: unrelatedEmptyFile,
                getText: () => '   \n  ',
            };
            assert.strictEqual(shouldScanDocumentOnSave(unrelatedEmptyDoc), false, 'Unrelated empty file must remain suppressed');
        });

        it('enforces exact path matching and avoids suffix match collisions (Finding B2)', () => {
            const kustomizeDir = path.join(tempTestDir, 'exact-path-kustomize');
            const subDir = path.join(kustomizeDir, 'sub');
            fs.mkdirSync(kustomizeDir);
            fs.mkdirSync(subDir);

            // Two files with identical basename 'config.json': root and sub
            const rootConfig = path.join(kustomizeDir, 'config.json');
            const subConfig = path.join(subDir, 'config.json');
            fs.writeFileSync(rootConfig, '{"root": true}');
            fs.writeFileSync(subConfig, '{"sub": true}');

            // Kustomization references ONLY 'sub/config.json'
            const kPath = path.join(kustomizeDir, 'kustomization.yaml');
            fs.writeFileSync(kPath, `apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
configMapGenerator:
- name: sub-cm
  files:
  - sub/config.json
`);

            // sub/config.json must match
            assert.strictEqual(isKustomizeDependency(subConfig), true, 'Referenced sub/config.json must match');

            // root config.json must NOT match (suffix matching is prohibited)
            assert.strictEqual(isKustomizeDependency(rootConfig), false, 'Unreferenced root config.json must NOT match sub/config.json reference');

            // Also verify preservation of valid reference formats: ./config.json, config//settings.json
            const settingsDir = path.join(kustomizeDir, 'config');
            fs.mkdirSync(settingsDir);
            const settingsFile = path.join(settingsDir, 'settings.json');
            fs.writeFileSync(settingsFile, '{"settings": true}');

            fs.writeFileSync(kPath, `apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
configMapGenerator:
- name: multi-cm
  files:
  - ./config.json
  - config//settings.json
`);
            assert.strictEqual(isKustomizeDependency(rootConfig), true, 'Must match ./config.json normalized');
            assert.strictEqual(isKustomizeDependency(settingsFile), true, 'Must match config//settings.json normalized');
        });

        it('invalidates Kustomize cache on content changes, same-size replacement with preserved mtime, and deletion (Finding B3)', () => {
            const kustomizeDir = path.join(tempTestDir, 'cache-identity-kustomize');
            fs.mkdirSync(kustomizeDir);

            const fileA = path.join(kustomizeDir, 'a.json');
            const fileB = path.join(kustomizeDir, 'b.json');
            fs.writeFileSync(fileA, '{"a": 1}');
            fs.writeFileSync(fileB, '{"b": 2}');

            const kPath = path.join(kustomizeDir, 'kustomization.yaml');
            // 1. Initial: references a.json
            const contentA = 'apiVersion: kustomize.config.k8s.io/v1beta1\nkind: Kustomization\nconfigMapGenerator:\n- name: cm\n  files:\n  - a.json\n';
            fs.writeFileSync(kPath, contentA);

            assert.strictEqual(isKustomizeDependency(fileA), true, 'Initial reference to a.json');
            assert.strictEqual(isKustomizeDependency(fileB), false);

            // 2. Same-size replacement with the exact timestamp restored. A known whole-second
            // timestamp avoids losing fractional milliseconds when converting mtimeMs to a Date.
            const knownTime = new Date(1700000000 * 1000);
            fs.utimesSync(kPath, knownTime, knownTime);
            assert.strictEqual(isKustomizeDependency(fileA), true, 'Cache primed with a.json');
            const statBefore = fs.statSync(kPath);
            const contentB = 'apiVersion: kustomize.config.k8s.io/v1beta1\nkind: Kustomization\nconfigMapGenerator:\n- name: cm\n  files:\n  - b.json\n';
            assert.strictEqual(Buffer.byteLength(contentA), Buffer.byteLength(contentB), 'Must be identical byte size');
            fs.writeFileSync(kPath, contentB);
            fs.utimesSync(kPath, knownTime, knownTime); // Restore the exact known timestamp
            const statAfter = fs.statSync(kPath);
            assert.strictEqual(statAfter.size, statBefore.size, 'Size must be unchanged');
            assert.strictEqual(statAfter.mtimeMs, statBefore.mtimeMs, 'mtimeMs must be unchanged');

            // Content-based identity must detect hash change despite identical mtime and size
            assert.strictEqual(isKustomizeDependency(fileA), false, 'a.json must be invalidated despite preserved mtime');
            assert.strictEqual(isKustomizeDependency(fileB), true, 'b.json must now be recognized as dependency');

            // 3. Unchanged-content cache reuse
            assert.strictEqual(isKustomizeDependency(fileB), true, 'Cached dependency result must be reused');

            // 4. File deletion and recreation
            fs.unlinkSync(kPath);
            assert.strictEqual(isKustomizeDependency(fileB), false, 'Deleted kustomization.yaml must invalidate');
            fs.writeFileSync(kPath, contentB);
            assert.strictEqual(isKustomizeDependency(fileB), true, 'Recreated kustomization.yaml must be detected');
        });

        it('invalidates Helm template cache on content change with preserved mtime and same size (Finding C1)', () => {
            const chartDir = path.join(tempTestDir, 'helm-content-cache-chart');
            const templatesDir = path.join(chartDir, 'templates');
            fs.mkdirSync(chartDir);
            fs.mkdirSync(templatesDir);
            fs.writeFileSync(path.join(chartDir, 'Chart.yaml'), 'apiVersion: v2\nname: test\nversion: 1.0.0\n');

            const fileA = path.join(chartDir, 'a.json');
            const fileB = path.join(chartDir, 'b.json');
            fs.writeFileSync(fileA, '{"a": 1}');
            fs.writeFileSync(fileB, '{"b": 2}');

            const tmplPath = path.join(templatesDir, 'config.yaml');
            const tmplContentA = 'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: cm\ndata:\n  val: |- {{ .Files.Get "a.json" }}\n';
            fs.writeFileSync(tmplPath, tmplContentA);

            assert.strictEqual(isHelmDependency(fileA), true, 'Initially references a.json');
            assert.strictEqual(isHelmDependency(fileB), false);

            // Same-size replacement in template with the exact known timestamp restored
            const knownTime = new Date(1700000000 * 1000);
            fs.utimesSync(tmplPath, knownTime, knownTime);
            assert.strictEqual(isHelmDependency(fileA), true, 'Cache primed with a.json');
            const statBefore = fs.statSync(tmplPath);
            const tmplContentB = 'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: cm\ndata:\n  val: |- {{ .Files.Get "b.json" }}\n';
            assert.strictEqual(Buffer.byteLength(tmplContentA), Buffer.byteLength(tmplContentB));
            fs.writeFileSync(tmplPath, tmplContentB);
            fs.utimesSync(tmplPath, knownTime, knownTime); // Restore the exact known timestamp
            const statAfter = fs.statSync(tmplPath);
            assert.strictEqual(statAfter.size, statBefore.size, 'Size must be unchanged');
            assert.strictEqual(statAfter.mtimeMs, statBefore.mtimeMs, 'mtimeMs must be unchanged');

            // Content-based template hash must invalidate chart cache
            assert.strictEqual(isHelmDependency(fileA), false, 'a.json must be invalidated on content change with preserved mtime');
            assert.strictEqual(isHelmDependency(fileB), true, 'b.json must be recognized');
        });

        it('recognizes Helm .Files aliases e.g. $files := .Files (Finding C2)', () => {
            const chartDir = path.join(tempTestDir, 'helm-alias-chart');
            const templatesDir = path.join(chartDir, 'templates');
            fs.mkdirSync(chartDir);
            fs.mkdirSync(templatesDir);
            fs.writeFileSync(path.join(chartDir, 'Chart.yaml'), 'apiVersion: v2\nname: alias\nversion: 1.0.0\n');

            const settingsPath = path.join(chartDir, 'settings.json');
            fs.writeFileSync(settingsPath, '{"debug": true}');

            fs.writeFileSync(path.join(templatesDir, 'deployment.yaml'), `apiVersion: apps/v1
kind: Deployment
metadata:
  name: app
spec:
  template:
    spec:
      containers:
      - name: web
        image: nginx
        env:
        - name: CFG
          value: |-
            {{ $files := .Files }}
            {{ $files.Get "settings.json" }}
`);

            assert.strictEqual(isHelmDependency(settingsPath), true, 'Must recognize .Files alias $files.Get');
        });

        it('treats chart as uncertain when template cannot be read without caching negative result (Finding C3)', () => {
            const chartDir = path.join(tempTestDir, 'helm-err-chart');
            const templatesDir = path.join(chartDir, 'templates');
            fs.mkdirSync(chartDir);
            fs.mkdirSync(templatesDir);
            fs.writeFileSync(path.join(chartDir, 'Chart.yaml'), 'apiVersion: v2\nname: err\nversion: 1.0.0\n');

            const targetJson = path.join(chartDir, 'data.json');
            fs.writeFileSync(targetJson, '{"key": "val"}');

            const brokenTmpl = path.join(templatesDir, 'broken.yaml');
            fs.writeFileSync(brokenTmpl, 'some template content');

            // Deterministic read failure for exactly this template (no chmod, platform independent)
            const realReadFileSync = fs.readFileSync;
            let injectFailure = true;
            (fs as any).readFileSync = function (this: unknown, file: any, ...rest: any[]) {
                if (injectFailure && typeof file === 'string' && path.resolve(file) === path.resolve(brokenTmpl)) {
                    const err: NodeJS.ErrnoException = new Error('EACCES: injected read failure');
                    err.code = 'EACCES';
                    throw err;
                }
                return (realReadFileSync as any).call(this, file, ...rest);
            };

            try {
                // When template reading fails, chart is treated as uncertain -> returns true without persistent negative cache
                assert.strictEqual(isHelmDependency(targetJson), true, 'Uncertain chart with read errors must forward save');

                // Restore normal reads; the template has no reference, so the chart is no longer uncertain
                injectFailure = false;
                assert.strictEqual(isHelmDependency(targetJson), false, 'Incomplete result must not have been cached as a dependency');

                // Make the template reference the file: dependency now detected
                fs.writeFileSync(brokenTmpl, 'data: {{ .Files.Lines "data.json" }}\n');
                assert.strictEqual(isHelmDependency(targetJson), true, 'Next analysis must detect the .Files.Lines dependency');
            } finally {
                (fs as any).readFileSync = realReadFileSync;
            }
        });

        it('resolves Helm .Files.Get strictly chart-relative without basename fallback (Finding C4)', () => {
            const chartDir = path.join(tempTestDir, 'helm-literal-matching-chart');
            const templatesDir = path.join(chartDir, 'templates');
            const toolsDir = path.join(chartDir, 'tools');
            fs.mkdirSync(chartDir);
            fs.mkdirSync(templatesDir);
            fs.mkdirSync(toolsDir);
            fs.writeFileSync(path.join(chartDir, 'Chart.yaml'), 'apiVersion: v2\nname: match\nversion: 1.0.0\n');

            const rootConfig = path.join(chartDir, 'config.json');
            const toolsConfig = path.join(toolsDir, 'config.json');
            fs.writeFileSync(rootConfig, '{"root": true}');
            fs.writeFileSync(toolsConfig, '{"tools": true}');

            // Template strictly requests chart-relative root "config.json"
            fs.writeFileSync(path.join(templatesDir, 'configmap.yaml'), `apiVersion: v1
kind: ConfigMap
metadata:
  name: test-cm
data:
  config: |- {{ .Files.Get "config.json" }}
`);

            assert.strictEqual(isHelmDependency(rootConfig), true, 'Exact chart-relative config.json must match');
            assert.strictEqual(isHelmDependency(toolsConfig), false, 'tools/config.json must NOT match root config.json literal');
        });

        it('safely handles non-existent or inaccessible file paths without throwing', () => {
            assert.strictEqual(isKustomizeDependency('/non/existent/file.json'), false);
            assert.strictEqual(isHelmDependency('/non/existent/file.json'), false);
        });
    });

    describe('Middleware Lifecycle & Scoped Override Audit (Section 2 Audit)', () => {
        it('scopes force-scan override to exact document URI preventing cross-document leakage', () => {
            const targetDoc: ScannableDocument = {
                uri: { scheme: 'file', fsPath: '/workspace/custom-tool.yaml' },
                languageId: 'yaml',
                fileName: '/workspace/custom-tool.yaml',
                getText: () => 'tool: custom',
            };

            const otherDoc: ScannableDocument = {
                uri: { scheme: 'file', fsPath: '/workspace/package.json' },
                languageId: 'json',
                fileName: '/workspace/package.json',
                getText: () => JSON.stringify({ name: 'other' }),
            };

            // Arm forced scan for targetDoc
            forceScanForDocument(targetDoc);
            assert.strictEqual(isScanForcedForDocument(targetDoc), true);
            assert.strictEqual(isScanForcedForDocument(otherDoc), false);

            // An intervening save of otherDoc must NOT consume targetDoc's override
            assert.strictEqual(shouldScanDocumentOnSave(otherDoc), false);
            assert.strictEqual(isScanForcedForDocument(targetDoc), true, 'Override must still belong to targetDoc');

            // Saving targetDoc consumes its override
            assert.strictEqual(shouldScanDocumentOnSave(targetDoc), true);

            // Override is now consumed exactly once
            assert.strictEqual(isScanForcedForDocument(targetDoc), false);
            assert.strictEqual(shouldScanDocumentOnSave(targetDoc), false);
        });

        it('resets forced scan state on client disposal or restart', () => {
            const doc: ScannableDocument = {
                uri: { scheme: 'file', fsPath: '/workspace/doc.yaml' },
                languageId: 'yaml',
                fileName: '/workspace/doc.yaml',
                getText: () => 'tool: custom',
            };

            forceScanForDocument(doc);
            assert.strictEqual(isScanForcedForDocument(doc), true);

            // Client manager disposal resets override state
            resetForceScanState();
            assert.strictEqual(isScanForcedForDocument(doc), false);
            assert.strictEqual(shouldScanDocumentOnSave(doc), false);
        });

        it('expires forced scan override after timeout using controlled clock (Finding G)', () => {
            let mockTime = 100000;
            setTimeProvider(() => mockTime);
            try {
                // Assertion 1: Consumption before expiration
                const doc1: ScannableDocument = {
                    uri: { scheme: 'file', fsPath: '/workspace/valid-override.yaml' },
                    languageId: 'yaml',
                    fileName: '/workspace/valid-override.yaml',
                    getText: () => 'tool: custom',
                };
                forceScanForDocument(doc1, undefined, 5000);
                assert.strictEqual(isScanForcedForDocument(doc1), true);

                // Advance clock within timeout window: consumption succeeds
                mockTime += 2000;
                assert.strictEqual(consumeForceScan(doc1), true, 'Override must be consumable before expiration');
                assert.strictEqual(consumeForceScan(doc1), false, 'Override must be consumed strictly once');

                // Assertion 2: Fresh independent override expires after timeout
                const doc2: ScannableDocument = {
                    uri: { scheme: 'file', fsPath: '/workspace/expired-override.yaml' },
                    languageId: 'yaml',
                    fileName: '/workspace/expired-override.yaml',
                    getText: () => 'tool: custom2',
                };
                forceScanForDocument(doc2, undefined, 5000);
                assert.strictEqual(isScanForcedForDocument(doc2), true);

                // Advance clock beyond timeout window
                mockTime += 6000;
                // Verify rejection after expiration WITHOUT calling resetForceScanState
                assert.strictEqual(isScanForcedForDocument(doc2), false, 'Override must be expired');
                assert.strictEqual(consumeForceScan(doc2), false, 'Expired override must not be consumable');
                assert.strictEqual(shouldScanDocumentOnSave(doc2), false, 'Expired document must not trigger scan');
            } finally {
                resetTimeProvider();
            }
        });

        it('consumeForceScan itself rejects and cleans up an expired attempt without a prior isScanForced check', () => {
            let mockTime = 500000;
            setTimeProvider(() => mockTime);
            try {
                const expiring: ScannableDocument = {
                    uri: { scheme: 'file', fsPath: '/workspace/direct-expired.yaml' },
                    languageId: 'yaml',
                    fileName: '/workspace/direct-expired.yaml',
                    getText: () => 'tool: custom',
                };
                forceScanForDocument(expiring, undefined, 5000); // unmanaged / inactive attempt
                mockTime += 6000; // beyond expiry

                // Direct consumption, deliberately NOT preceded by isScanForcedForDocument()
                assert.strictEqual(consumeForceScan(expiring), false, 'Expired attempt must not be consumable');

                // The entry was removed: even with the clock rewound before expiry nothing is pending
                mockTime -= 6000;
                assert.strictEqual(isScanForcedForDocument(expiring), false, 'Expired entry must have been cleaned up');
                assert.strictEqual(consumeForceScan(expiring), false);

                // Pre-expiry control case on a separate attempt still consumes exactly once
                forceScanForDocument(expiring, undefined, 5000);
                mockTime += 4000;
                assert.strictEqual(consumeForceScan(expiring), true);
                assert.strictEqual(consumeForceScan(expiring), false);
            } finally {
                resetTimeProvider();
            }
        });

        it('clears pending forced scans for retiring client without clearing a new client active attempt (Finding A2)', () => {
            const retiringClientId = 'client_retiring_123';
            const newClientId = 'client_active_456';

            const retiringDoc: ScannableDocument = {
                uri: { scheme: 'file', fsPath: '/workspace/retiring.yaml' },
                languageId: 'yaml',
                fileName: '/workspace/retiring.yaml',
                getText: () => 'custom: retiring',
            };

            const newClientDoc: ScannableDocument = {
                uri: { scheme: 'file', fsPath: '/workspace/new-client.yaml' },
                languageId: 'yaml',
                fileName: '/workspace/new-client.yaml',
                getText: () => 'custom: new',
            };

            forceScanForDocument(retiringDoc, retiringClientId);
            forceScanForDocument(newClientDoc, newClientId);

            assert.strictEqual(isScanForcedForDocument(retiringDoc, retiringClientId), true);
            assert.strictEqual(isScanForcedForDocument(newClientDoc, newClientId), true);

            // Retiring client stops/restarts and clears only its own forced scan state
            clearForcedScansForOwner(retiringClientId);

            // Retiring client attempt is purged
            assert.strictEqual(isScanForcedForDocument(retiringDoc, retiringClientId), false);
            assert.strictEqual(consumeForceScan(retiringDoc, retiringClientId), false);

            // New client attempt remains completely intact
            assert.strictEqual(isScanForcedForDocument(newClientDoc, newClientId), true);
            assert.strictEqual(consumeForceScan(newClientDoc, newClientId), true);
        });

        it('ensures an active manual save attempt cannot expire after 60s while still active, and cleans up when ended without didSave (Finding A3)', () => {
            let mockTime = 50000;
            setTimeProvider(() => mockTime);
            try {
                const doc: ScannableDocument = {
                    uri: { scheme: 'file', fsPath: '/workspace/slow-active-save.yaml' },
                    languageId: 'yaml',
                    fileName: '/workspace/slow-active-save.yaml',
                    getText: () => 'tool: custom',
                };

                // 1. Arm an active save attempt (managed attempt)
                const attempt = armForcedScan(doc);
                assert.strictEqual(attempt.isActive, true);
                assert.strictEqual(isScanForcedForDocument(doc), true);

                // 2. Advance clock by 120 seconds (far beyond the 60s timeout) while save attempt is still active
                mockTime += 120000;

                // 3. Since the attempt is still active, elapsed time alone MUST NOT invalidate it
                assert.strictEqual(isScanForcedForDocument(doc), true, 'Active attempt must not expire merely due to elapsed time');

                // 4. A matching didSave arrives and successfully consumes the active override
                assert.strictEqual(shouldScanDocumentOnSave(doc), true, 'didSave must be forwarded for active attempt even after 120s');
                assert.strictEqual(attempt.isConsumed, true);
                assert.strictEqual(attempt.isActive, false);

                // 5. Override was consumed exactly once; subsequent ordinary save is not forced
                assert.strictEqual(shouldScanDocumentOnSave(doc), false, 'Subsequent ordinary save must not be forced');

                // 6. Test cleanup after an attempt ends without didSave (e.g. read-only file or user cancel)
                const failedDoc: ScannableDocument = {
                    uri: { scheme: 'file', fsPath: '/workspace/failed-save.yaml' },
                    languageId: 'yaml',
                    fileName: '/workspace/failed-save.yaml',
                    getText: () => 'tool: custom',
                };
                const failedAttempt = armForcedScan(failedDoc);
                assert.strictEqual(failedAttempt.isActive, true);
                assert.strictEqual(isScanForcedForDocument(failedDoc), true);

                // Simulate save attempt ending without didSave
                failedAttempt.revoke();
                failedAttempt.complete();

                // Attempt must be immediately cleaned up and inactive
                assert.strictEqual(failedAttempt.isActive, false);
                assert.strictEqual(isScanForcedForDocument(failedDoc), false);
                assert.strictEqual(shouldScanDocumentOnSave(failedDoc), false, 'Subsequent ordinary save must never consume ended attempt');

                // 7. Verify an abandoned unmanaged attempt expires after the timeout and does not remain armed indefinitely
                const abandonedDoc: ScannableDocument = {
                    uri: { scheme: 'file', fsPath: '/workspace/abandoned.yaml' },
                    languageId: 'yaml',
                    fileName: '/workspace/abandoned.yaml',
                    getText: () => 'tool: custom',
                };
                forceScanForDocument(abandonedDoc, undefined, 60000);
                assert.strictEqual(isScanForcedForDocument(abandonedDoc), true);

                mockTime += 70000; // Past 60s abandoned timeout
                assert.strictEqual(isScanForcedForDocument(abandonedDoc), false, 'Abandoned attempt must expire and not remain armed indefinitely');
                assert.strictEqual(consumeForceScan(abandonedDoc), false, 'Expired abandoned attempt must not be consumed');
            } finally {
                resetTimeProvider();
            }
        });

        it('immediately revokes forced scan override via clearForcedScan if save operation fails or cancels', () => {
            const doc: ScannableDocument = {
                uri: { scheme: 'file', fsPath: '/workspace/non-k8s.yaml' },
                languageId: 'yaml',
                fileName: '/workspace/non-k8s.yaml',
                getText: () => 'custom: data',
            };

            const key = forceScanForDocument(doc);
            assert.strictEqual(isScanForcedForDocument(doc), true);

            // Simulate command execution throwing or returning false -> clearForcedScan invoked
            clearForcedScan(key);

            // Override must be revoked immediately without waiting for 10-second timeout
            assert.strictEqual(isScanForcedForDocument(doc), false);
            assert.strictEqual(shouldScanDocumentOnSave(doc), false);
        });

        it('handles URI normalization edge cases and avoids [object Object] collisions', () => {
            // Mock document where uri has no custom toString
            const docWithoutToString: ScannableDocument = {
                uri: { scheme: 'file', fsPath: '/workspace/docA.yaml' },
                languageId: 'yaml',
                fileName: '/workspace/docA.yaml',
                getText: () => 'custom: docA',
            };

            const keyA = getDocumentKey(docWithoutToString);
            assert.strictEqual(keyA, '/workspace/docA.yaml');

            // Plain object with Object.prototype.toString
            const plainObjDoc: ScannableDocument = {
                uri: Object.create(Object.prototype, {
                    scheme: { value: 'file' },
                    fsPath: { value: '/workspace/docB.yaml' },
                }),
                languageId: 'yaml',
                fileName: '/workspace/docB.yaml',
                getText: () => 'custom: docB',
            };

            const keyB = getDocumentKey(plainObjDoc);
            assert.strictEqual(keyB, '/workspace/docB.yaml');
            assert.notStrictEqual(keyA, keyB);
        });
    });

    describe('Multi-Root Workspace Isolation & Middleware Simulation (Section 4 Audit)', () => {
        it('evaluates documents from multiple workspace roots independently without state leakage', () => {
            const root1Doc: ScannableDocument = {
                uri: { scheme: 'file', fsPath: '/workspace-a/pod.yaml' },
                languageId: 'yaml',
                fileName: '/workspace-a/pod.yaml',
                getText: () => 'apiVersion: v1\nkind: Pod\nmetadata:\n  name: a-pod',
            };

            const root2Doc: ScannableDocument = {
                uri: { scheme: 'file', fsPath: '/workspace-b/package.json' },
                languageId: 'json',
                fileName: '/workspace-b/package.json',
                getText: () => JSON.stringify({ name: 'b-app' }),
            };

            assert.strictEqual(shouldScanDocumentOnSave(root1Doc), true);
            assert.strictEqual(shouldScanDocumentOnSave(root2Doc), false);
        });

        it('middleware didSave correctly invokes next() only for candidates', async () => {
            const saved: string[] = [];
            const mockNext = async (doc: ScannableDocument) => {
                saved.push(doc.fileName);
            };

            const k8sDoc: ScannableDocument = {
                uri: { scheme: 'file', fsPath: '/workspace/k8s.yaml' },
                languageId: 'yaml',
                fileName: '/workspace/k8s.yaml',
                getText: () => 'apiVersion: v1\nkind: Service\nmetadata:\n  name: svc',
            };

            const packageDoc: ScannableDocument = {
                uri: { scheme: 'file', fsPath: '/workspace/package.json' },
                languageId: 'json',
                fileName: '/workspace/package.json',
                getText: () => '{"name":"package"}',
            };

            // Simulate middleware callback for k8sDoc
            if (shouldScanDocumentOnSave(k8sDoc)) {
                await mockNext(k8sDoc);
            }
            // Simulate middleware callback for packageDoc
            if (shouldScanDocumentOnSave(packageDoc)) {
                await mockNext(packageDoc);
            }

            assert.deepStrictEqual(saved, ['/workspace/k8s.yaml']);
        });
    });

    describe('Save that removes previously relevant content (manifest-removal regression)', () => {
        const OWNER = 'client_a';
        const POD = 'apiVersion: v1\nkind: Pod\nmetadata:\n  name: p\n';

        function mutableDoc(file: string, initial: string, languageId = 'yaml') {
            const state = { text: initial };
            const doc: ScannableDocument = {
                uri: { scheme: 'file', fsPath: file, toString: () => `file://${file}` },
                languageId,
                fileName: file,
                getText: () => state.text,
            };
            return { doc, state };
        }

        function pipeline(owner: string = OWNER) {
            const save = createDidSaveMiddleware((d) => shouldScanDocumentOnSave(d, owner));
            const open = createDidOpenMiddleware(owner);
            const close = createDidCloseMiddleware(owner);
            const run = async (mw: (d: any, n: (d: any) => Promise<void>) => Promise<void>, d: ScannableDocument) => {
                let forwarded = false;
                await mw(d, async () => { forwarded = true; });
                return forwarded;
            };
            return {
                open: (d: ScannableDocument) => run(open, d),
                close: (d: ScannableDocument) => run(close, d),
                save: (d: ScannableDocument) => run(save, d),
            };
        }

        it('forwards manifest -> empty content', async () => {
            const { doc, state } = mutableDoc('/ws/mr/pod1.yaml', POD);
            const p = pipeline();
            await p.open(doc);
            assert.strictEqual(await p.save(doc), true);
            state.text = '';
            assert.strictEqual(await p.save(doc), true);
        });

        it('forwards manifest -> foo: bar', async () => {
            const { doc, state } = mutableDoc('/ws/mr/pod2.yaml', POD);
            const p = pipeline();
            await p.open(doc);
            state.text = 'foo: bar\n';
            assert.strictEqual(await p.save(doc), true);
        });

        it('forwards manifest -> unrelated JSON', async () => {
            const { doc, state } = mutableDoc('/ws/mr/pod3.yaml', POD);
            const p = pipeline();
            await p.open(doc);
            state.text = '{"hello": "world"}';
            assert.strictEqual(await p.save(doc), true);
        });

        it('suppresses unrelated YAML -> unrelated YAML', async () => {
            const { doc, state } = mutableDoc('/ws/mr/plain.yaml', 'foo: bar\n');
            const p = pipeline();
            await p.open(doc);
            state.text = 'foo: baz\n';
            assert.strictEqual(await p.save(doc), false);
        });

        it('forwards unrelated YAML -> Kubernetes manifest', async () => {
            const { doc, state } = mutableDoc('/ws/mr/becomes.yaml', 'foo: bar\n');
            const p = pipeline();
            await p.open(doc);
            state.text = POD;
            assert.strictEqual(await p.save(doc), true);
        });

        it('does not treat a URI as relevant forever after the removal save', async () => {
            const { doc, state } = mutableDoc('/ws/mr/once.yaml', POD);
            const p = pipeline();
            await p.open(doc);
            state.text = 'foo: bar\n';
            assert.strictEqual(await p.save(doc), true, 'removal save forwarded once');
            state.text = 'foo: baz\n';
            assert.strictEqual(await p.save(doc), false, 'later unrelated save suppressed');
            state.text = 'foo: qux\n';
            assert.strictEqual(await p.save(doc), false);
        });

        it('classifies on save even when the first-ever save of an unopened URI is a manifest', async () => {
            const { doc, state } = mutableDoc('/ws/mr/noopen.yaml', POD);
            const p = pipeline();
            assert.strictEqual(await p.save(doc), true);
            state.text = '';
            assert.strictEqual(await p.save(doc), true, 'state learned from save must still catch removal');
        });

        it('does not retain stale classification across close and reopen', async () => {
            const { doc, state } = mutableDoc('/ws/mr/reopen.yaml', POD);
            const p = pipeline();
            await p.open(doc);
            await p.close(doc);
            // File was changed externally while closed; reopening reflects unrelated content
            state.text = 'foo: bar\n';
            await p.open(doc);
            state.text = 'foo: baz\n';
            assert.strictEqual(await p.save(doc), false, 'stale relevant state must not survive close/reopen');
        });

        it('still forwards the removal save after reopening a manifest', async () => {
            const { doc, state } = mutableDoc('/ws/mr/reopen2.yaml', 'foo: bar\n');
            const p = pipeline();
            await p.open(doc);
            await p.close(doc);
            state.text = POD;
            await p.open(doc); // refreshed as relevant
            state.text = '';
            assert.strictEqual(await p.save(doc), true);
        });

        it('forgets closed documents so memory does not accumulate', async () => {
            const { doc, state } = mutableDoc('/ws/mr/closed.yaml', POD);
            const p = pipeline();
            await p.open(doc);
            await p.close(doc);
            state.text = 'foo: bar\n';
            // After close, nothing is remembered: an unrelated save is suppressed
            assert.strictEqual(await p.save(doc), false);
        });

        it('clears only the retiring client\'s remembered state', async () => {
            const shared = mutableDoc('/ws/mr/own.yaml', POD);
            const pa = pipeline('client_a');
            const pb = pipeline('client_b');

            // Prime both clients' relevance before cleanup
            await pa.open(shared.doc);
            await pb.open(shared.doc);

            clearOwnerState('client_a');

            // No further priming of client_b: both clients now save the same unrelated content
            shared.state.text = 'foo: bar\n';
            assert.strictEqual(await pa.save(shared.doc), false, 'client_a has no prior relevant state after cleanup');
            assert.strictEqual(await pb.save(shared.doc), true, 'client_b still remembers its prior relevant state');
        });

        it('a valid forced scan still forwards an unrelated document', async () => {
            const { doc } = mutableDoc('/ws/mr/forced.yaml', 'foo: bar\n');
            const p = pipeline();
            await p.open(doc);
            const handle = armForcedScan(doc, OWNER);
            assert.strictEqual(await p.save(doc), true);
            assert.strictEqual(handle.isConsumed, true);
            assert.strictEqual(await p.save(doc), false);
        });
    });

    describe('Forced-scan handle ownership with overlapping attempts', () => {
        const doc: ScannableDocument = {
            uri: { scheme: 'file', fsPath: '/ws/own/a.yaml', toString: () => 'file:///ws/own/a.yaml' },
            languageId: 'yaml',
            fileName: '/ws/own/a.yaml',
            getText: () => 'foo: bar\n',
        };

        it('older revoke() and complete() leave a newer attempt armed and consumable exactly once', () => {
            const a = armForcedScan(doc, 'o');
            const b = armForcedScan(doc, 'o');
            a.revoke();
            assert.strictEqual(isScanForcedForDocument(doc, 'o'), true, 'B remains after A.revoke');
            a.complete();
            assert.strictEqual(isScanForcedForDocument(doc, 'o'), true, 'B remains after A.complete');
            assert.strictEqual(b.isActive, true);
            assert.strictEqual(consumeForceScan(doc, 'o'), true);
            assert.strictEqual(b.isConsumed, true);
            assert.strictEqual(consumeForceScan(doc, 'o'), false, 'consumed exactly once');
            assert.strictEqual(shouldScanDocumentOnSave(doc, 'o'), false, 'ordinary saves are not forced afterwards');
        });

        it('A completing after B was armed does not remove B (reverse ordering)', () => {
            const a = armForcedScan(doc, 'o');
            const b = armForcedScan(doc, 'o');
            b.complete(); // B finishes first without consuming: its own entry is removed
            assert.strictEqual(isScanForcedForDocument(doc, 'o'), false);
            const c = armForcedScan(doc, 'o');
            a.complete();
            a.revoke();
            assert.strictEqual(isScanForcedForDocument(doc, 'o'), true, 'C survives stale A handle');
            assert.strictEqual(c.isActive, true);
            assert.strictEqual(consumeForceScan(doc, 'o'), true);
            assert.strictEqual(shouldScanDocumentOnSave(doc, 'o'), false);
        });

        it('a revoke after the attempt was consumed does not affect a newer attempt', () => {
            const a = armForcedScan(doc, 'o');
            assert.strictEqual(consumeForceScan(doc, 'o'), true);
            const b = armForcedScan(doc, 'o');
            a.revoke();
            a.complete();
            assert.strictEqual(isScanForcedForDocument(doc, 'o'), true);
            assert.strictEqual(b.isActive, true);
        });
    });

    describe('Kustomize path parsing with # characters', () => {
        it('preserves # inside quoted key=path values', () => {
            const refs = extractKustomizeReferences(
                'configMapGenerator:\n- name: cm\n  files:\n  - "settings=settings#prod.json"\n  - \'k=a#b.json\'\n'
            );
            assert.ok(refs.has('settings#prod.json'));
            assert.ok(refs.has('a#b.json'));
        });

        it('ignores a trailing YAML comment after an unquoted path and after a quoted path', () => {
            const refs = extractKustomizeReferences('resources:\n- base.yaml # shared base\n- "other.yaml" # quoted\n');
            assert.ok(refs.has('base.yaml'));
            assert.ok(refs.has('other.yaml'));
            assert.ok(![...refs].some((r) => r.includes('#') || r.includes('shared')));
        });

        it('treats # without leading whitespace in a plain scalar as literal', () => {
            const refs = extractKustomizeReferences('resources:\n- app#1.yaml\n');
            assert.ok(refs.has('app#1.yaml'));
        });

        it('handles quoted paths with spaces and #, and flow sequences', () => {
            const refs = extractKustomizeReferences(
                'resources:\n- "my dir/settings #1.json" # note\nfiles: ["a#x.json", b.json] # trailing\n'
            );
            assert.ok(refs.has('my dir/settings #1.json'));
            assert.ok(refs.has('a#x.json'));
            assert.ok(refs.has('b.json'));
        });

        it('skips whole-line comments', () => {
            const refs = extractKustomizeReferences('# - hidden.json\nresources:\n- shown.yaml\n');
            assert.ok(!refs.has('hidden.json'));
            assert.ok(refs.has('shown.yaml'));
        });

        describe('exact matching on disk', () => {
            let dir: string;
            before(() => {
                dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-kz-hash-'));
                fs.mkdirSync(path.join(dir, 'sub'));
                fs.writeFileSync(path.join(dir, 'settings#prod.json'), '{}');
                fs.writeFileSync(path.join(dir, 'settings.json'), '{}');
                fs.writeFileSync(path.join(dir, 'sub', 'settings#prod.json'), '{}');
                fs.writeFileSync(
                    path.join(dir, 'kustomization.yaml'),
                    'configMapGenerator:\n- name: cm\n  files:\n  - "settings=settings#prod.json"\n'
                );
            });
            after(() => fs.rmSync(dir, { recursive: true, force: true }));

            it('matches the exact normalized path only', () => {
                assert.strictEqual(isKustomizeDependency(path.join(dir, 'settings#prod.json')), true);
                assert.strictEqual(isKustomizeDependency(path.join(dir, 'settings.json')), false);
                assert.strictEqual(isKustomizeDependency(path.join(dir, 'sub', 'settings#prod.json')), false, 'same basename elsewhere must not match');
            });
        });
    });

    describe('Helm .Files.Lines support', () => {
        let root: string;
        before(() => {
            root = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-helm-lines-'));
        });
        after(() => fs.rmSync(root, { recursive: true, force: true }));

        function chart(name: string, template: string, extra: string[] = ['settings.json', 'other.json']) {
            const dir = path.join(root, name);
            fs.mkdirSync(path.join(dir, 'templates'), { recursive: true });
            fs.writeFileSync(path.join(dir, 'Chart.yaml'), 'apiVersion: v2\nname: c\nversion: 1.0.0\n');
            fs.writeFileSync(path.join(dir, 'templates', 't.yaml'), template);
            for (const f of extra) {
                fs.writeFileSync(path.join(dir, f), '{}');
            }
            return dir;
        }

        it('analyzes literal .Files.Lines as an exact literal without uncertainty', () => {
            const a = analyzeHelmTemplate('x: {{ range .Files.Lines "settings.json" }}{{ . }}{{ end }}');
            assert.strictEqual(a.usesGlobOrComputed, false);
            assert.ok(a.literals.has('settings.json'));
        });

        it('literal .Files.Lines matches exact chart-relative path only', () => {
            const dir = chart('lit', 'x: {{ range .Files.Lines "settings.json" }}{{ . }}{{ end }}\n');
            assert.strictEqual(isHelmDependency(path.join(dir, 'settings.json')), true);
            assert.strictEqual(isHelmDependency(path.join(dir, 'other.json')), false, 'unrelated file not a dependency');
        });

        it('does not use basename fallback for .Files.Lines', () => {
            const dir = chart('nobase', 'x: {{ .Files.Lines "settings.json" }}\n', ['settings.json']);
            fs.mkdirSync(path.join(dir, 'tools'));
            fs.writeFileSync(path.join(dir, 'tools', 'settings.json'), '{}');
            assert.strictEqual(isHelmDependency(path.join(dir, 'tools', 'settings.json')), false);
        });

        it('treats variable/alias, piped and computed .Files.Lines as uncertain', () => {
            assert.strictEqual(analyzeHelmTemplate('{{ $f := .Files }}{{ $f.Lines "a.json" }}').usesGlobOrComputed, true);
            assert.strictEqual(analyzeHelmTemplate('{{ "a.json" | .Files.Lines }}').usesGlobOrComputed, true);
            assert.strictEqual(analyzeHelmTemplate('{{ .Files.Lines $name }}').usesGlobOrComputed, true);
            assert.strictEqual(analyzeHelmTemplate('{{ .Files.Lines (printf "%s.json" .Values.n) }}').usesGlobOrComputed, true);

            const dir = chart('computed', '{{ .Files.Lines (printf "%s.json" .Values.n) }}\n');
            assert.strictEqual(isHelmDependency(path.join(dir, 'other.json')), true, 'computed chart forwards chart files');
        });
    });

    describe('JSON-RPC response wait uses one absolute deadline', () => {
        it('returns the matching response while skipping notifications and other ids', async () => {
            const queue: any[] = [{ method: 'n' }, { id: 9, result: null }, { id: 2, result: null }];
            const res = await awaitJsonRpcResponse(async () => queue.shift(), 2, 30000);
            assert.strictEqual(res.id, 2);
        });

        it('passes the remaining time to each wait and does not reset it on unrelated messages', async () => {
            let t = 0;
            const budgets: number[] = [];
            const next = async (timeoutMs: number) => {
                budgets.push(timeoutMs);
                t += 10000; // each unrelated message arrives after 10s
                return { method: 'noise' };
            };
            await assert.rejects(awaitJsonRpcResponse(next, 1, 30000, () => t), /Timeout waiting for response id 1/);
            assert.deepStrictEqual(budgets, [30000, 20000, 10000]);
        });

        it('does not cap an individual wait at 15s when the overall deadline allows more', async () => {
            let t = 0;
            let seen = 0;
            const next = async (timeoutMs: number) => {
                seen = timeoutMs;
                t += 20000;
                return { id: 5, result: null };
            };
            const res = await awaitJsonRpcResponse(next, 5, 30000, () => t);
            assert.strictEqual(res.id, 5);
            assert.strictEqual(seen, 30000);
        });

        it('fails only when the overall deadline expires after a quiet wait times out', async () => {
            let t = 0;
            const next = async (timeoutMs: number) => {
                t += timeoutMs;
                throw new Error('Timeout waiting for LSP message');
            };
            await assert.rejects(awaitJsonRpcResponse(next, 3, 30000, () => t), /Timeout waiting for response id 3/);
        });
    });

    describe('Dirty-buffer baseline seeding (client restart replaying didOpen)', () => {
        const OWNER = 'client_dirty';
        const POD = 'apiVersion: v1\nkind: Pod\nmetadata:\n  name: p\n';
        let dir: string;
        before(() => {
            dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-dirty-'));
        });
        after(() => fs.rmSync(dir, { recursive: true, force: true }));

        function diskDoc(name: string, disk: string | null, buffer: string, dirty: boolean) {
            const file = path.join(dir, name);
            if (disk !== null) {
                fs.writeFileSync(file, disk);
            }
            const state = { text: buffer, dirty };
            const doc: ScannableDocument = {
                uri: { scheme: 'file', fsPath: file, toString: () => `file://${file}` },
                languageId: 'yaml',
                fileName: file,
                get isDirty() {
                    return state.dirty;
                },
                getText: () => state.text,
            };
            return { doc, state, file };
        }

        const save = createDidSaveMiddleware((d) => shouldScanDocumentOnSave(d, OWNER));
        const open = createDidOpenMiddleware(OWNER);
        const run = async (mw: any, d: ScannableDocument) => {
            let forwarded = false;
            await mw(d, async () => { forwarded = true; });
            return forwarded;
        };

        it('clean documents are classified directly from the buffer (fast path)', async () => {
            const relevant = diskDoc('clean-pod.yaml', POD, POD, false);
            const unrelated = diskDoc('clean-plain.yaml', 'foo: bar\n', 'foo: bar\n', false);
            assert.strictEqual(recordDocumentRelevance(relevant.doc, OWNER), true);
            assert.strictEqual(recordDocumentRelevance(unrelated.doc, OWNER), false);
        });

        it('dirty buffer with a relevant saved disk version seeds a relevant baseline', async () => {
            const d = diskDoc('dirty-rel.yaml', POD, 'foo: bar\n', true);
            await run(open, d.doc);
            d.state.dirty = false; // user saves the edited buffer
            assert.strictEqual(await run(save, d.doc), true, 'removal of the Pod must be forwarded');
        });

        it('dirty Pod removal (empty buffer) followed by save still forwards', async () => {
            const d = diskDoc('dirty-empty.yaml', POD, '', true);
            await run(open, d.doc);
            d.state.dirty = false;
            assert.strictEqual(await run(save, d.doc), true);
        });

        it('dirty buffer with an unrelated saved disk version is not seeded from the buffer', async () => {
            const d = diskDoc('dirty-unrel.yaml', 'foo: bar\n', POD, true);
            await run(open, d.doc);
            d.state.text = 'foo: baz\n';
            d.state.dirty = false;
            assert.strictEqual(await run(save, d.doc), false, 'baseline came from disk (unrelated), not the Pod buffer');
        });

        it('an unreadable saved version yields an unknown baseline and the next save is forwarded once', async () => {
            const d = diskDoc('never-written.yaml', null, 'foo: bar\n', true);
            await run(open, d.doc);
            assert.strictEqual(recordDocumentRelevance(d.doc, OWNER), 'unknown');
            d.state.dirty = false;
            assert.strictEqual(await run(save, d.doc), true, 'unknown baseline is conservatively forwarded');
            assert.strictEqual(await run(save, d.doc), false, 'baseline refreshed after the processed save');
        });

        it('does not overwrite a known saved baseline with an unsaved buffer classification', async () => {
            const d = diskDoc('keep-baseline.yaml', POD, POD, false);
            await run(open, d.doc); // known relevant baseline
            d.state.dirty = true;
            d.state.text = 'foo: bar\n';
            await run(open, d.doc); // replayed dirty didOpen without a restart
            d.state.dirty = false;
            assert.strictEqual(await run(save, d.doc), true);
        });

        it('repeated restart/open/save cycles do not retain stale classifications', async () => {
            const d = diskDoc('cycle.yaml', POD, POD, false);
            for (let i = 0; i < 3; i++) {
                clearOwnerState(OWNER); // client restart / dispose
                d.state.dirty = false;
                fs.writeFileSync(d.file, POD);
                d.state.text = POD;
                await run(open, d.doc);
                assert.strictEqual(await run(save, d.doc), true, 'manifest saves forwarded');

                // Pod removed and saved to disk
                fs.writeFileSync(d.file, 'foo: bar\n');
                d.state.text = 'foo: bar\n';
                assert.strictEqual(await run(save, d.doc), true, 'removal forwarded once');
                assert.strictEqual(await run(save, d.doc), false, 'then unrelated saves are suppressed');

                // Restart with an unrelated saved file: nothing stale remains from the Pod era
                clearOwnerState(OWNER);
                await run(open, d.doc);
                assert.strictEqual(await run(save, d.doc), false, 'no stale relevance after restart');
            }
        });
    });

    describe('JSONC dependency saves reach the filter', () => {
        let dir: string;
        before(() => {
            dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-jsonc-'));
            fs.writeFileSync(
                path.join(dir, 'kustomization.yaml'),
                'configMapGenerator:\n- name: cm\n  files:\n  - typedoc.json\n'
            );
            fs.writeFileSync(path.join(dir, 'typedoc.json'), '{\n  // comment\n  "entryPoints": ["src"],\n}\n');
            fs.writeFileSync(path.join(dir, 'unrelated.json'), '{\n  // comment\n  "a": 1,\n}\n');
            fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"x"}');
        });
        after(() => fs.rmSync(dir, { recursive: true, force: true }));

        function jsoncDoc(name: string, languageId = 'jsonc'): ScannableDocument {
            const file = path.join(dir, name);
            return {
                uri: { scheme: 'file', fsPath: file, toString: () => `file://${file}` },
                languageId,
                fileName: file,
                getText: () => fs.readFileSync(file, 'utf8'),
            };
        }

        it('the client document selector synchronizes yaml, json and jsonc file documents', () => {
            const langs = DOCUMENT_SELECTOR.map((d) => `${d.scheme}:${d.language}`).sort();
            assert.deepStrictEqual(langs, ['file:json', 'file:jsonc', 'file:yaml']);
        });

        it('forwards a save of a Kustomize-referenced JSONC file', async () => {
            const mw = createDidSaveMiddleware((d) => shouldScanDocumentOnSave(d, 'jsonc'));
            let forwarded = false;
            await mw(jsoncDoc('typedoc.json') as any, async () => { forwarded = true; });
            assert.strictEqual(forwarded, true);
        });

        it('suppresses a save of an unrelated JSONC file', async () => {
            const mw = createDidSaveMiddleware((d) => shouldScanDocumentOnSave(d, 'jsonc'));
            let forwarded = false;
            await mw(jsoncDoc('unrelated.json') as any, async () => { forwarded = true; });
            assert.strictEqual(forwarded, false);
        });

        it('matching stays exact for JSONC and existing JSON/YAML behavior is unchanged', () => {
            assert.strictEqual(isCandidateForKubernetesScan(jsoncDoc('typedoc.json', 'json')), true);
            assert.strictEqual(isCandidateForKubernetesScan(jsoncDoc('package.json', 'json')), false);
            assert.strictEqual(isCandidateForKubernetesScan({
                uri: { scheme: 'file', fsPath: '/ws/a.yaml' }, languageId: 'yaml', fileName: '/ws/a.yaml',
                getText: () => 'foo: bar\n',
            }), false);
            assert.strictEqual(isCandidateForKubernetesScan({
                uri: { scheme: 'file', fsPath: '/ws/pod.yaml' }, languageId: 'yaml', fileName: '/ws/pod.yaml',
                getText: () => 'apiVersion: v1\nkind: Pod\n',
            }), true);
        });
    });

    describe('Multiline Kustomize flow sequences', () => {
        it('finds files in a multiline files: [...] sequence', () => {
            const refs = extractKustomizeReferences(
                'configMapGenerator:\n  - name: app-config\n    files: [\n      "settings.json",\n      "logging.json"\n    ]\n'
            );
            assert.ok(refs.has('settings.json'));
            assert.ok(refs.has('logging.json'));
            assert.strictEqual(analyzeKustomization('x:\n  files: [\n  "a.json"\n  ]\n').uncertain, false);
        });

        it('finds envs in a multiline envs: [...] sequence', () => {
            const refs = extractKustomizeReferences('secretGenerator:\n- name: s\n  envs: [\n    .env.prod,\n    .env.dev\n  ]\n');
            assert.ok(refs.has('.env.prod'));
            assert.ok(refs.has('.env.dev'));
        });

        it('handles multiple entries on one line and across lines', () => {
            const refs = extractKustomizeReferences('files: [a.json, b.json,\n  c.json]\n');
            for (const f of ['a.json', 'b.json', 'c.json']) {
                assert.ok(refs.has(f), f);
            }
        });

        it('keeps # and spaces inside quoted entries and ignores comments between entries', () => {
            const refs = extractKustomizeReferences(
                'files: [\n  "settings#prod.json", # first\n  # whole-line comment\n  "my dir/a #1.json",\n  plain.json # trailing\n]\n'
            );
            assert.ok(refs.has('settings#prod.json'));
            assert.ok(refs.has('my dir/a #1.json'));
            assert.ok(refs.has('plain.json'));
            assert.ok(![...refs].some((r) => r.includes('comment') || r.includes('first')));
        });

        it('block sequences still work', () => {
            const a = analyzeKustomization('resources:\n- a.yaml\n- "b#1.yaml" # c\nconfigMapGenerator:\n- name: x\n  files:\n  - k=c.json\n');
            assert.deepStrictEqual([...a.references].filter((r) => /\.(yaml|json)$/.test(r)).sort(), ['a.yaml', 'b#1.yaml', 'c.json']);
            assert.strictEqual(a.uncertain, false);
        });

        describe('on disk', () => {
            let dir: string;
            before(() => {
                dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-kz-multi-'));
                fs.mkdirSync(path.join(dir, 'other'));
                fs.mkdirSync(path.join(dir, 'broken'));
                for (const f of ['settings.json', 'logging.json', path.join('other', 'settings.json')]) {
                    fs.writeFileSync(path.join(dir, f), '{}');
                }
                fs.writeFileSync(
                    path.join(dir, 'kustomization.yaml'),
                    'configMapGenerator:\n  - name: app-config\n    files: [\n      "settings.json",\n      "logging.json"\n    ]\n'
                );
                // Unterminated flow sequence: unsupported/malformed
                fs.writeFileSync(path.join(dir, 'broken', 'kustomization.yaml'), 'configMapGenerator:\n- name: x\n  files: [\n    "a.json",\n');
                fs.writeFileSync(path.join(dir, 'broken', 'whatever.json'), '{}');
            });
            after(() => fs.rmSync(dir, { recursive: true, force: true }));

            it('detects both referenced files and keeps same-basename files elsewhere distinct', () => {
                assert.strictEqual(isKustomizeDependency(path.join(dir, 'settings.json')), true);
                assert.strictEqual(isKustomizeDependency(path.join(dir, 'logging.json')), true);
                assert.strictEqual(isKustomizeDependency(path.join(dir, 'other', 'settings.json')), false);
            });

            it('malformed or unsupported YAML is uncertain rather than a false negative', () => {
                assert.strictEqual(analyzeKustomization('files: [\n"a.json",\n').uncertain, true);
                assert.strictEqual(analyzeKustomization('files: [[a.json], [b.json]]\n').uncertain, true);
                assert.strictEqual(analyzeKustomization('files: ["a.json\n').uncertain, true);
                assert.strictEqual(isKustomizeDependency(path.join(dir, 'broken', 'whatever.json')), true);
            });
        });
    });

    describe('Helm template discovery regardless of suffix', () => {
        let root: string;
        before(() => {
            root = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-helm-suffix-'));
        });
        after(() => fs.rmSync(root, { recursive: true, force: true }));

        function makeChart(name: string) {
            const dir = path.join(root, name);
            fs.mkdirSync(path.join(dir, 'templates'), { recursive: true });
            fs.writeFileSync(path.join(dir, 'Chart.yaml'), 'apiVersion: v2\nname: c\nversion: 1.0.0\n');
            for (const f of ['settings.json', 'other.json']) {
                fs.writeFileSync(path.join(dir, f), '{}');
            }
            return dir;
        }

        it('analyzes helper files such as templates/_config.txt included by a template', () => {
            const dir = makeChart('txt-helper');
            fs.writeFileSync(path.join(dir, 'templates', '_config.txt'), '{{- define "app.cfg" -}}{{ .Files.Get "settings.json" }}{{- end -}}\n');
            fs.writeFileSync(
                path.join(dir, 'templates', 'cm.yaml'),
                'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: cm\ndata:\n  cfg: |-\n    {{ include "app.cfg" . }}\n'
            );
            assert.strictEqual(isHelmDependency(path.join(dir, 'settings.json')), true, 'saving the referenced file forwards');
            assert.strictEqual(isHelmDependency(path.join(dir, 'other.json')), false, 'unrelated file remains suppressed');
        });

        it('does not treat files outside templates/ as templates', () => {
            const dir = makeChart('outside');
            fs.writeFileSync(path.join(dir, 'notes.txt'), '{{ .Files.Get "settings.json" }}');
            fs.writeFileSync(path.join(dir, 'templates', 'cm.yaml'), 'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: cm\n');
            assert.strictEqual(isHelmDependency(path.join(dir, 'settings.json')), false);
        });

        it('keeps analyzing .yaml, .yml and .tpl templates', () => {
            for (const ext of ['yaml', 'yml', 'tpl']) {
                const dir = makeChart(`ext-${ext}`);
                fs.writeFileSync(path.join(dir, 'templates', `t.${ext}`), '{{ .Files.Get "settings.json" }}\n');
                assert.strictEqual(isHelmDependency(path.join(dir, 'settings.json')), true, ext);
                assert.strictEqual(isHelmDependency(path.join(dir, 'other.json')), false, ext);
            }
        });

        it('invalidates cached analysis when a suffix-less helper changes', () => {
            const dir = makeChart('invalidate');
            const helper = path.join(dir, 'templates', '_helpers.txt');
            fs.writeFileSync(helper, '{{ .Files.Get "settings.json" }}\n');
            assert.strictEqual(isHelmDependency(path.join(dir, 'settings.json')), true);
            assert.strictEqual(isHelmDependency(path.join(dir, 'other.json')), false);
            fs.writeFileSync(helper, '{{ .Files.Lines "other.json" }}\n');
            assert.strictEqual(isHelmDependency(path.join(dir, 'settings.json')), false);
            assert.strictEqual(isHelmDependency(path.join(dir, 'other.json')), true);
        });

        it('still treats dynamic references in suffix-less helpers conservatively', () => {
            const dir = makeChart('dynamic');
            fs.writeFileSync(path.join(dir, 'templates', '_dyn.txt'), '{{ .Files.Get (printf "%s.json" .Values.n) }}\n');
            assert.strictEqual(isHelmDependency(path.join(dir, 'other.json')), true);
        });
    });

    describe('JSON-RPC wait helpers: response shape and absolute deadlines', () => {
        const feed = (msgs: any[], advance = 0) => {
            let t = 0;
            const budgets: number[] = [];
            const next = async (timeoutMs: number) => {
                budgets.push(timeoutMs);
                t += advance;
                const m = msgs.shift();
                if (m === undefined) {
                    t += timeoutMs;
                    throw new Error('Timeout waiting for LSP message');
                }
                return m;
            };
            return { next, now: () => t, budgets };
        };

        it('ignores a matching id that carries a method (request/notification)', async () => {
            const f = feed([{ id: 2, method: 'client/registerCapability' }, { id: 2, result: null }]);
            const res = await awaitJsonRpcResponse(f.next, 2, 30000, f.now);
            assert.strictEqual(res.result, null);
            assert.strictEqual(f.budgets.length, 2);
        });

        it('accepts result and result: null', async () => {
            assert.deepStrictEqual(await awaitJsonRpcResponse(feed([{ id: 1, result: { ok: true } }]).next, 1), { id: 1, result: { ok: true } });
            assert.strictEqual((await awaitJsonRpcResponse(feed([{ id: 1, result: null }]).next, 1)).result, null);
        });

        it('accepts an error response', async () => {
            const res = await awaitJsonRpcResponse(feed([{ id: 3, error: { code: -1, message: 'x' } }]).next, 3);
            assert.strictEqual(res.error.code, -1);
        });

        it('ignores a response with another id', async () => {
            const f = feed([{ id: 9, result: 1 }, { id: 4, result: 2 }]);
            assert.strictEqual((await awaitJsonRpcResponse(f.next, 4, 30000, f.now)).result, 2);
        });

        it('isJsonRpcResponse enforces the shape', () => {
            assert.strictEqual(isJsonRpcResponse({ id: 1 }, 1), false);
            assert.strictEqual(isJsonRpcResponse({ id: 1, method: 'm', result: 1 }, 1), false);
            assert.strictEqual(isJsonRpcResponse({ id: 1, result: null }, 1), true);
            assert.strictEqual(isJsonRpcResponse({ id: 1, error: {} }, 1), true);
            assert.strictEqual(isJsonRpcResponse({ id: 2, result: 1 }, 1), false);
        });

        it('ignored messages do not reset the deadline and repeated reads cannot extend it', async () => {
            const noise = Array.from({ length: 50 }, () => ({ method: 'noise' }));
            const f = feed(noise, 10000);
            await assert.rejects(awaitJsonRpcResponse(f.next, 1, 30000, f.now), /Timeout waiting for response id 1/);
            assert.deepStrictEqual(f.budgets, [30000, 20000, 10000]);
        });

        it('diagnostics wait: skips other URIs and succeeds before the deadline', async () => {
            const f = feed([
                { method: 'textDocument/publishDiagnostics', params: { uri: 'file:///other', diagnostics: [1] } },
                { method: 'window/logMessage' },
                { method: 'textDocument/publishDiagnostics', params: { uri: 'file:///pod', diagnostics: [1, 2] } },
            ], 1000);
            const diags = await awaitDiagnosticsForUri(f.next, 'file:///pod', 90000, f.now);
            assert.deepStrictEqual(diags, [1, 2]);
            assert.deepStrictEqual(f.budgets, [90000, 89000, 88000]);
        });

        it('diagnostics wait: a matching message arriving after the deadline is not accepted', async () => {
            let t = 0;
            const next = async () => {
                t += 91000; // read completes after the 90s deadline
                return { method: 'textDocument/publishDiagnostics', params: { uri: 'file:///pod', diagnostics: [1] } };
            };
            await assert.rejects(awaitDiagnosticsForUri(next, 'file:///pod', 90000, () => t), /Timeout waiting for publishDiagnostics/);
        });

        it('generic wait: unrelated messages near the deadline cannot extend it', async () => {
            const f = feed(Array.from({ length: 10 }, () => ({ method: 'n' })), 29000);
            await assert.rejects(awaitJsonRpcMessage(f.next, () => false, 'thing', 30000, f.now), /Timeout waiting for thing/);
            assert.deepStrictEqual(f.budgets, [30000, 1000]);
        });
    });
});

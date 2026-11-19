import * as fs from 'fs';
import * as path from 'path';

/**
 * Minimal interface representing the parts of vscode.TextDocument required
 * for save-time manifest filtering.
 */
export interface ScannableDocument {
    readonly uri: { scheme: string; fsPath?: string; path?: string; toString?(): string };
    readonly languageId: string;
    readonly fileName: string;
    getText(): string;
}

/**
 * Known filenames that belong to Kustomize or Helm configuration and directly
 * affect Kubernetes scan evaluation.
 */
export const KUSTOMIZE_FILENAMES = new Set([
    'kustomization.yaml',
    'kustomization.yml',
    'Kustomization',
]);

export const HELM_FILENAMES = new Set([
    'chart.yaml',
    'chart.yml',
    'values.yaml',
    'values.yml',
    'values.json',
]);

/**
 * Known file patterns and directories that are tool configurations.
 * Note: These exclusions are only applied when the document LACKS strong
 * Kubernetes evidence. Strong Kubernetes evidence always overrides these exclusions.
 */
const KNOWN_NON_K8S_FILENAMES = new Set([
    'package.json',
    'package-lock.json',
    'npm-shrinkwrap.json',
    'yarn.lock',
    'pnpm-lock.yaml',
    'composer.json',
    'composer.lock',
    'tsconfig.json',
    'jsconfig.json',
    'docker-compose.yml',
    'docker-compose.yaml',
    'compose.yml',
    'compose.yaml',
    '.pre-commit-config.yaml',
    '.gitlab-ci.yml',
    '.gitlab-ci.yaml',
    '.travis.yml',
    'lerna.json',
    'turbo.json',
    'nx.json',
]);

/**
 * URI-scoped forced scans with expiration (in milliseconds) to prevent state leaks,
 * cross-document override consumption, and stale state across client restarts.
 */
const forcedScanUris = new Map<string, number>();
const FORCE_SCAN_EXPIRY_MS = 10000; // 10 seconds

/**
 * Normalizes document URI to a canonical string key.
 */
export function getDocumentKey(docOrUri: ScannableDocument | string): string {
    if (!docOrUri) {
        return '';
    }
    if (typeof docOrUri === 'string') {
        return docOrUri.trim().replace(/\\/g, '/');
    }
    const uri = docOrUri.uri;
    if (uri && typeof uri.toString === 'function' && uri.toString !== Object.prototype.toString) {
        const str = uri.toString();
        if (str && str !== '[object Object]') {
            return str;
        }
    }
    const rawPath = docOrUri.fileName || uri?.fsPath || uri?.path || '';
    return rawPath.replace(/\\/g, '/');
}

/**
 * Flags that a specific document save was explicitly requested by a user command
 * (e.g. "Kubescape: Scan YAML") and must trigger a scan regardless of content heuristics.
 * Returns the normalized key for deterministic tracking.
 */
export function forceScanForDocument(docOrUri: ScannableDocument | string): string {
    const key = getDocumentKey(docOrUri);
    if (key) {
        forcedScanUris.set(key, Date.now() + FORCE_SCAN_EXPIRY_MS);
    }
    return key;
}

/**
 * Revokes a pending forced scan override for a document (e.g. if a save command failed).
 */
export function clearForcedScan(keyOrDoc: ScannableDocument | string): void {
    const key = getDocumentKey(keyOrDoc);
    if (key) {
        forcedScanUris.delete(key);
    }
}

/**
 * Consumes the forced scan flag for a specific document if active and unexpired.
 * Consumed strictly once.
 */
export function consumeForceScan(docOrUri: ScannableDocument | string): boolean {
    const key = getDocumentKey(docOrUri);
    if (!key) {
        return false;
    }
    const expiry = forcedScanUris.get(key);
    if (expiry === undefined) {
        return false;
    }
    forcedScanUris.delete(key);
    return Date.now() <= expiry;
}

/**
 * Resets all forced scan overrides and internal caches. Called on client restart and extension deactivation.
 */
export function resetForceScanState(): void {
    forcedScanUris.clear();
    kustomizeCache.clear();
    helmChartCache.clear();
}

/**
 * Returns whether a forced scan override is currently pending for a document.
 */
export function isScanForcedForDocument(docOrUri: ScannableDocument | string): boolean {
    const key = getDocumentKey(docOrUri);
    if (!key) {
        return false;
    }
    const expiry = forcedScanUris.get(key);
    if (expiry === undefined) {
        return false;
    }
    if (Date.now() > expiry) {
        forcedScanUris.delete(key);
        return false;
    }
    return true;
}

/**
 * Evaluates whether a saved document should trigger a Kubescape workspace scan.
 * Explicit commands always trigger scans; automatic saves are filtered to ensure
 * only Kubernetes manifests and Helm/Kustomize files trigger scans.
 *
 * Follows the conservative rule: Never suppress a save unless the document is
 * confidently classified as non-Kubernetes. Uncertain/ambiguous files trigger scanning.
 */
export function shouldScanDocumentOnSave(document: ScannableDocument): boolean {
    if (consumeForceScan(document)) {
        return true;
    }
    return isCandidateForKubernetesScan(document);
}

/**
 * Inspects a document on save to determine whether it is a candidate for a
 * Kubescape security scan.
 *
 * Core principles:
 * 1. Strong Kubernetes evidence (apiVersion + kind, Helm templates, Kustomize) ALWAYS wins.
 *    Explicit exclusions (like .github/workflows/ or docker-compose.yaml) NEVER override
 *    strong Kubernetes evidence.
 * 2. Ambiguous YAML files that cannot be confidently classified as non-Kubernetes are forwarded.
 * 3. Only files that lack strong Kubernetes evidence AND match known non-Kubernetes tools/formats
 *    are suppressed.
 */
export function isCandidateForKubernetesScan(document: ScannableDocument): boolean {
    if (!document) {
        return false;
    }

    // Only real local files on disk can be scanned by the local scanner
    if (document.uri?.scheme !== 'file') {
        return false;
    }

    const filePath = (document.fileName || document.uri.fsPath || document.uri.path || '').replace(/\\/g, '/');
    const basename = path.basename(filePath);
    const lowerBasename = basename.toLowerCase();

    // 1. Kustomize configuration files directly define or compose Kubernetes resources
    if (KUSTOMIZE_FILENAMES.has(basename) || KUSTOMIZE_FILENAMES.has(lowerBasename)) {
        return true;
    }

    // 2. Helm chart metadata and values files directly influence template rendering (YAML or JSON)
    // Note: values.schema.json is a validation schema, not a workload values file, and is excluded.
    if (lowerBasename !== 'values.schema.json') {
        if (HELM_FILENAMES.has(lowerBasename) || (lowerBasename.startsWith('values.') && (lowerBasename.endsWith('.yaml') || lowerBasename.endsWith('.yml') || lowerBasename.endsWith('.json')))) {
            return true;
        }
    }

    // 3. Files inside a Helm templates/ directory
    if (filePath.includes('/templates/') && (lowerBasename.endsWith('.yaml') || lowerBasename.endsWith('.yml') || lowerBasename.endsWith('.tpl'))) {
        return true;
    }

    // 4. Must match supported languages (YAML or JSON)
    const lang = document.languageId;
    const isYaml = lang === 'yaml' || lowerBasename.endsWith('.yaml') || lowerBasename.endsWith('.yml');
    const isJson = lang === 'json' || lowerBasename.endsWith('.json');

    if (!isYaml && !isJson) {
        return false;
    }

    // Fast check on empty document content
    const text = document.getText();
    if (!text || text.trim().length === 0) {
        return false;
    }

    // 5. Strong Kubernetes Evidence Check (Checked BEFORE exclusions!)
    // If a document contains strong Kubernetes evidence, it MUST be forwarded,
    // even if it is stored in a directory like .github/workflows/ or named docker-compose.yaml.
    if (isJson) {
        const jsonEvidence = checkKubernetesJsonEvidence(text);
        if (jsonEvidence === 'strong_k8s') {
            return true;
        }
        // Indirect dependency checks:
        // A. Kustomize configuration referencing this JSON file (e.g. in configMapGenerator/secretGenerator)
        if (isKustomizeDependency(filePath)) {
            return true;
        }
        // B. Helm template consuming this JSON file (e.g. via .Files.Get / in chart files/)
        if (isHelmDependency(filePath)) {
            return true;
        }
        if (jsonEvidence === 'confident_non_k8s') {
            return false;
        }
        // Ambiguous JSON: check if path is excluded
        if (isKnownNonKubernetesPath(filePath, lowerBasename)) {
            return false;
        }
        return true;
    }

    const yamlEvidence = checkKubernetesYamlEvidence(text);
    if (yamlEvidence === 'strong_k8s') {
        // Strong Kubernetes evidence ALWAYS overrides known-path exclusions
        return true;
    }

    // Indirect dependency checks for YAML files lacking direct apiVersion/kind:
    if (isKustomizeDependency(filePath)) {
        return true;
    }
    if (isHelmDependency(filePath)) {
        return true;
    }

    // 6. If the file lacks strong Kubernetes evidence and is not an indirect dependency, check known exclusions
    if (isKnownNonKubernetesPath(filePath, lowerBasename)) {
        return false;
    }

    // 7. For other YAML files:
    // If it has partial Kubernetes indicators (ambiguous) -> forward under conservative policy
    if (yamlEvidence === 'ambiguous_k8s') {
        return true;
    }

    // Confidently non-Kubernetes YAML (no apiVersion, no kind, no templates, no metadata/spec)
    return false;
}

/**
 * Checks whether targetPath or its basename is referenced as a discrete token within file content.
 */
function isPathReferencedInContent(content: string, targetPath: string): boolean {
    if (!targetPath || !content) {
        return false;
    }
    const cleanPath = targetPath.replace(/^\.\//, '');
    const escaped = cleanPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`(?:^|[\\s'"=,\\[\\]/])${escaped}(?:$|[\\s'"=,\\[\\]#])`, 'm');
    return regex.test(content);
}

/**
 * Maximum directory traversal depth when searching upward for Kustomize or Helm root.
 * Bounded to 8 levels to cover deep enterprise repos in O(1) time without runaway walking.
 */
const MAX_SEARCH_DEPTH = 8;

interface KustomizeCacheEntry {
    mtimeMs: number;
    size: number;
    content: string;
}

interface HelmChartCacheEntry {
    fingerprint: string;
    usesGlobOrComputed: boolean;
    literals: Set<string>;
}

const kustomizeCache = new Map<string, KustomizeCacheEntry>();
const helmChartCache = new Map<string, HelmChartCacheEntry>();

/**
 * Recursively locates template files inside a Helm templates directory.
 */
function findTemplateFiles(dir: string, depth = 0): string[] {
    if (depth > 3 || !fs.existsSync(dir)) {
        return [];
    }
    const results: string[] = [];
    try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                results.push(...findTemplateFiles(fullPath, depth + 1));
            } else if (entry.isFile()) {
                const lower = entry.name.toLowerCase();
                if (lower.endsWith('.yaml') || lower.endsWith('.yml') || lower.endsWith('.tpl')) {
                    results.push(fullPath);
                }
            }
        }
    } catch {
        // Return whatever was collected safely
    }
    return results.sort();
}

/**
 * Computes an aggregated metadata fingerprint across all template files in a templates directory.
 * Includes file paths, mtimeMs, and size for every template file.
 * This guarantees reliable invalidation when existing templates are edited in-place, created, or deleted,
 * which does not alter directory mtime on POSIX or Windows filesystems.
 */
function getTemplatesFingerprint(templateFiles: string[]): string {
    return templateFiles.map(f => {
        try {
            const s = fs.statSync(f);
            return `${f}:${s.mtimeMs}:${s.size}`;
        } catch {
            return `${f}:missing`;
        }
    }).join(';');
}

/**
 * Analyzes a Helm template for static or dynamic .Files usages.
 * Correctly distinguishes between static literals (double quotes, single quotes, backticks),
 * piped invocations, wildcard globbing, and computed/variable expressions.
 */
function analyzeHelmTemplate(content: string): { usesGlobOrComputed: boolean; literals: string[] } {
    if (!content.includes('.Files.')) {
        return { usesGlobOrComputed: false, literals: [] };
    }
    const usesGlob = content.includes('.Files.Glob');
    // Check if .Files.Get is preceded by a pipe, e.g. "path" | .Files.Get or $file | .Files.Get
    const hasPipedGet = /\|\s*\.Files\.(?:Get|GetBytes)/.test(content);
    // Check if .Files.Get is called with non-literal argument (variable $, expression (, or identifier)
    const hasComputedArgument = /\.Files\.(?:Get|GetBytes)\s*(\$|\(|\.[a-zA-Z]|[a-zA-Z])/.test(content);
    // Extract static literals: double-quoted, single-quoted, or backtick-quoted
    const literals: string[] = [];
    const strictLiteralRegex = /\.Files\.(?:Get|GetBytes)\s*\(?\s*["'`]([^"'`]+)["'`]/g;
    let match: RegExpExecArray | null;
    while ((match = strictLiteralRegex.exec(content)) !== null) {
        literals.push(match[1].replace(/^\.\//, ''));
    }
    return {
        usesGlobOrComputed: usesGlob || hasPipedGet || hasComputedArgument,
        literals,
    };
}

/**
 * Checks whether a JSON or YAML file is referenced by a Kustomize configuration
 * (e.g. in configMapGenerator, secretGenerator, resources, or patches) in its directory
 * or ancestor directories up to MAX_SEARCH_DEPTH levels.
 */
export function isKustomizeDependency(filePath: string): boolean {
    try {
        if (!filePath || !fs.existsSync(filePath)) {
            return false;
        }
        let currentDir = path.dirname(filePath);

        for (let depth = 0; depth < MAX_SEARCH_DEPTH; depth++) {
            for (const kFilename of KUSTOMIZE_FILENAMES) {
                const kPath = path.join(currentDir, kFilename);
                if (fs.existsSync(kPath)) {
                    let content: string;
                    try {
                        const stat = fs.statSync(kPath);
                        const cached = kustomizeCache.get(kPath);
                        if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
                            content = cached.content;
                        } else {
                            content = fs.readFileSync(kPath, 'utf8');
                            if (kustomizeCache.size > 100) {
                                kustomizeCache.clear();
                            }
                            kustomizeCache.set(kPath, { mtimeMs: stat.mtimeMs, size: stat.size, content });
                        }
                    } catch {
                        kustomizeCache.delete(kPath);
                        continue;
                    }

                    // Strict relative path matching:
                    // When kustomization.yaml is in the same directory, relPath is "config.json".
                    // When kustomization.yaml is an ancestor, relPath is "sub/config.json".
                    // Matching relPath prevents cross-directory false positives between files sharing
                    // the same basename (e.g. apps/auth/config.json vs apps/billing/config.json).
                    const relPath = path.relative(currentDir, filePath).replace(/\\/g, '/');
                    if (isPathReferencedInContent(content, relPath)) {
                        return true;
                    }
                } else {
                    kustomizeCache.delete(kPath);
                }
            }
            const parent = path.dirname(currentDir);
            if (!parent || parent === currentDir) {
                break;
            }
            currentDir = parent;
        }
    } catch {
        // Safe fallback on any filesystem or permission error
    }
    return false;
}

/**
 * Checks whether a JSON or YAML file is consumed by a Helm chart
 * (e.g. in values files, in the chart files/ directory, or referenced by templates via .Files.Get).
 */
export function isHelmDependency(filePath: string): boolean {
    try {
        if (!filePath || !fs.existsSync(filePath)) {
            return false;
        }
        const basename = path.basename(filePath);
        const lowerBasename = basename.toLowerCase();

        // Direct Helm values files (YAML or JSON). values.schema.json is excluded as it is a schema.
        if (lowerBasename !== 'values.schema.json') {
            if (HELM_FILENAMES.has(lowerBasename) || (lowerBasename.startsWith('values.') && (lowerBasename.endsWith('.yaml') || lowerBasename.endsWith('.yml') || lowerBasename.endsWith('.json')))) {
                return true;
            }
        }

        let currentDir = path.dirname(filePath);

        // Search up to MAX_SEARCH_DEPTH levels for Helm chart root (Chart.yaml)
        for (let depth = 0; depth < MAX_SEARCH_DEPTH; depth++) {
            const chartYamlPath = path.join(currentDir, 'Chart.yaml');
            const chartYmlPath = path.join(currentDir, 'Chart.yml');

            if (fs.existsSync(chartYamlPath) || fs.existsSync(chartYmlPath)) {
                const relPath = path.relative(currentDir, filePath).replace(/\\/g, '/');

                // Files in standard Helm `files/` directory are intended for .Files.Get
                if (relPath.startsWith('files/')) {
                    return true;
                }

                const templatesDir = path.join(currentDir, 'templates');
                if (fs.existsSync(templatesDir)) {
                    let chartInfo = helmChartCache.get(currentDir);
                    try {
                        const templateFiles = findTemplateFiles(templatesDir);
                        const fingerprint = getTemplatesFingerprint(templateFiles);

                        if (!chartInfo || chartInfo.fingerprint !== fingerprint) {
                            let usesGlobOrComputed = false;
                            const literals = new Set<string>();

                            for (const tf of templateFiles) {
                                try {
                                    const content = fs.readFileSync(tf, 'utf8');
                                    const analysis = analyzeHelmTemplate(content);
                                    if (analysis.usesGlobOrComputed) {
                                        usesGlobOrComputed = true;
                                    }
                                    for (const lit of analysis.literals) {
                                        literals.add(lit);
                                    }
                                } catch {
                                    // Ignore unreadable template file
                                }
                            }
                            chartInfo = { fingerprint, usesGlobOrComputed, literals };
                            if (helmChartCache.size > 100) {
                                helmChartCache.clear();
                            }
                            helmChartCache.set(currentDir, chartInfo);
                        }
                    } catch {
                        // If inspection fails, bypass cache safely
                    }

                    if (chartInfo) {
                        if (chartInfo.usesGlobOrComputed) {
                            return true;
                        }
                        if (chartInfo.literals.has(relPath) || chartInfo.literals.has(basename)) {
                            return true;
                        }
                    }
                }
                break;
            }

            const parent = path.dirname(currentDir);
            if (!parent || parent === currentDir) {
                break;
            }
            currentDir = parent;
        }
    } catch {
        // Safe fallback on any filesystem or permission error
    }
    return false;
}

/**
 * Checks whether the file path or filename corresponds to a known non-Kubernetes tool.
 */
function isKnownNonKubernetesPath(filePath: string, lowerBasename: string): boolean {
    if (KNOWN_NON_K8S_FILENAMES.has(lowerBasename)) {
        return true;
    }
    if (filePath.includes('/.github/workflows/') || filePath.includes('/.vscode/')) {
        return true;
    }
    return false;
}

type EvidenceLevel = 'strong_k8s' | 'ambiguous_k8s' | 'confident_non_k8s';

/**
 * Analyzes JSON content for Kubernetes resource structures.
 */
function checkKubernetesJsonEvidence(text: string): EvidenceLevel {
    try {
        const parsed = JSON.parse(text);
        if (typeof parsed !== 'object' || parsed === null) {
            return 'confident_non_k8s';
        }
        if (Array.isArray(parsed)) {
            const hasK8s = parsed.some(item => item && typeof item === 'object' && typeof item.apiVersion === 'string' && typeof item.kind === 'string');
            return hasK8s ? 'strong_k8s' : 'confident_non_k8s';
        }
        // Standard Kubernetes resource
        if (typeof parsed.apiVersion === 'string' && typeof parsed.kind === 'string') {
            return 'strong_k8s';
        }
        // Kubernetes List envelope
        if (typeof parsed.apiVersion === 'string' && Array.isArray(parsed.items)) {
            return 'strong_k8s';
        }
        // Parsed cleanly without apiVersion/kind: confident non-Kubernetes JSON
        return 'confident_non_k8s';
    } catch {
        // Malformed JSON fallback regex
        const hasApiVersion = /"apiVersion"\s*:\s*["'][^"']+["']/i.test(text);
        const hasKind = /"kind"\s*:\s*["'][^"']+["']/i.test(text);
        if (hasApiVersion && hasKind) {
            return 'strong_k8s';
        }
        if (hasApiVersion || hasKind) {
            return 'ambiguous_k8s';
        }
        return 'confident_non_k8s';
    }
}

/**
 * Analyzes YAML content for Kubernetes resource structures.
 */
function checkKubernetesYamlEvidence(text: string): EvidenceLevel {
    // 1. Flexible regex matching apiVersion and kind (supports quotes, inline comments, whitespace)
    const hasApiVersion = /(?:^|\n)\s*['"]?apiVersion['"]?\s*:\s*[^\s#]+/im.test(text);
    const hasKind = /(?:^|\n)\s*['"]?kind['"]?\s*:\s*[^\s#]+/im.test(text);

    if (hasApiVersion && hasKind) {
        return 'strong_k8s';
    }

    // 2. Helm template delimiters are strong indicators of templated manifests,
    // excluding GitHub Actions / shell expressions like ${{ ... }}
    const textWithoutDollarBraces = text.replace(/\$\{\{[\s\S]*?\}\}/g, '');
    if (textWithoutDollarBraces.includes('{{') && textWithoutDollarBraces.includes('}}')) {
        return 'strong_k8s';
    }

    // 3. Ambiguous evidence: one of apiVersion/kind or Kubernetes-like metadata + spec
    if (hasApiVersion || hasKind) {
        return 'ambiguous_k8s';
    }

    const hasMetadata = /(?:^|\n)\s*['"]?metadata['"]?\s*:\s*(?:\n|\s+#)/im.test(text);
    const hasSpec = /(?:^|\n)\s*['"]?spec['"]?\s*:\s*(?:\n|\s+#)/im.test(text);
    if (hasMetadata && hasSpec) {
        return 'ambiguous_k8s';
    }

    return 'confident_non_k8s';
}

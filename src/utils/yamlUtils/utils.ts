export function isYamlFile(file: string): boolean {
    return file.endsWith(".yaml") || file.endsWith(".yml");
}
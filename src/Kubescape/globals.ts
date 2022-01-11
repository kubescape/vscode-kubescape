export const KUBESCAPE = "kubescape"
export const PACKAGE_NAME = "kubescape.kubescape"
export const PACKAGE_BASE_URL = "https://api.github.com/repos/armosec/kubescape/releases/latest"

export const CONFIG_SCAN_ON_SAVE = "scanOnSave"
export const CONFIG_SCAN_FRAMEWORKS = "scanFrameworks"

export const IS_WINDOWS = process.platform === 'win32' ||
    process.env.OSTYPE === 'cygwin' ||
    process.env.OSTYPE === 'msys'

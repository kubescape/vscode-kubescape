export const KUBESCAPE = "kubescape"
export const PACKAGE_NAME = "kubescape.kubescape"
export const PACKAGE_BASE_URL = "https://api.github.com/repos/armosec/kubescape/releases/latest"
export const PACKAGE_DOWNLOAD_BASE_URL = "https://github.com/armosec/kubescape/releases/download"
export const PACKAGE_STABLE_BUILD = "v2.0.144"

export const CONFIG_SCAN_ON_SAVE = "scanOnSave"
export const CONFIG_SCAN_FRAMEWORKS = "scanFrameworks"
export const CONFIG_REQUIRED_FRAMEWORKS = "requiredFrameworks"
export const CONFIG_DIR_PATH = "dirPath"
export const CONFIG_VERSION_TIER = "versionTier"
export const CONFIG_CUSTOM_FRAMEWORKS_DIR = "customFrameworksDir"

export const COMMAND_SCAN_FRAMEWORK = "scan framework"
export const COMMAND_LIST_FRAMEWORKS = "list frameworks"
export const COMMAND_DOWNLOAD_FRAMEWORK = "download framework"
export const COMMAND_DOWNLOAD_ARTIFACTS = "download artifacts"
export const COMMAND_GET_VERSION = "version"
export const COMMAND_GET_HELP = "help"

export const ERROR_KUBESCAPE_NOT_INSTALLED = "Kubescape is not installed!"

export const ENV_SKIP_UPDATE_CHECK = "KUBESCAPE_SKIP_UPDATE_CHECK"


export const IS_WINDOWS = process.platform === 'win32' ||
    process.env.OSTYPE === 'cygwin' ||
    process.env.OSTYPE === 'msys'

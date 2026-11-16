declare const __PASEO_CONTEXT_VERSION__: string | undefined
declare const __PASEO_CONTEXT_REPO__: string | undefined

export const PLUGIN_NAME = 'paseo-context'
export const PLUGIN_VERSION: string =
  typeof __PASEO_CONTEXT_VERSION__ === 'string' ? __PASEO_CONTEXT_VERSION__ : '0.0.0-dev'
export const PLUGIN_REPO: string =
  typeof __PASEO_CONTEXT_REPO__ === 'string' ? __PASEO_CONTEXT_REPO__ : 'https://github.com/kogekiplay/paseo-context'
export const PLUGIN_REPO_SHORT = PLUGIN_REPO.replace(/^https?:\/\/github\.com\//, '')

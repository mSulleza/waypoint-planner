import { getDefaultConfig } from 'expo/metro-config'

const base = getDefaultConfig(__dirname)

// core never changes zod's locale, so the other 50 locales (about 40 kB gzipped of the web entry) stay out of every bundle.
const ZOD_LOCALES = /[\\/]zod[\\/]v4[\\/]locales[\\/]index\.js$/
const ENGLISH_ONLY = `${__dirname}/src/zod-locales.ts`

const config: typeof base = {
  ...base,
  resolver: {
    ...base.resolver,
    resolveRequest: (context, moduleName, platform) => {
      const resolved = context.resolveRequest(context, moduleName, platform)
      return resolved.type === 'sourceFile' && ZOD_LOCALES.test(resolved.filePath) ? { type: 'sourceFile', filePath: ENGLISH_ONLY } : resolved
    },
  },
}

export default config

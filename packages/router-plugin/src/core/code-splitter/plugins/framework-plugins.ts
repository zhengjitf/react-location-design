import { createReactRefreshIgnoredRouteExportsPlugin } from './react-refresh-ignored-route-exports'
import { createRefreshRouteComponentsPlugin } from './refresh-route-components'
import { createStableHmrSplitRouteComponentsPlugin } from './stable-hmr-split-route-components'
import type { ReferenceRouteCompilerPlugin } from '../plugins'
import type { Config, HmrStyle } from '../../config'

export function getReferenceRouteCompilerPlugins(opts: {
  targetFramework: Config['target']
  addHmr?: boolean
  hmrStyle?: HmrStyle
}): Array<ReferenceRouteCompilerPlugin> | undefined {
  if (!opts.addHmr) {
    return undefined
  }

  const hmrStyle = opts.hmrStyle ?? 'vite'

  switch (opts.targetFramework) {
    case 'react': {
      return [
        ...(hmrStyle === 'vite'
          ? [createReactRefreshIgnoredRouteExportsPlugin()]
          : []),
        createRefreshRouteComponentsPlugin(),
        createStableHmrSplitRouteComponentsPlugin({ hmrStyle }),
      ]
    }
    case 'solid': {
      return [
        createRefreshRouteComponentsPlugin(),
        createStableHmrSplitRouteComponentsPlugin({ hmrStyle }),
      ]
    }
    default:
      return undefined
  }
}

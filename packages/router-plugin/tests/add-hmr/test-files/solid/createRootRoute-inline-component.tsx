import { createRootRoute } from '@tanstack/solid-router'

export const Route = createRootRoute({
  component: () => <div>root hmr</div>,
})

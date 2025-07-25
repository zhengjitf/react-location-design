const $$splitLoaderImporter = () => import('destructured-react-memo-imported-component.tsx?tsr-split=loader');
import { lazyFn } from '@tanstack/react-router';
const $$splitComponentImporter = () => import('destructured-react-memo-imported-component.tsx?tsr-split=component---errorComponent---notFoundComponent---pendingComponent');
import { lazyRouteComponent } from '@tanstack/react-router';
import { createFileRoute } from '@tanstack/react-router';
export const Route = createFileRoute('/')({
  component: lazyRouteComponent($$splitComponentImporter, 'component'),
  loader: lazyFn($$splitLoaderImporter, 'loader')
});
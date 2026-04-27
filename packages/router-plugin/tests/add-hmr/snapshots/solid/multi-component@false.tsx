const $$splitErrorComponentImporter = () => import('multi-component.tsx?tsr-split=errorComponent');
const $$splitComponentImporter = () => import('multi-component.tsx?tsr-split=component');
import { lazyRouteComponent } from '@tanstack/solid-router';
import { createFileRoute } from '@tanstack/solid-router';
import { fetchPosts } from '../posts';
export const Route = createFileRoute('/posts')({
  loader: fetchPosts,
  component: lazyRouteComponent($$splitComponentImporter, 'component'),
  errorComponent: lazyRouteComponent($$splitErrorComponentImporter, 'errorComponent')
});
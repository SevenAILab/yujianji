import { proxyMemory } from '@/lib/memory-3d-proxy';

export const runtime = 'nodejs';
export const maxDuration = 180;

type Context = {params: Promise<{path: string[]}>};
async function handle(request: Request, context: Context) {
  const {path} = await context.params;
  return proxyMemory(request, path.join('/'));
}
export {handle as GET, handle as POST};

import type { Context } from '@deepseek-ai/cordis';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { AcpHub, type ConnectionProfile } from './hub.js';
import { isSupportedAgent } from './factory.js';
import type { NativeAcpAdapter } from './native.js';

interface WebContext extends Context {
  webServer: { register(route: { kind: 'prefix'; path: string; handler(req: IncomingMessage, res: ServerResponse): Promise<void> }): () => void };
  connection: { requestRejection(req: IncomingMessage): number | undefined };
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1024 * 1024) throw new Error('Request exceeds 1 MB');
    chunks.push(Buffer.from(chunk));
  }
  const value = JSON.parse(Buffer.concat(chunks).toString() || '{}');
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected JSON object');
  return value;
}

function text(body: Record<string, unknown>, key: string): string {
  if (typeof body[key] !== 'string') throw new Error(`${key} must be a string`);
  return body[key] as string;
}

/** All routes use the same auth and browser-trust fence as the stock API. */
export function mountWebApi(context: Context, hub: AcpHub, native?: NativeAcpAdapter): void {
  const ctx = context as WebContext;
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: '/acp-hub/api', handler: async (req, res) => {
    const rejection = ctx.connection.requestRejection(req);
    if (rejection) { send(res, rejection, { error: 'Unauthorized or untrusted request' }); return; }
    if (req.method !== 'GET' && req.headers['x-dsh-acp'] !== '1') {
      send(res, 403, { error: 'Missing request header' }); return;
    }
    try {
      await hub.ready;
      const url = new URL(req.url ?? '/', 'http://dsh.local');
      const path = url.pathname.slice('/acp-hub/api'.length);
      if (req.method === 'GET' && path === '/state') {
        send(res, 200, { agents: hub.agents(), profiles: hub.profiles(), sessions: hub.sessions() }); return;
      }
      if (req.method === 'POST' && path === '/profiles') {
        const profile = await hub.saveProfile(await readJson(req) as unknown as ConnectionProfile);
        send(res, 200, { profile }); return;
      }
      const profileId = path.match(/^\/profiles\/([^/]+)$/)?.[1];
      if (req.method === 'DELETE' && profileId) {
        await hub.deleteProfile(profileId); send(res, 200, { ok: true }); return;
      }
      if (req.method === 'POST' && path === '/test') {
        const body = await readJson(req); const agent = text(body, 'agent');
        if (!isSupportedAgent(agent)) throw new Error('Unsupported agent');
        const capabilities = await hub.test(agent, typeof body.profileId === 'string' ? body.profileId : undefined);
        send(res, 200, { capabilities }); return;
      }
      if (req.method === 'POST' && path === '/native/discover') {
        if (!native) throw new Error('Native ACP integration is unavailable');
        const body = await readJson(req);
        await native.discover(text(body, 'provider'), text(body, 'cwd'));
        send(res, 200, { models: await native.listModels(text(body, 'provider')) }); return;
      }
      if (req.method === 'POST' && path === '/sessions') {
        const body = await readJson(req); const agent = text(body, 'agent');
        if (!isSupportedAgent(agent)) throw new Error('Unsupported agent');
        const session = await hub.create({ agent, cwd: text(body, 'cwd'),
          profileId: typeof body.profileId === 'string' ? body.profileId : undefined,
          resumeId: typeof body.resumeId === 'string' ? body.resumeId : undefined });
        send(res, 201, { session }); return;
      }
      const match = path.match(/^\/sessions\/([^/]+)(?:\/(events|prompt|interrupt|permission|config|mode|history))?$/);
      if (match) {
        const [, id, action] = match;
        if (req.method === 'GET' && action === 'events') {
          send(res, 200, hub.events(id, Number(url.searchParams.get('after') ?? 0))); return;
        }
        if (req.method === 'DELETE' && !action) {
          await hub.close(id); send(res, 200, { ok: true }); return;
        }
        if (req.method === 'DELETE' && action === 'history') {
          await hub.deleteSession(id); send(res, 200, { ok: true }); return;
        }
        if (req.method === 'POST') {
          const body = await readJson(req);
          if (action === 'prompt') {
            if (hub.info(id).status !== 'idle') throw new Error('Session must be connected and idle');
            const prompt = text(body, 'prompt');
            if (!prompt.trim()) throw new Error('Message cannot be empty');
            hub.prompt(id, prompt);
          } else if (action === 'interrupt') await hub.interrupt(id);
          else if (action === 'permission') await hub.permission(id, text(body, 'requestId'), typeof body.optionId === 'string' ? body.optionId : undefined);
          else if (action === 'config') {
            if (typeof body.value !== 'string' && typeof body.value !== 'boolean') throw new Error('Invalid setting value');
            await hub.configure(id, text(body, 'configId'), body.value);
          } else if (action === 'mode') await hub.setMode(id, text(body, 'modeId'));
          else { send(res, 404, { error: 'Unknown action' }); return; }
          send(res, 200, { accepted: true }); return;
        }
      }
      send(res, 404, { error: 'Unknown route' });
    } catch (error) {
      send(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
  } }), 'acp-hub: authenticated web API');
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, stat, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseJson } from 'jsonc-parser';
import { parse as parseToml } from 'smol-toml';
import { plan, apply } from '../src/config.mjs';
import { probe, catalog } from '../src/api.mjs';

const model = { id: 'test-model', display_name: 'Test Model', available: true, context_tokens: 10000, max_output_tokens: 1000, capabilities: { tool_calling: true, image_input: false }, pricing: { input_usd_per_mtok: '0.28', output_usd_per_mtok: '1.1', cached_input_usd_per_mtok: '0.13' } };
const options = home => ({ home, env: {}, tools: ['claude', 'codex', 'opencode', 'pi'], model: model.id, models: [model] });
async function home(t) { const dir = await mkdtemp(join(tmpdir(), 'redrouter-test-')); t.after(() => rm(dir, { recursive: true, force: true })); return dir; }

test('merges all tools, retains permissions/comments, keeps keys out, and reruns without changes', async t => {
  const dir = await home(t);
  await mkdir(join(dir, '.claude'), { recursive: true });
  await mkdir(join(dir, '.codex'));
  await mkdir(join(dir, '.config/opencode'), { recursive: true });
  await writeFile(join(dir, '.claude/settings.json'), '{"permissions":{"deny":["Bash(rm:*)"]},"env":{"OTHER":"keep","ANTHROPIC_AUTH_TOKEN":"old"}}');
  const codex = '# preserve this\nmodel = "other"\n[features]\nshell_snapshot = false\n';
  await writeFile(join(dir, '.codex/config.toml'), codex);
  await writeFile(join(dir, '.config/opencode/opencode.jsonc'), '{\n// keep my policy\n"permission":"ask",\n"provider":{"other":{"name":"Other"}},\n}');
  const changes = await plan(options(dir));
  const backups = await apply(changes);
  assert.equal(backups.length, 2);
  const claude = JSON.parse(await readFile(join(dir, '.claude/settings.json'), 'utf8'));
  assert.deepEqual(claude.permissions, { deny: ['Bash(rm:*)'] });
  assert.equal(claude.env.OTHER, 'keep');
  assert.equal(claude.env.ANTHROPIC_AUTH_TOKEN, undefined);
  assert.match(claude.apiKeyHelper, /process.env.REDROUTER_API_KEY/);
  const toml = await readFile(join(dir, '.codex/config.toml'), 'utf8');
  assert.ok(toml.startsWith(codex));
  assert.equal(toml, codex);
  assert.equal(parseToml(await readFile(join(dir, '.codex/redrouter.config.toml'), 'utf8')).model, model.id);
  const oc = await readFile(join(dir, '.config/opencode/opencode.jsonc'), 'utf8');
  assert.match(oc, /keep my policy/);
  assert.equal(parseJson(oc).provider.other.name, 'Other');
  assert.equal(parseJson(oc).permission, 'ask');
  const pi = JSON.parse(await readFile(join(dir, '.pi/agent/models.json'), 'utf8'));
  assert.equal(pi.providers.redrouter.models[0].id, model.id);
  assert.equal(pi.providers.redrouter.apiKey, '$REDROUTER_API_KEY');
  for (const c of changes) assert.equal((await stat(c.path)).mode & 0o777, 0o600);
  assert.deepEqual(await plan(options(dir)), []);
  const old = JSON.parse(await readFile(backups.find(p => p.includes('settings.json')), 'utf8'));
  assert.equal(old.env.ANTHROPIC_AUTH_TOKEN, 'old');
});

test('invalid config and unmanaged Codex tables stop before writes', async t => {
  const dir = await home(t);
  await mkdir(join(dir, '.codex'));
  const path = join(dir, '.codex/config.toml');
  const existing = '[profiles."redrouter"]\nmodel = "custom"\n';
  await writeFile(path, existing);
  await assert.rejects(plan(options(dir)), /unmanaged/);
  assert.equal(await readFile(path, 'utf8'), existing);
  await writeFile(path, 'invalid toml');
  await assert.rejects(plan(options(dir)));
  await assert.rejects(stat(join(dir, '.claude')), { code: 'ENOENT' });
});

test('refuses symlink config and rolls back earlier writes on concurrent changes', async t => {
  const dir = await home(t);
  await mkdir(join(dir, '.claude'));
  await writeFile(join(dir, 'original'), '{}');
  await symlink(join(dir, 'original'), join(dir, '.claude/settings.json'));
  await assert.rejects(plan(options(dir)), /non-regular/);
  const a = join(dir, 'a'); const b = join(dir, 'b');
  await writeFile(a, 'before'); await writeFile(b, 'concurrent');
  await assert.rejects(apply([{ path: a, before: 'before', after: 'after' }, { path: b, before: null, after: 'replace' }]), /changed during/);
  assert.equal(await readFile(a, 'utf8'), 'before');
  assert.equal(await readFile(b, 'utf8'), 'concurrent');
});

test('protocol probes authenticate, cap output, reject errors and empty generations without leaking server bodies', async () => {
  for (const protocol of ['chat', 'messages', 'responses']) {
    const response = protocol === 'chat' ? { choices: [{ message: { content: 'OK' } }] } : protocol === 'messages' ? { content: [{ type: 'text', text: 'OK' }] } : { output: [{ content: [{ type: 'output_text', text: 'OK' }] }] };
    await probe(protocol, model.id, 'secret', { fetcher: async (url, init) => {
      assert.equal(init.headers.Authorization, 'Bearer secret');
      const body = JSON.parse(init.body);
      assert.equal(body.max_tokens ?? body.max_output_tokens, 64);
      assert.equal(body.model, model.id);
      if (protocol === 'responses') {
        assert.equal(body.store, false);
        assert.equal(body.parallel_tool_calls, true);
      }
      return Response.json(response);
    } });
    await assert.rejects(probe(protocol, model.id, 'secret', { fetcher: async () => Response.json({}) }), /no text/);
  }
  await assert.rejects(probe('chat', model.id, 'secret', { fetcher: async () => new Response('sensitive error body', { status: 401 }) }), e => /401/.test(e.message) && !e.message.includes('sensitive'));
  await assert.rejects(catalog({ fetcher: async () => Response.json({ models: [{ ...model, context_tokens: 'invalid' }] }) }), /metadata/);
});

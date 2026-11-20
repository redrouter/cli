import { readFile, writeFile, mkdir, rename, lstat, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parse, modify, applyEdits } from 'jsonc-parser';
import { parse as parseToml } from 'smol-toml';
import { ORIGIN, piModel, opencodeProvider } from './api.mjs';

const BEGIN = '# BEGIN REDROUTER MANAGED PROFILE';
const END = '# END REDROUTER MANAGED PROFILE';

async function read(path) {
  try {
    if (!(await lstat(path)).isFile()) throw new Error(`Refusing to replace a non-regular file: ${path}`);
    return await readFile(path, 'utf8');
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function jsonEdit(source, updates) {
  const errors = [];
  const value = parse(source || '{}', errors, { allowTrailingComma: true });
  if (errors.length || !value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Config must contain a valid JSON/JSONC object.');
  let result = source || '{}\n';
  for (const [path, value] of updates) result = applyEdits(result, modify(result, path, value, { formattingOptions: { insertSpaces: true, tabSize: 2 } }));
  return result.endsWith('\n') ? result : `${result}\n`;
}

function codexConfig(source, model) {
  const value = parseToml(source || '');
  const start = source?.indexOf(BEGIN) ?? -1;
  const end = source?.indexOf(END) ?? -1;
  if ((start < 0) !== (end < 0) || (start >= 0 && end < start)) throw new Error('Incomplete RedRouter managed block in Codex config.');
  if (start < 0 && Object.keys(value).length) throw new Error('Codex already has an unmanaged redrouter.config.toml. Rename it or merge it manually; no files changed.');
  const block = `${BEGIN}\nmodel = ${JSON.stringify(model)}\nmodel_provider = "redrouter"\nmodel_reasoning_summary = "none"\nweb_search = "disabled"\n\n[features]\nshell_snapshot = false\nview_image = false\n\n[model_providers.redrouter]\nname = "RedRouter"\nbase_url = "${ORIGIN}/v1"\nenv_key = "REDROUTER_API_KEY"\nwire_api = "responses"\nrequires_openai_auth = false\nsupports_websockets = false\nrequest_max_retries = 0\nstream_max_retries = 0\n${END}`;
  const result = start >= 0 ? source.slice(0, start) + block + source.slice(end + END.length) : `${source || ''}${source?.endsWith('\n') ? '' : '\n'}\n${block}\n`;
  parseToml(result);
  return result;
}

export async function plan({ home, env = process.env, tools, model, models }) {
  const changes = [];
  async function add(path, edit) {
    const before = await read(path);
    try { changes.push({ path, before, after: edit(before) }); }
    catch (e) { throw new Error(`${path}: ${e.message}`); }
  }
  if (tools.includes('claude')) {
    await add(join(env.CLAUDE_CONFIG_DIR || join(home, '.claude'), 'settings.json'), source => jsonEdit(source, [
      [['apiKeyHelper'], 'node -e "process.stdout.write(process.env.REDROUTER_API_KEY || \'\')"'],
      ...Object.entries({ ANTHROPIC_BASE_URL: ORIGIN, ANTHROPIC_AUTH_TOKEN: undefined, ANTHROPIC_API_KEY: '', ANTHROPIC_MODEL: model, ANTHROPIC_DEFAULT_SONNET_MODEL: model, ANTHROPIC_DEFAULT_OPUS_MODEL: model, ANTHROPIC_DEFAULT_HAIKU_MODEL: model, ANTHROPIC_DEFAULT_FABLE_MODEL: model, CLAUDE_CODE_SUBAGENT_MODEL: model, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(models.find(m => m.id === model).context_tokens) }).map(([k, v]) => [['env', k], v]),
    ]));
  }
  if (tools.includes('codex')) {
    const dir = env.CODEX_HOME || join(home, '.codex');
    const base = parseToml(await read(join(dir, 'config.toml')) || '');
    if (base.profiles?.redrouter || base.profile === 'redrouter') throw new Error('Codex config.toml has an unmanaged legacy redrouter profile. Move it to redrouter.config.toml or rename it before setup. No files changed.');
    await add(join(dir, 'redrouter.config.toml'), source => codexConfig(source, model));
  }
  if (tools.includes('opencode')) {
    const dir = env.OPENCODE_CONFIG_DIR || join(env.XDG_CONFIG_HOME || join(home, '.config'), 'opencode');
    const jsonc = join(dir, 'opencode.jsonc');
    const path = await read(jsonc) !== null ? jsonc : join(dir, 'opencode.json');
    await add(path, source => jsonEdit(source, [[['provider', 'redrouter'], opencodeProvider(models)], [['model'], `redrouter/${model}`]]));
  }
  if (tools.includes('pi')) {
    const dir = env.PI_CODING_AGENT_DIR || join(home, '.pi', 'agent');
    await add(join(dir, 'models.json'), source => jsonEdit(source, [[['providers', 'redrouter'], { baseUrl: `${ORIGIN}/v1`, api: 'openai-completions', apiKey: '$REDROUTER_API_KEY', models: models.map(piModel) }]]));
    await add(join(dir, 'settings.json'), source => jsonEdit(source, [[['defaultProvider'], 'redrouter'], [['defaultModel'], model]]));
  }
  return changes.filter(c => c.before !== c.after);
}

async function atomic(path, content) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  try { await writeFile(temp, content, { mode: 0o600, flag: 'wx' }); await rename(temp, path); }
  finally { await unlink(temp).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
}

export async function apply(changes) {
  const written = [];
  const backups = [];
  const stamp = `${Date.now()}-${randomUUID().slice(0, 8)}`;
  try {
    for (const c of changes) {
      if (await read(c.path) !== c.before) throw new Error(`Config changed during setup: ${c.path}. Run init again.`);
      if (c.before !== null) {
        const backup = `${c.path}.redrouter-${stamp}.bak`;
        await writeFile(backup, c.before, { mode: 0o600, flag: 'wx' });
        backups.push(backup);
      }
      await atomic(c.path, c.after);
      written.push(c);
    }
  } catch (error) {
    for (const c of written.reverse()) {
      if (c.before === null) await unlink(c.path); else await atomic(c.path, c.before);
    }
    throw error;
  }
  return backups;
}

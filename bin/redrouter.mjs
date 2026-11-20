#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { homedir } from 'node:os';
import { catalog, probe, DEFAULT_MODEL } from '../src/api.mjs';
import { plan, apply } from '../src/config.mjs';

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { tools: { type: 'string', default: 'claude,codex,opencode,pi' }, model: { type: 'string', default: DEFAULT_MODEL }, 'dry-run': { type: 'boolean' }, 'skip-test': { type: 'boolean' }, help: { type: 'boolean', short: 'h' }, version: { type: 'boolean' } } });
  if (values.version) { console.log('0.1.0'); return; }
  if (values.help || !positionals.length) {
    console.log('Usage: redrouter init [--tools claude,codex,opencode,pi] [--model ID] [--dry-run] [--skip-test]\n\nExport REDROUTER_API_KEY from https://redrouter.org/keys first.\nInit merges user config, installs OpenCode/Pi plugins, backs up changed files,\nand makes one short, billable test generation using the first selected tool\'s protocol.\n--dry-run lists files without writing or generating. --skip-test only configures.\nAgent tools must be installed separately. Start Codex with: codex --profile redrouter');
    return;
  }
  if (positionals.length !== 1 || positionals[0] !== 'init') throw new Error('Unknown command. Run redrouter --help.');
  const tools = [...new Set(values.tools.split(',').map(t => t.trim()))];
  if (!tools.length || tools.some(t => !['claude', 'codex', 'opencode', 'pi'].includes(t))) throw new Error('--tools must contain claude, codex, opencode, and/or pi.');
  const key = process.env.REDROUTER_API_KEY;
  if (!values['dry-run'] && !values['skip-test'] && !key) throw new Error('Export REDROUTER_API_KEY from https://redrouter.org/keys, then run init again. No files changed.');
  const models = await catalog();
  const model = models.find(m => m.id === values.model);
  if (!model) throw new Error(`Model ${values.model} is unavailable. Choose an ID at https://redrouter.org/models.`);
  if (!model.capabilities.tool_calling) throw new Error('Choose a model with tool calling for agent setup.');
  const changes = await plan({ home: homedir(), tools, model: model.id, models });
  console.log(`${values['dry-run'] ? 'Would configure' : 'Configuring'} ${tools.join(', ')} with ${model.id}.`);
  for (const c of changes) console.log(`  ${c.path}`);
  if (values['dry-run']) { console.log('Dry run: no files changed; no generations dispatched.'); return; }
  if (!values['skip-test']) {
    const protocol = tools[0] === 'claude' ? 'messages' : tools[0] === 'codex' ? 'responses' : 'chat';
    console.log(`Testing ${protocol}: one generation, up to 64 output tokens; uses trial or paid usage.`);
    await probe(protocol, model.id, key);
    console.log(`  ${protocol}: passed`);
  }
  const backups = await apply(changes);
  console.log(changes.length ? 'Setup saved.' : 'Setup already matches.');
  for (const path of backups) console.log(`Backup: ${path}`);
  console.log('Keep REDROUTER_API_KEY exported in the shell where you launch your tools.');
  if (tools.includes('claude')) console.log('Claude Code: claude --model ' + model.id);
  if (tools.includes('codex')) console.log('Codex: codex --profile redrouter -c features.shell_snapshot=false -c features.view_image=false');
  if (tools.includes('opencode')) console.log('OpenCode (1.x): opencode --model redrouter/' + model.id);
  if (tools.includes('pi')) console.log('Pi: pi --provider redrouter --model ' + model.id);
  if (values['skip-test']) console.log('API tests skipped. Rerun without --skip-test to verify credentials and protocols.');
}

main().catch(error => { console.error(`redrouter: ${error.message}`); process.exitCode = 1; });

// Herdr (herdr.mjs): commands and coding agents in Roamies' own Herdr session, driven through a stand-in herdr CLI
// that keeps its own panes and agents. Run: npm test
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHerdr, exitOf, findHerdr, liveCodersText, marker, SESSION, tailOf, withMarker } from '../herdr.mjs';
import { ASK, BLOCK, checkCoder, checkCoderKeys, classifyCommand } from '../safety.mjs';

// The end marker: on its own line with the exit code; a command's ";" or "&" ending still runs.
const m = marker('t1');
assert.equal(withMarker('npm test', m), `npm test; ${m.print}`);
assert.equal(withMarker('npm test;; ', m), `npm test; ${m.print}`);
assert.equal(withMarker('npm run dev &', m), `npm run dev & ${m.print}`);
assert.equal(withMarker('make && make test', m), `make && make test; ${m.print}`);
assert.equal(exitOf('__roamies_2_t1'), 2);
assert.equal(exitOf(`❯ npm test; printf '\\n__roamies_%s_t1\\n' "$?"`), null, 'the typed command never counts as the end');
assert.ok(new RegExp(m.regex).test('__roamies_0_t1') && !new RegExp(m.regex).test('x __roamies_0_t1'));
assert.equal(tailOf('a\n\nb\n__roamies_0_t1\n\n  \n', 5), 'a\nb', 'blank lines and markers dropped');
assert.equal(tailOf('1\n2\n3\n4', 2), '3\n4');
// Finding herdr: on PATH, else where its installers put it.
assert.equal(findHerdr({ env: { PATH: '/usr/bin' }, home: '/Users/ken', exists: (p) => p === '/Users/ken/.local/bin/herdr' }), '/Users/ken/.local/bin/herdr');
assert.equal(findHerdr({ env: { PATH: '' }, home: '/x', exists: () => false }), null);

// ---- a stand-in herdr ----
const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'roamies-herdr-')));
fs.mkdirSync(path.join(home, 'code', 'app'), { recursive: true });
const fake = { server: false, spawned: 0, calls: [], panes: new Map(), agents: new Map(), n: 0, ws: 0 };
const ok = (result) => ({ code: 0, stdout: JSON.stringify({ result }), stderr: '' });
const fail = (code, message) => ({ code: 1, stdout: '', stderr: JSON.stringify({ error: { code, message } }) });
async function run(bin, args) {
  assert.deepEqual(args.slice(0, 2), ['--session', SESSION], 'always Roamies\' own session');
  const [a, b, ...rest] = args.slice(2);
  fake.calls.push([a, b, ...rest]);
  if (a === 'status') return { code: 0, stdout: `server:\n  status: ${fake.server ? 'running' : 'not running'}\n`, stderr: '' };
  if (!fake.server) return fail('no_server', 'not running');
  const pane = () => { const id = `w1:p${++fake.n}`; fake.panes.set(id, { text: '❯ ' }); return id; };
  if (a === 'workspace' && b === 'create') { fake.ws++; const p = pane(); return ok({ workspace: { workspace_id: 'w1' }, tab: { tab_id: 'w1:t1' }, root_pane: { pane_id: p } }); }
  if (a === 'tab' && b === 'create') { assert.equal(rest[1], 'w1', 'tabs go in the Roamies workspace'); return ok({ tab: { tab_id: `w1:t${fake.n + 1}` }, root_pane: { pane_id: pane() } }); }
  if (a === 'tab' && b === 'rename') return ok({});
  if (a === 'tab' && b === 'close') { (fake.closed ??= []).push(rest[0] ?? b); return ok({}); }
  if (a === 'workspace' && b === 'list') return ok({ workspaces: fake.ws ? [{ workspace_id: 'w1', label: 'Roamies' }] : [{ workspace_id: 'w9', label: 'mine' }] });
  if (a === 'pane' && b === 'run') {
    const [id, cmd] = rest, p = fake.panes.get(id), tok = /__roamies_%s_(\w+)/.exec(cmd)[1];
    p.cmd = cmd;
    p.text += `${cmd}\nbuilding…\n`;
    if (!/sleep/.test(cmd)) p.text += `done\n__roamies_${/fail/.test(cmd) ? 1 : 0}_${tok}\n❯ `;
    return ok({});
  }
  if (a === 'pane' && b === 'wait-output') {
    const p = fake.panes.get(rest[0]), re = new RegExp(rest[rest.indexOf('--regex') + 1], 'm'), hit = p.text.split('\n').find((l) => re.test(l));
    return hit ? ok({ matched_line: hit }) : fail('timeout', 'timed out');
  }
  if (a === 'pane' && b === 'read') return { code: 0, stdout: fake.panes.get(rest[0]).text, stderr: '' };
  if (a === 'pane' && b === 'send-keys') return ok({});
  if (a === 'agent' && b === 'start') {
    const name = rest[0], kind = rest[rest.indexOf('--kind') + 1], p = rest[rest.indexOf('--pane') + 1];
    if (kind === 'opencode') return fail('agent_kind_unavailable', 'opencode is not installed');
    const trust = fake.panes.get(p).cwd?.includes('new');
    fake.agents.set(name, { status: trust ? 'blocked' : 'idle', screen: trust ? 'Is this a project you trust?\n❯ No, exit\n  Yes, I trust this folder' : 'Claude Code ready', prompts: [], keys: [] });
    return trust ? fail('agent_not_ready', `agent ${name} is blocked during startup and is not ready for prompts`) : ok({ agent: { name } });
  }
  if (a === 'agent' && b === 'list') return ok({ agents: [...fake.agents].map(([name, x]) => ({ name, agent_status: x.status })) });
  if (a === 'agent' && b === 'read') return { code: 0, stdout: fake.agents.get(rest[0]).screen, stderr: '' };
  if (a === 'agent' && b === 'prompt') { fake.agents.get(rest[0]).prompts.push(rest[1]); fake.agents.get(rest[0]).status = 'working'; return ok({}); }
  if (a === 'agent' && b === 'send-keys') { fake.agents.get(rest[0]).keys.push(rest.slice(1)); return ok({}); }
  return fail('unknown', `fake herdr: ${args.join(' ')}`);
}
// The cwd of each new tab, so the fake knows which folder an agent starts in.
const runCwd = async (bin, args, o) => { const r = await run(bin, args, o); const i = args.indexOf('--cwd'); if (i > 0 && r.code === 0) { const id = JSON.parse(r.stdout).result.root_pane.pane_id; fake.panes.get(id).cwd = args[i + 1]; } return r; };
let allow = true, asked = [], answer = true;
const hd = createHerdr({
  bin: '/x/herdr', run: runCwd, spawnServer: () => { fake.spawned++; fake.server = true; },
  safety: { classifyCommand, checkCoder, checkCoderKeys, BLOCK, ASK }, confirm: async (q) => { asked.push(q); return answer; },
  allowActions: () => allow, openTerminal: async (c) => { fake.opened = c; }, home, userName: 'Ken', pollMs: 1e9, wait: async () => {},
});
const tool = (name) => hd.tools.find((t) => t.name === name);

// Commands: the server starts once, each command gets its own tab, the result has its exit code and output.
let out = await tool('terminal_run').execute({ command: 'ls', cwd: '~/code/app' });
assert.match(out, /^Exit 0 \(pane w1:p1\)\.\n/);
assert.match(out, /\n❯ ls\nbuilding…\ndone\n❯$/, 'its output, without the end marker (on the typed line too)');
assert.equal(fake.spawned, 1);
assert.deepEqual(asked, [], 'a safe command needs no yes');
out = await tool('terminal_run').execute({ command: 'npm test fail', cwd: path.join(home, 'code', 'app') });
assert.match(out, /^Exit 1 \(pane w1:p2\)/);
assert.equal(fake.ws, 1, 'one Roamies workspace, a tab per job');
out = await tool('terminal_run').execute({ command: 'sleep 999', wait_seconds: 5 });
assert.match(out, /^Still running in pane w1:p3 after 5 s \(it keeps going\)\. terminal_read w1:p3 to check it, terminal_stop w1:p3 to stop it\./);
assert.equal(fake.spawned, 1, 'the server is started only once');
// Changing things asks first, like run_command; a no stops it; blocked commands never run.
answer = false;
await assert.rejects(tool('terminal_run').execute({ command: `rm -rf ${home}/code/app/build` }), /Ken said no/);
assert.equal(asked[0], 'Run `npm test fail` in a terminal?', 'running code asks, as with run_command');
assert.match(asked.at(-1), /^Run `rm -rf .*` in a terminal\?/);
await assert.rejects(tool('terminal_run').execute({ command: 'cat ~/.ssh/id_rsa' }), /Blocked for safety/);
answer = true;
await assert.rejects(tool('terminal_run').execute({ command: 'ls', cwd: '~/nope' }), /doesn't exist/);
allow = false;
await assert.rejects(tool('terminal_run').execute({ command: 'ls' }), /switched off/);
await assert.rejects(tool('start_coder').execute({ kind: 'claude', cwd: '~/code/app', task: 'x' }), /switched off/);
allow = true;
assert.match(await tool('terminal_read').execute({ target: 'w1:p3' }), /building…$/);
// Finished commands' tabs: only the newest 5 stay.
for (let i = 0; i < 4; i++) await tool('terminal_run').execute({ command: 'ls' });
assert.deepEqual(fake.closed, ['w1:t1'], 'the oldest finished tab closed; running ones never do');
// After a restart, the Roamies workspace is found again, not made anew.
const again = createHerdr({ bin: '/x/herdr', run: runCwd, spawnServer: () => {}, safety: { classifyCommand, checkCoder, checkCoderKeys, BLOCK, ASK }, confirm: async () => true, allowActions: () => true, openTerminal: async () => {}, home, pollMs: 1e9, wait: async () => {} });
await again.tools.find((t) => t.name === 'terminal_run').execute({ command: 'ls' });
assert.equal(fake.ws, 1, 'one Roamies workspace across restarts');
again.stop();
assert.equal(await tool('terminal_stop').execute({ target: 'w1:p3' }), 'Sent Ctrl+C to w1:p3.');
assert.deepEqual(fake.calls.at(-1), ['pane', 'send-keys', 'w1:p3', 'ctrl+c']);

// A coding agent: started on its task, working, then done is news with what's on its screen.
out = await tool('start_coder').execute({ kind: 'claude', cwd: '~/code/app', task: 'Fix the failing test.', name: 'Fixer!' });
assert.match(out, /^fixer \(claude\) is working in .*code\/app, in its own Herdr tab\./);
assert.deepEqual(fake.agents.get('fixer').prompts, ['Fix the failing test.'], 'the task is sent as data');
assert.deepEqual(hd.news(), [], 'nothing to tell while it works');
assert.match(hd.liveText(), /^Coding agents in Herdr \(names for tell_coder, answer_coder and terminal_read\):\n- fixer \(claude in .*code\/app\): working$/);
fake.agents.get('fixer').status = 'idle'; fake.agents.get('fixer').screen = 'Fixed the off-by-one in sum.js; all 12 tests pass.';
await hd.poll();
let n = hd.news();
assert.deepEqual(n.map((i) => [i.id, i.kind, i.type]), [['fixer', 'done', 'claude in Herdr']]);
assert.match(n[0].report, /all 12 tests pass/);
hd.markTold(['fixer']);
assert.deepEqual(hd.news(), []);
// A question mid-way: news to pass on; only plain keys answer it, and only what they said.
await tool('tell_coder').execute({ name: 'fixer', message: 'Now commit it.' });
fake.agents.get('fixer').status = 'blocked'; fake.agents.get('fixer').screen = 'Allow git commit?\n❯ 1. Yes\n  2. No';
await hd.poll();
n = hd.news();
assert.equal(n[0].kind, 'ask');
assert.match(n[0].question, /answer with answer_coder once Ken says what to pick\): Allow git commit\?/);
await assert.rejects(tool('tell_coder').execute({ name: 'fixer', message: 'hurry' }), /waiting for an answer to its question first/);
await assert.rejects(tool('answer_coder').execute({ name: 'fixer', keys: ['git push --force'] }), /isn't a key I'll press/);
out = await tool('answer_coder').execute({ name: 'fixer', keys: ['1'] });
assert.match(out, /^Pressed 1 for fixer\./);
assert.deepEqual(fake.agents.get('fixer').keys, [['1']]);
assert.deepEqual(hd.news(), [], 'answered: nothing left to tell');
await assert.rejects(tool('tell_coder').execute({ name: 'ghost', message: 'x' }), /No coding agent ghost/);

// Blocked at startup (a "trust this folder?" check): the task waits until it's answered, then goes in.
fs.mkdirSync(path.join(home, 'new'), { recursive: true });
out = await tool('start_coder').execute({ kind: 'claude', cwd: path.join(home, 'new'), task: 'Set up the project.' });
assert.match(out, /^claude started in .*new but is asking something first; the task goes in once it's answered\./);
assert.match(out, /Yes, I trust this folder/);
assert.deepEqual(fake.agents.get('claude').prompts, []);
assert.deepEqual(hd.news(), [], 'the result already told the chat');
await tool('answer_coder').execute({ name: 'claude', keys: ['down', 'enter'] });
fake.agents.get('claude').status = 'idle';
await hd.poll();
assert.deepEqual(fake.agents.get('claude').prompts, ['Set up the project.'], 'the waiting task went in');
assert.match(hd.liveText(), /- claude \(claude in .*new\): working/);
// Names stay unique; an exited agent is news; kinds and folders are checked.
await tool('start_coder').execute({ kind: 'codex', cwd: '~/code/app', task: 'Review.', name: 'fixer' });
assert.ok(hd.coders.has('fixer-2'), 'a second fixer gets its own name');
fake.agents.delete('fixer-2');
await hd.poll();
assert.deepEqual(hd.news().map((i) => [i.id, i.kind, i.reason]), [['fixer-2', 'failed', 'the agent exited']]);
await assert.rejects(tool('start_coder').execute({ kind: 'opencode', cwd: '~/code/app', task: 'x' }), /Couldn't start opencode: opencode is not installed/);
assert.ok(!hd.coders.has('opencode'), 'one that never started is forgotten');
await assert.rejects(tool('start_coder').execute({ kind: 'bash', cwd: '~/code/app', task: 'x' }), /kind must be one of/);
await assert.rejects(tool('start_coder').execute({ kind: 'claude', cwd: '~/.ssh', task: 'x' }), /Not in ~\/\.ssh/);
await tool('show_terminals').execute({});
assert.equal(fake.opened, `'/x/herdr' --session roamies`);
assert.equal(liveCodersText([]), '');
hd.stop();
fs.rmSync(home, { recursive: true, force: true });
console.log('herdr tests: passed');

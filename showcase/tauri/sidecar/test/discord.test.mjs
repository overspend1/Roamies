// Discord (discord.mjs): the user's own bot, driven through a stand-in Discord API and gateway. Run: npm test
import assert from 'node:assert/strict';
import { createDiscord, INTENTS, inviteUrl, messageLine, PERMISSIONS, resolveTarget } from '../discord.mjs';
import { checkDiscordMessage } from '../safety.mjs';

// Where a message goes: a channel by name (or server/name), a person, or an id.
const guilds = [{ name: 'Crew', channels: [{ id: '111111111111111111', name: 'general' }, { id: '222222222222222222', name: 'games' }] }, { name: 'Work', channels: [{ id: '333333333333333333', name: 'general' }] }];
assert.deepEqual(resolveTarget('#games', guilds), { channel: '222222222222222222', label: '#games in Crew' });
assert.deepEqual(resolveTarget('Work/#general', guilds), { channel: '333333333333333333', label: '#general in Work' });
assert.match(resolveTarget('#general', guilds).error, /in Crew and Work; say which, like Crew\/#general/);
assert.match(resolveTarget('#nope', guilds).error, /No channel #nope/);
assert.deepEqual(resolveTarget('@Ola', guilds), { user: 'ola' });
assert.deepEqual(resolveTarget('444444444444444444', guilds), { channel: '444444444444444444' });
assert.match(resolveTarget('rm -rf /', guilds).error, /isn't a channel/);
assert.equal(messageLine({ author: { username: 'ola', global_name: 'Ola' }, content: 'see you\n at 8', timestamp: '2026-11-13T18:30:00Z', attachments: [{ filename: 'map.png' }] }), '[2026-11-13 18:30] Ola: see you at 8 [map.png]');
assert.equal(inviteUrl('99'), `https://discord.com/oauth2/authorize?client_id=99&scope=bot&permissions=${PERMISSIONS}`);
assert.equal(PERMISSIONS, 1024 + 2048 + 65536 + 1048576 + 2097152, 'view channels, send messages, read history, connect and speak: nothing more');

// ---- a stand-in Discord ----
const TOKEN = `MTIz.${'a'.repeat(60)}`;
const sent = [], calls = [];
let saved = null, answer = 'Send';
const fetch = async (url, o) => {
  const route = url.replace('https://discord.com/api/v10', '');
  calls.push([o.method, route]);
  assert.equal(o.headers.Authorization, `Bot ${saved ?? TOKEN}`, 'always the bot token, as a bot');
  const res = (status, body) => ({ status, ok: status < 300, json: async () => body });
  if (o.headers.Authorization !== `Bot ${TOKEN}`) return res(401, { message: '401: Unauthorized' });
  if (route === '/users/@me') return res(200, { id: '900', username: 'roamiesbot' });
  if (route === '/oauth2/applications/@me') return res(200, { id: '901', owner: { id: '42' } });
  if (route.startsWith('/guilds/') && route.includes('members/search')) return res(200, /query=tomek/.test(route) ? [{ user: { id: '555', username: 'tomek' } }] : []);
  if (route === '/users/@me/channels') return res(200, { id: `dm-${JSON.parse(o.body).recipient_id}` });
  if (o.method === 'GET' && /\/channels\/\d+\/messages/.test(route)) return res(200, [{ id: '2', author: { id: '7', username: 'ola' }, content: 'second', timestamp: '2026-11-13T18:31:00Z' }, { id: '1', author: { id: '7', username: 'ola' }, content: 'first', timestamp: '2026-11-13T18:30:00Z' }]);
  if (o.method === 'POST' && route.endsWith('/messages')) { sent.push([route, JSON.parse(o.body)]); return res(200, { id: 'm' }); }
  return res(404, { message: 'Unknown' });
};
const sockets = [];
class FakeSocket {
  constructor(url) { this.url = url; this.out = []; sockets.push(this); }
  send(x) { this.out.push(JSON.parse(x)); }
  close(code) { this.closed = code; }
  in(p) { this.onmessage({ data: JSON.stringify(p) }); }
}
const asked = [], joined = [];
const callDeps = { names: () => ['Roamie'], transcribe: async () => '', synth: async () => {}, answer: async () => '' };
const d = createDiscord({
  call: callDeps, joinCall: async (o) => { joined.push(o); return { leave: () => { joined.at(-1).left = true; }, channelId: o.channelId, guildId: o.guildId }; },
  getToken: async () => saved, saveToken: async (t) => { saved = t; }, removeToken: async () => { saved = null; },
  askToken: async () => TOKEN, confirm: async (q) => { asked.push(q); return answer === 'Send'; }, checkMessage: checkDiscordMessage,
  userName: 'Ken', fetch, WebSocket: FakeSocket, retryMs: 1,
});
const tool = (n) => d.tools.find((t) => t.name === n);
assert.equal(await d.start(), false, 'nothing saved: not connected');
assert.equal(d.liveText(), '');
await assert.rejects(tool('discord_read').execute({ to: '#general' }), /isn't set up/);

// Setup: the token comes from the hidden field, is checked with Discord, saved, and the gateway connects.
out(await tool('discord_setup').execute({}));
function out(t) { assert.match(t, /^Connected as roamiesbot\. To add it to Ken's server, they open: https:\/\/discord\.com\/oauth2\/authorize\?client_id=901&scope=bot&permissions=3214336\./); }
assert.equal(saved, TOKEN);
const ws = sockets.at(-1);
assert.equal(ws.url, 'wss://gateway.discord.gg/?v=10&encoding=json');
ws.in({ op: 10, d: { heartbeat_interval: 1e9 } });
assert.deepEqual(ws.out[0], { op: 2, d: { token: TOKEN, intents: INTENTS, properties: { os: process.platform, browser: 'roamies', device: 'roamies' } } });
ws.in({ op: 0, s: 1, t: 'READY', d: { user: { id: '900', username: 'roamiesbot' } } });
ws.in({ op: 0, s: 2, t: 'GUILD_CREATE', d: { id: 'g1', name: 'Crew', channels: [{ id: '111111111111111111', name: 'general', type: 0 }, { id: 'v1', name: 'Voice', type: 2 }] } });
ws.in({ op: 1 });
assert.deepEqual(ws.out.at(-1), { op: 1, d: 2 }, 'a heartbeat when asked, with the last sequence');
assert.match(d.liveText(), /^Discord: connected as the bot roamiesbot, in 1 server\./);
assert.match(await tool('discord_list').execute({}), /- Crew: #general; voice: Voice$/m, 'text and voice channels apart');

// Friends' messages: DMs and @mentions are news (their words as information); other chatter isn't.
ws.in({ op: 0, s: 3, t: 'MESSAGE_CREATE', d: { id: 'a1', channel_id: 'dm-7', author: { id: '7', username: 'ola', global_name: 'Ola' }, content: 'ask Ken if he is free tonight', timestamp: '2026-11-13T18:00:00Z' } });
ws.in({ op: 0, s: 4, t: 'MESSAGE_CREATE', d: { id: 'a2', guild_id: 'g1', channel_id: '111111111111111111', author: { id: '8', username: 'bart' }, content: 'random chatter', mentions: [] } });
ws.in({ op: 0, s: 5, t: 'MESSAGE_CREATE', d: { id: 'a3', guild_id: 'g1', channel_id: '111111111111111111', author: { id: '8', username: 'bart' }, content: '<@900> is Ken coming?', mentions: [{ id: '900' }] } });
ws.in({ op: 0, s: 6, t: 'MESSAGE_CREATE', d: { id: 'a4', channel_id: 'dm-9', author: { id: '9', username: 'spam', bot: true }, content: 'buy now' } });
let n = d.news();
assert.deepEqual(n.map((i) => [i.id, i.title]), [['discord:a1', 'Ola on Discord'], ['discord:a3', 'bart on Discord']]);
assert.match(n[0].outcome, /^Ola wrote in a DM to the bot: "ask Ken if he is free tonight" \(reply with discord_send to @ola, once Ken says what to say\)$/);
assert.match(n[1].outcome, /wrote in #general \(Crew\): "<@900> is Ken coming\?" \(reply with discord_send to Crew\/#general/);
d.markTold(['discord:a3']);
assert.deepEqual(d.news().map((i) => i.id), ['discord:a1']);

// Sending: checked, the exact text OK'd first, to a channel or a friend (a DM); nobody pinged in bulk.
assert.equal(await tool('discord_send').execute({ to: '@ola', text: 'Yes, free after 7!' }), 'Sent to @Ola (DM).');
assert.equal(asked[0], 'Send to @Ola (DM) on Discord: "Yes, free after 7!"?');
assert.deepEqual(sent[0], ['/channels/dm-7/messages', { content: 'Yes, free after 7!', allowed_mentions: { parse: ['users'] } }]);
assert.deepEqual(d.news(), [], 'answered: no longer news');
await tool('discord_send').execute({ to: '@tomek', text: 'hi' });
assert.ok(calls.some(([m, r]) => m === 'POST' && r === '/users/@me/channels'), 'a DM opened with someone found in the server');
assert.equal(sent.at(-1)[0], '/channels/dm-555/messages');
answer = 'no';
await assert.rejects(tool('discord_send').execute({ to: '#general', text: 'hello' }), /Ken said no, so nothing was sent/);
answer = 'Send';
const before = sent.length;
await assert.rejects(tool('discord_send').execute({ to: '#general', text: '@everyone party' }), /No @everyone/);
await assert.rejects(tool('discord_send').execute({ to: '@nobody', text: 'hi' }), /I don't know @nobody yet/);
assert.equal(sent.length, before, 'nothing went out');
// A voice call: the one Ken is in, through this connection's voice adapter; leave hangs up.
await assert.rejects(tool('discord_call').execute({}), /Ken isn't in a voice channel the bot can see/);
ws.in({ op: 0, s: 7, t: 'GUILD_CREATE', d: { id: 'g1', name: 'Crew', channels: [{ id: '111111111111111111', name: 'general', type: 0 }, { id: '666666666666666666', name: 'Hang out', type: 2 }], voice_states: [{ user_id: '42', channel_id: '666666666666666666' }] } });
assert.match(await tool('discord_list').execute({}), /- Crew: #general; voice: Hang out$/m);
assert.equal(await tool('discord_call').execute({}), "Joined Hang out in Crew. I answer when someone says my name; Ken's requests can use my tools, friends just chat.");
const j = joined[0];
assert.deepEqual([j.guildId, j.channelId, j.botId, j.ownerId], ['g1', '666666666666666666', '900', '42'], 'Ken is the app\'s owner');
assert.equal(j.answer, callDeps.answer);
assert.match(d.liveText(), /In the voice call in Hang out in Crew now/);
// The voice library's adapter: its payloads go out on the gateway, and the bot's voice events come back to it.
const got = [];
const ad = j.adapterCreator({ onVoiceStateUpdate: (x) => got.push(['state', x.session_id]), onVoiceServerUpdate: (x) => got.push(['server', x.endpoint]), destroy: () => {} });
assert.equal(ad.sendPayload({ op: 4, d: { guild_id: 'g1', channel_id: '666666666666666666' } }), true);
assert.deepEqual(ws.out.at(-1), { op: 4, d: { guild_id: 'g1', channel_id: '666666666666666666' } });
ws.in({ op: 0, s: 8, t: 'VOICE_STATE_UPDATE', d: { guild_id: 'g1', user_id: '7', channel_id: '666666666666666666', session_id: 'not-mine' } });
ws.in({ op: 0, s: 9, t: 'VOICE_STATE_UPDATE', d: { guild_id: 'g1', user_id: '900', channel_id: '666666666666666666', session_id: 'sess' } });
ws.in({ op: 0, s: 10, t: 'VOICE_SERVER_UPDATE', d: { guild_id: 'g1', token: 't', endpoint: 'voice.example' } });
assert.deepEqual(got, [['state', 'sess'], ['server', 'voice.example']], 'only the bot\'s own voice state');
assert.equal(await tool('discord_call').execute({ channel: 'Crew/Hang out' }), 'Already in Hang out in Crew.');
await assert.rejects(tool('discord_call').execute({ channel: 'Crew/general' }), /^Error: No voice channel general in Crew that the bot can see\. discord_list shows the voice channels\.$/);
assert.equal(await tool('discord_call').execute({ leave: true }), 'Left the call.');
assert.ok(j.left);
assert.match(await tool('discord_read').execute({ to: '#general' }), /^#general in Crew, oldest first:\n\[2026-11-13 18:30\] ola: first\n\[2026-11-13 18:31\] ola: second$/);

// Message Content off in the bot's settings (4014): it reconnects without it (DMs and mentions still have words).
ws.onclose({ code: 4014 });
await new Promise((r) => setTimeout(r, 20));
const ws2 = sockets.at(-1);
assert.notEqual(ws2, ws);
ws2.in({ op: 10, d: { heartbeat_interval: 1e9 } });
assert.equal(ws2.out[0].d.intents, INTENTS & ~(1 << 15));
// A refused token (4004) stops trying; off forgets it.
ws2.onclose({ code: 4004 });
await new Promise((r) => setTimeout(r, 20));
assert.equal(sockets.at(-1), ws2, 'no retry with a bad token');
assert.equal(d.liveText(), 'Discord: not connected, the bot token was refused; discord_setup with a new token fixes it.');
assert.match(await tool('discord_setup').execute({ off: true }), /disconnected and its token is gone/);
assert.equal(saved, null);
// A wrong token: Discord's answer, and nothing saved.
const bad = createDiscord({ getToken: async () => null, saveToken: async (t) => { saved = t; }, removeToken: async () => {}, askToken: async () => `XXX.${'b'.repeat(60)}`, confirm: async () => true, checkMessage: checkDiscordMessage, fetch: async (u, o) => ({ status: 401, ok: false, json: async () => ({}) }), WebSocket: FakeSocket });
await assert.rejects(bad.tools[0].execute({}), /token is wrong or was reset/);
await assert.rejects(createDiscord({ askToken: async () => 'nope', getToken: async () => null }).tools[0].execute({}), /doesn't look like a bot token/);
assert.equal(saved, null);
console.log('discord tests: passed');

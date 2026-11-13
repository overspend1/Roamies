// Discord voice calls (discordvoice.mjs), through a stand-in voice library. Run: npm test
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Transform } from 'node:stream';
import { addressed, joinCall, toCallAudio, toWav16k } from '../discordvoice.mjs';

// Audio: 48 kHz stereo → 16 kHz mono WAV for speech to text; mono → stereo for Discord.
const stereo = Buffer.alloc(6 * 4);
for (let i = 0; i < 6; i++) { stereo.writeInt16LE(300, i * 4); stereo.writeInt16LE(100, i * 4 + 2); }
const wav = toWav16k(stereo);
assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
assert.equal(wav.readUInt32LE(24), 16000, '16 kHz');
assert.equal(wav.readUInt16LE(22), 1, 'mono');
assert.equal(wav.readUInt32LE(40), 4, 'two samples from six frames');
assert.equal(wav.readInt16LE(44), 200, 'the average of both channels');
const samples = (b) => Array.from({ length: b.length / 2 }, (_, i) => b.readInt16LE(i * 2));
const up = toCallAudio(), m1 = Buffer.alloc(4), m2 = Buffer.alloc(2);
m1.writeInt16LE(100, 0); m1.writeInt16LE(-100, 2); m2.writeInt16LE(300, 0);
assert.deepEqual(samples(up(new Uint8Array(m1))), [100, 100, 100, 100, 0, 0, -100, -100], 'twice the rate, both channels, halfway samples between');
assert.deepEqual(samples(up(new Uint8Array(m2))), [100, 100, 300, 300], 'carried across chunks: no click at the edge');
// Said to it: its name as a word, any case, also with an s.
for (const t of ['Roamie, what time is it?', 'hey roamies can you', 'ok ROAMIE', 'Hey everyone, Romy here.', 'Romi, która godzina?', 'Słuchaj Rołmi']) assert.ok(addressed(t, ['Roamie']), t);
for (const t of ['roaming charges', 'we talked about it', '']) assert.ok(!addressed(t, ['Roamie']), t);
assert.ok(addressed('Jarvis, play it', ['Roamie', 'Jarvis']));

// ---- a stand-in voice library ----
const speaking = new EventEmitter(), streams = new Map(), played = [];
let destroyed = false, stops = 0;
const lib = {
  VoiceConnectionStatus: { Ready: 'ready' }, AudioPlayerStatus: { Idle: 'idle' }, EndBehaviorType: { AfterSilence: 1 }, StreamType: { Raw: 'raw' },
  joinVoiceChannel: (o) => { lib.joined = o; return { receiver: { speaking, subscribe: (id) => streams.get(id) }, subscribe: () => {}, destroy: () => { destroyed = true; } }; },
  entersState: async () => {},
  createAudioPlayer: () => ({ play: (r) => played.push(r), stop: () => { stops++; } }),
  createAudioResource: (stream, o) => { assert.equal(o.inputType, 'raw', 'raw PCM in'); const chunks = []; stream.on('data', (c) => chunks.push(c)); return { chunks }; },
};
// The "decoder" passes PCM straight through, so the test's opus stream is PCM.
const prism = { opus: { Decoder: class extends Transform { _transform(c, e, cb) { cb(null, c); } } } };
const heardWavs = [], asked = [];
let transcript = '', reply = () => 'About 384,000 km.', hold = null;
// openVoice: each sentence said becomes two samples of "audio" (its length, then 0).
const openVoice = (onPcm) => ({ say: (t) => { const b = Buffer.alloc(4); b.writeInt16LE(t.length * 2, 0); onPcm(new Uint8Array(b)); }, end: async () => {}, abort: () => {} });
let T = 0;
const call = await joinCall({
  guildId: 'g1', channelId: 'c1', adapterCreator: () => {}, botId: 'bot', isOwner: (id) => id === 'ken', nameOf: async (id) => ({ ken: 'Ken', ola: 'Ola', bart: 'Bart' })[id] ?? 'someone',
  names: () => ['Roamie'], transcribe: async (w) => { heardWavs.push(w); return transcript; }, openVoice,
  respond: async (q) => { asked.push(q); if (hold) await hold; const r = reply(q); if (!r) { q.voice.abort(); return ''; } for (const sent of r.split('|')) q.voice.say(sent); await q.voice.end(); return r.replace(/\|/g, ' '); },
  lib, prism, now: () => T,
});
assert.deepEqual([lib.joined.guildId, lib.joined.channelId, lib.joined.selfDeaf], ['g1', 'c1', false], 'it joins able to hear');
const talk = async (id, seconds, words) => {
  transcript = words;
  const st = new PassThrough(); streams.set(id, st);
  speaking.emit('start', id);
  st.end(Buffer.alloc(Math.round(seconds * 48000) * 4));
  await new Promise((r) => setTimeout(r, 30));
  await call.idle();
};
// Said to it by name: it answers, sentence by sentence as each is ready, in the call.
await talk('ola', 1, 'Roamie, how far is the moon?');
assert.deepEqual(asked.map((a) => [a.who, a.owner, a.addressed, a.text]), [['Ola', false, true, 'Roamie, how far is the moon?']]);
assert.equal(played.length, 1, 'one reply, played once it has audio');
assert.deepEqual(call.heard, ['Ola: Roamie, how far is the moon?', 'You: About 384,000 km.']);
// In the conversation (45 s after it spoke): anything said goes to it, not named, and it may stay quiet.
reply = (q) => (/sun/.test(q.text) ? '150 million km.|Give or take.' : '');
T = 20_000; await talk('bart', 1, 'and the sun?');
assert.deepEqual([asked.at(-1).who, asked.at(-1).addressed], ['Bart', false]);
assert.deepEqual(samples(Buffer.concat(played.at(-1).chunks)).filter((_, i) => i % 4 === 2), [30, 0, 26, 0], 'both sentences in order, as each was said ("150 million km." then "Give or take.")');
T = 40_000; await talk('ola', 1, 'anyway, pizza tonight?');
assert.equal(asked.length, 3, 'heard in the conversation');
assert.equal(call.heard.at(-1), 'Ola: anyway, pizza tonight?', 'it stayed quiet: no line of its own');
// Long after, without its name: just part of the call, not for it.
T = 200_000; await talk('ken', 1, 'pizza sounds good');
assert.equal(asked.length, 3);
assert.equal(call.heard.at(-1), 'Ken: pizza sounds good', 'still heard, as context');
// Ken asks: his request is the owner's; the call so far rides along.
reply = () => 'Opening them.';
T = 210_000; await talk('ken', 1, 'Romy, open my notes');
assert.deepEqual([asked.at(-1).who, asked.at(-1).owner, asked.at(-1).addressed], ['Ken', true, true]);
assert.match(asked.at(-1).transcript, /Ken: pizza sounds good\nKen: Romy, open my notes$/);
// "Stop" while it talks: it stops at once.
let release; hold = new Promise((r) => { release = r; });
reply = () => 'A very long story|that goes on';
T = 220_000;
transcript = 'Roamie, tell me a story';
{ const st = new PassThrough(); streams.set('ola', st); speaking.emit('start', 'ola'); st.end(Buffer.alloc(48000 * 4)); }
await new Promise((r) => setTimeout(r, 30));
const playedBefore = played.length;
transcript = 'Roamie stop';
{ const st = new PassThrough(); streams.set('bart', st); speaking.emit('start', 'bart'); st.end(Buffer.alloc(48000 * 4)); }
await new Promise((r) => setTimeout(r, 30));
hold = null; release();
await call.idle();
assert.equal(asked.at(-1).text, 'Roamie, tell me a story', '"stop" is no question for it');
assert.equal(played.length, playedBefore, 'the story never played');
assert.ok(!call.heard.some((l) => l.startsWith('You: A very long story')), 'what it was told to stop isn\'t counted as said');
assert.equal(call.heard.at(-1), 'Bart: Roamie stop');
// Too short to be words, and the bot's own voice, are never sent off to be transcribed.
const n = heardWavs.length;
await talk('ola', 0.2, 'x');
await talk('bot', 2, 'x');
assert.equal(heardWavs.length, n);
call.leave();
assert.ok(destroyed);
console.log('discord voice tests: passed');

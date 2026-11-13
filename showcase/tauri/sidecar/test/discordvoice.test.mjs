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
for (const t of ['Roamie, what time is it?', 'hey roamies can you', 'ok ROAMIE', 'Hey everyone, Romy here.']) assert.ok(addressed(t, ['Roamie']), t);
for (const t of ['roaming charges', 'we talked about it', '']) assert.ok(!addressed(t, ['Roamie']), t);
assert.ok(addressed('Jarvis, play it', ['Roamie', 'Jarvis']));

// ---- a stand-in voice library ----
const speaking = new EventEmitter(), streams = new Map(), played = [];
let destroyed = false;
const lib = {
  VoiceConnectionStatus: { Ready: 'ready' }, AudioPlayerStatus: { Idle: 'idle' }, EndBehaviorType: { AfterSilence: 1 }, StreamType: { Raw: 'raw' },
  joinVoiceChannel: (o) => { lib.joined = o; return { receiver: { speaking, subscribe: (id) => streams.get(id) }, subscribe: () => {}, destroy: () => { destroyed = true; } }; },
  entersState: async () => {},
  createAudioPlayer: () => ({ play: (r) => played.push(r), stop: () => {} }),
  createAudioResource: (stream, o) => { assert.equal(o.inputType, 'raw', 'raw PCM in'); const chunks = []; stream.on('data', (c) => chunks.push(c)); return { chunks }; },
};
// The "decoder" passes PCM straight through, so the test's opus stream is PCM.
const prism = { opus: { Decoder: class extends Transform { _transform(c, e, cb) { cb(null, c); } } } };
const heardWavs = [], answers = [];
let transcript = 'Roamie, how far is the moon?';
const call = await joinCall({
  guildId: 'g1', channelId: 'c1', adapterCreator: () => {}, botId: 'bot', ownerId: 'ken', nameOf: async (id) => ({ ken: 'Ken', ola: 'Ola' })[id] ?? 'someone',
  names: () => ['Roamie'], transcribe: async (w) => { heardWavs.push(w); return transcript; },
  synth: async (text, onPcm) => { onPcm(new Uint8Array(Buffer.from([2, 0, 4, 0]))); },
  answer: async (q) => { answers.push(q); return q.owner ? 'Done, Ken.' : 'About 384,000 km.'; },
  lib, prism, now: () => T,
});
let T = 0;
assert.deepEqual([lib.joined.guildId, lib.joined.channelId, lib.joined.selfDeaf], ['g1', 'c1', false], 'it joins able to hear');
const talk = async (id, seconds) => {
  const s = new PassThrough(); streams.set(id, s);
  speaking.emit('start', id);
  s.end(Buffer.alloc(Math.round(seconds * 48000) * 4));
  await new Promise((r) => setTimeout(r, 30));
};
// A friend says its name: a chat answer, spoken in the call.
await talk('ola', 1);
assert.equal(heardWavs.length, 1);
assert.deepEqual(answers.map((a) => [a.who, a.owner, a.text]), [['Ola', false, 'Roamie, how far is the moon?']]);
assert.equal(played.length, 1);
assert.deepEqual(samples(Buffer.concat(played[0].chunks)), [2, 2, 2, 2, 3, 3, 4, 4], 'its voice, at 48 kHz stereo');
assert.deepEqual(call.heard, ['Ola: Roamie, how far is the moon?', 'You: About 384,000 km.']);
// The same friend goes on right after: still for it. Someone else talking among themselves: not.
transcript = 'and the sun?';
T = 5000; await talk('ola', 1);
assert.equal(answers.length, 2, 'a follow-up from the same person');
transcript = 'anyway, pizza tonight?';
T = 6000; await talk('ken', 1);
assert.equal(answers.length, 2, 'not said to it');
// Ken asks: his request is the one that gets the tools (owner); the call so far rides along.
transcript = 'Roamie, open my notes';
T = 30_000; await talk('ken', 1);
assert.deepEqual([answers.at(-1).who, answers.at(-1).owner], ['Ken', true]);
assert.match(answers.at(-1).transcript, /Ken: anyway, pizza tonight\?\nKen: Roamie, open my notes$/);
// Too short to be words, and the bot's own voice, are never sent off to be transcribed.
const n = heardWavs.length;
await talk('ola', 0.2);
await talk('bot', 2);
assert.equal(heardWavs.length, n);
call.leave();
assert.ok(destroyed);
console.log('discord voice tests: passed');

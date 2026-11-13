// Roamies in a Discord voice call, through the user's bot: it hears each person on their own (Discord sends every
// speaker's audio apart), turns what they said into text with Fish Audio, and answers out loud, in its Fish voice,
// when someone says its name (or the same person goes on right after its answer). Who may make it do things is
// decided by whoever answers (sidekick.mjs): only the user gets their computer; friends get a chat.
// The voice library (@discordjs/voice, with DAVE end-to-end encryption and an Opus codec) loads only when a call
// starts. Pure pieces first (tested in test/discordvoice.test.mjs), then joinCall.
import { PassThrough } from 'node:stream';

export const CALL_RATE = 48_000; // Discord's audio: 48 kHz, 2 channels, 16-bit
export const VOICE_RATE = 24_000; // what Fish makes for a call (it has no 48 kHz), doubled on the way in
const MIN_SECONDS = 0.5, MAX_SECONDS = 30, FOLLOW_MS = 10_000;

/** 48 kHz stereo 16-bit PCM → a 16 kHz mono WAV (what speech to text wants), each sample the average of 3×2. */
export function toWav16k(pcm) {
  const frames = Math.floor(pcm.length / 4), n = Math.floor(frames / 3), out = Buffer.alloc(44 + n * 2);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let k = 0; k < 3; k++) { const o = (i * 3 + k) * 4; sum += pcm.readInt16LE(o) + pcm.readInt16LE(o + 2); }
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(sum / 6))), 44 + i * 2);
  }
  out.write('RIFF', 0); out.writeUInt32LE(36 + n * 2, 4); out.write('WAVE', 8); out.write('fmt ', 12);
  out.writeUInt32LE(16, 16); out.writeUInt16LE(1, 20); out.writeUInt16LE(1, 22); out.writeUInt32LE(16_000, 24);
  out.writeUInt32LE(32_000, 28); out.writeUInt16LE(2, 32); out.writeUInt16LE(16, 34); out.write('data', 36); out.writeUInt32LE(n * 2, 40);
  return out;
}
/** 24 kHz mono 16-bit PCM, chunk by chunk → 48 kHz stereo for Discord: a sample halfway between each two (the last
 *  one of a chunk carried to the next, so chunk edges don't click), both channels the same. */
export function toCallAudio() {
  let prev = null;
  return (pcm) => {
    const b = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength - (pcm.byteLength % 2)), n = b.length / 2, out = Buffer.alloc(n * 8);
    for (let i = 0; i < n; i++) {
      const s = b.readInt16LE(i * 2), mid = prev == null ? s : Math.round((prev + s) / 2), o = i * 8;
      out.writeInt16LE(mid, o); out.writeInt16LE(mid, o + 2); out.writeInt16LE(s, o + 4); out.writeInt16LE(s, o + 6);
      prev = s;
    }
    return out;
  };
}
// How speech recognition writes "Roamie" when it doesn't know the word (Apple's: "Romy").
export const SOUNDS_LIKE = { roamie: ['romy', 'roamy', 'romie', 'romi', 'roami', 'roomie', 'romey'] };
/** Was it said to Roamies: one of its names (or how recognition spells it) as a word ("Roamie, what's…", "hey roamies"). */
export const addressed = (text, names) => names.flatMap((n) => [n, ...(SOUNDS_LIKE[String(n).toLowerCase()] ?? [])])
  .some((n) => n && new RegExp(`(^|[^\\p{L}])${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}s?($|[^\\p{L}])`, 'iu').test(String(text)));

/**
 * Joins a voice channel. deps: guildId, channelId, adapterCreator (discord.mjs), botId, ownerId, nameOf(userId),
 * names() (what it answers to), transcribe(wav) → text, synth(text, onPcm) → done (VOICE_RATE mono), answer({ text,
 * who, owner, transcript }) → reply text or '', log, lib/prism (stand-ins in tests). → { leave, say, heard }
 */
export async function joinCall({ guildId, channelId, adapterCreator, botId, ownerId, nameOf, names, transcribe, synth, answer, log = () => {}, lib = null, prism = null, now = () => Date.now() }) {
  const v = lib ?? await import('@discordjs/voice');
  const P = prism ?? (await import('prism-media')).default;
  const conn = v.joinVoiceChannel({ guildId, channelId, adapterCreator, selfDeaf: false, selfMute: false });
  try { await v.entersState(conn, v.VoiceConnectionStatus.Ready, 20_000); }
  catch (e) { conn.destroy(); throw new Error(`Couldn't join the voice channel: ${e.message}. The bot needs the Connect and Speak permissions there.`); }
  const player = v.createAudioPlayer();
  conn.subscribe(player);
  const heard = []; // the call so far, "Name: words"
  const listening = new Set();
  let speaking = Promise.resolve(), last = { who: null, at: 0 };
  const note = (line) => { heard.push(line); if (heard.length > 40) heard.splice(0, heard.length - 40); };

  async function hear(userId) {
    const opus = conn.receiver.subscribe(userId, { end: { behavior: v.EndBehaviorType.AfterSilence, duration: 900 } });
    const dec = new P.opus.Decoder({ rate: CALL_RATE, channels: 2, frameSize: 960 });
    const chunks = [];
    let bytes = 0;
    await new Promise((done) => {
      opus.on('error', done); dec.on('error', done); dec.on('end', done); dec.on('close', done);
      dec.on('data', (c) => { if (bytes < MAX_SECONDS * CALL_RATE * 4) { chunks.push(c); bytes += c.length; } });
      opus.pipe(dec);
    });
    if (bytes < MIN_SECONDS * CALL_RATE * 4) return; // a cough, a click
    const text = (await transcribe(toWav16k(Buffer.concat(chunks))).catch((e) => { log('call_hear', { error: String(e.message).slice(0, 160) }); return ''; })).trim();
    if (!text) return;
    const who = await nameOf(userId);
    note(`${who}: ${text}`);
    // Said to it, or the same person going on right after its answer.
    const followUp = last.who === userId && now() - last.at < FOLLOW_MS;
    if (!addressed(text, names()) && !followUp) return;
    const reply = String(await answer({ text, who, owner: userId === ownerId, transcript: heard.slice(-20).join('\n') }).catch((e) => { log('call_answer', { error: String(e.message).slice(0, 160) }); return ''; }) ?? '').trim();
    if (reply) { await say(reply); last = { who: userId, at: now() }; }
  }
  conn.receiver.speaking.on('start', (userId) => {
    if (userId === botId || listening.has(userId)) return;
    listening.add(userId);
    hear(userId).catch((e) => log('call_hear', { error: String(e.message).slice(0, 160) })).finally(() => listening.delete(userId));
  });

  /** Says it in the call (one at a time), its audio streamed in as Fish makes it. */
  function say(text) {
    speaking = speaking.then(async () => {
      const out = new PassThrough(), up = toCallAudio();
      player.play(v.createAudioResource(out, { inputType: v.StreamType.Raw }));
      try { await synth(text, (pcm) => out.write(up(pcm))); } finally { out.end(); }
      await v.entersState(player, v.AudioPlayerStatus.Idle, 120_000).catch(() => {});
      note(`You: ${text}`);
    }).catch((e) => log('call_say', { error: String(e.message).slice(0, 160) }));
    return speaking;
  }
  return { leave: () => { player.stop(true); conn.destroy(); }, say, heard, channelId, guildId };
}

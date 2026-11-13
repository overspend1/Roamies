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

/** "Stop", "be quiet"… said to it while it talks: it stops. */
export const STOP = /\b(stop|shut up|be quiet|quiet|enough|cancel|nevermind|never mind)\b/i;
export const ENGAGED_MS = 45_000;

/**
 * Joins a voice channel. deps: guildId, channelId, adapterCreator (discord.mjs), botId, isOwner(userId), nameOf(userId),
 * names() (what it answers to), transcribe(wav) → text, openVoice(onPcm) → { say(sentence), end() → done, abort() }
 * (VOICE_RATE mono), respond({ text, who, userId, owner, addressed, transcript, voice }) → what it said, '' when it
 * stayed quiet (it says each sentence on voice as it's ready, then ends it; or aborts it), log, lib/prism (stand-ins in
 * tests). → { leave, heard }
 * It answers what's said to it by name, and while it's in a conversation (ENGAGED_MS after it was named or spoke)
 * whatever else is said, which it may pass on. One reply at a time; hearing goes on meanwhile.
 */
export async function joinCall({ guildId, channelId, adapterCreator, botId, isOwner = () => false, nameOf, names, transcribe, openVoice, respond, log = () => {}, lib = null, prism = null, now = () => Date.now(), silenceMs = 700 }) {
  const v = lib ?? await import('@discordjs/voice');
  const P = prism ?? (await import('prism-media')).default;
  const conn = v.joinVoiceChannel({ guildId, channelId, adapterCreator, selfDeaf: false, selfMute: false });
  try { await v.entersState(conn, v.VoiceConnectionStatus.Ready, 20_000); }
  catch (e) { conn.destroy(); throw new Error(`Couldn't join the voice channel: ${e.message}. The bot needs the Connect and Speak permissions there.`); }
  const player = v.createAudioPlayer();
  conn.subscribe(player);
  const heard = []; // the call so far, "Name: words"
  const listening = new Set();
  let turns = Promise.resolve(), engagedUntil = 0, current = null;
  const note = (line) => { heard.push(line); if (heard.length > 60) heard.splice(0, heard.length - 60); };

  // One reply's voice: audio goes to the call as Fish makes it.
  function speaker() {
    const out = new PassThrough(), up = toCallAudio();
    let playing = false, stopped = false;
    const voice = openVoice((pcm) => {
      if (stopped) return;
      if (!playing) { playing = true; player.play(v.createAudioResource(out, { inputType: v.StreamType.Raw })); }
      out.write(up(pcm));
    });
    return {
      say: (t) => { if (!stopped) voice.say(t); },
      end: async () => { try { await voice.end(); } finally { out.end(); } if (playing && !stopped) await v.entersState(player, v.AudioPlayerStatus.Idle, 120_000).catch(() => {}); },
      abort: () => { stopped = true; voice.abort(); out.end(); if (playing) player.stop(true); },
      get stopped() { return stopped; },
    };
  }

  async function hear(userId) {
    const opus = conn.receiver.subscribe(userId, { end: { behavior: v.EndBehaviorType.AfterSilence, duration: silenceMs } });
    const dec = new P.opus.Decoder({ rate: CALL_RATE, channels: 2, frameSize: 960 });
    const chunks = [];
    let bytes = 0;
    await new Promise((done) => {
      opus.on('error', done); dec.on('error', done); dec.on('end', done); dec.on('close', done);
      dec.on('data', (c) => { if (bytes < MAX_SECONDS * CALL_RATE * 4) { chunks.push(c); bytes += c.length; } });
      opus.pipe(dec);
    });
    if (bytes < MIN_SECONDS * CALL_RATE * 4) return; // a cough, a click
    const at = now();
    const text = (await transcribe(toWav16k(Buffer.concat(chunks))).catch((e) => { log('call_hear', { error: String(e.message).slice(0, 160) }); return ''; })).trim();
    if (!text) return;
    const who = await nameOf(userId), owner = isOwner(userId), named = addressed(text, names()), engaged = now() < engagedUntil;
    note(`${who}: ${text}`);
    // Told to stop while it talks.
    if (current && (named || engaged) && STOP.test(text) && text.split(/\s+/).length <= 6) { current.abort(); current = null; engagedUntil = now() + ENGAGED_MS; return; }
    if (!named && !engaged) return;
    if (named) engagedUntil = now() + ENGAGED_MS;
    turns = turns.then(async () => {
      // Waited too long behind other replies: only what was said to it by name still gets one.
      if (!named && now() - at > 15_000) return;
      const voice = current = speaker();
      let said = '';
      try { said = String(await respond({ text, who, userId, owner, addressed: named, transcript: heard.slice(-25).join('\n'), voice }) ?? ''); }
      catch (e) { log('call_answer', { error: String(e.message).slice(0, 160) }); voice.abort(); }
      if (current === voice) current = null;
      if (voice.stopped) said = ''; // told to stop: it wasn't said
      if (said) { note(`You: ${said}`); engagedUntil = now() + ENGAGED_MS; }
    });
  }
  conn.receiver.speaking.on('start', (userId) => {
    if (userId === botId || listening.has(userId)) return;
    listening.add(userId);
    hear(userId).catch((e) => log('call_hear', { error: String(e.message).slice(0, 160) })).finally(() => listening.delete(userId));
  });
  return { leave: () => { current?.abort(); player.stop(true); conn.destroy(); }, heard, note, channelId, guildId, idle: () => turns };
}

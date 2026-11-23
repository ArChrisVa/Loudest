// Writes out what is said in a video, on this PC.
//
// The work is done by whisper.cpp, a free speech-to-text program that sits in
// tools\whisper. It needs a speech model: one large file that is downloaded
// the first time a transcript is asked for, and kept in the app's data folder.
//
//   1. Only the stretches where someone speaks are written out. Which those
//      are is known from the listening that finds the moments. Silence and
//      game sound would only cost time, and make whisper invent words.
//   2. The speech goes to whisper half an hour at a time: ffmpeg reads the
//      sound, the stretches without speech are dropped, and the rest is
//      saved as one sound file. Whisper prints what it hears in it line by
//      line, each with its time, which is then turned back into a time in
//      the video.

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { probeVideo } = require('./analysis');
const { download } = require('./download');
const paths = require('./paths');

// "large-v3-turbo", made smaller (q5_0). The small models get about one
// Greek word in three wrong; this one about one in nine.
const MODEL = 'ggml-large-v3-turbo-q5_0.bin';
const MODEL_ADDRESS = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/' + MODEL;
const MODEL_BYTES = 574041195;

const FRAME_SECONDS = 0.48; // what was heard has one entry per this much video
const LONGEST_PIECE = 30 * 60; // seconds of speech given to whisper at a time
const RATE = 16000; // samples per second, which is what whisper wants
const BREATH = 0.3; // seconds of silence put between two stretches, so their words do not run together

let running = null; // the ffmpeg or whisper that is at work
let stopped = false;
let stopDownload = () => {};

// True when the speech-to-text program came with the app.
function canTranscribe() {
  return fs.existsSync(paths.whisper);
}

// Stops the writing out that is in progress, if there is one.
function cancelTranscribe() {
  stopped = true;
  stopDownload();
  if (running) running.kill();
}

function friendly(text) {
  return Object.assign(new Error(text), { friendly: text });
}

// The stretches of the video with speech in them: [{ start, end }] in
// seconds, none longer than half an hour. Stretches of ten seconds or more
// without speech are left out. Without `heard` (the video has not been
// listened to) it is simply the whole video in half-hour pieces.
function findSpeech(heard, duration) {
  const pieces = [];
  if (!heard?.speech?.length) {
    for (let start = 0; start < duration; start += LONGEST_PIECE) {
      pieces.push({ start, end: Math.min(duration, start + LONGEST_PIECE) });
    }
    return pieces;
  }

  const SPEAKING = 0.2; // how sure the listening must be that it is speech
  const LONG_GAP = Math.round(10 / FRAME_SECONDS);
  const MARGIN = 2; // frames kept on each side, so the first and last word are whole
  const LONGEST = Math.round(LONGEST_PIECE / FRAME_SECONDS);
  const LOOK_BACK = Math.round(60 / FRAME_SECONDS);
  const speech = heard.speech;
  const add = (from, to) => {
    const piece = { start: from * FRAME_SECONDS, end: Math.min(duration, to * FRAME_SECONDS) };
    if (piece.end - piece.start >= 1) pieces.push(piece);
  };

  // The stretches of speech, as frame numbers [from, to).
  const stretches = [];
  let start = -1; // where the current stretch began, or -1 between stretches
  let last = -1; // the last frame with speech in it
  for (let frame = 0; frame <= speech.length; frame++) {
    if (frame < speech.length && speech[frame] >= SPEAKING) {
      if (start === -1) start = frame;
      last = frame;
    } else if (start !== -1 && (frame === speech.length || frame - last >= LONG_GAP)) {
      stretches.push([Math.max(0, start - MARGIN), Math.min(speech.length, last + 1 + MARGIN)]);
      start = -1;
    }
  }

  for (let [from, to] of stretches) {
    // Too long for one piece: cut it at the quietest point of the last
    // minute that fits, which is most likely a pause between two sentences.
    while (to - from > LONGEST) {
      let pause = from + LONGEST;
      for (let frame = pause - LOOK_BACK; frame < from + LONGEST; frame++) {
        if (speech[frame] < speech[pause]) pause = frame;
      }
      add(from, pause);
      from = pause;
    }
    add(from, to);
  }
  return pieces;
}

// Puts the stretches into batches of at most half an hour of speech each.
function intoBatches(stretches) {
  const batches = [];
  let length = Infinity;
  for (const stretch of stretches) {
    const seconds = stretch.end - stretch.start;
    if (length + seconds > LONGEST_PIECE) {
      batches.push([]);
      length = 0;
    }
    batches.at(-1).push(stretch);
    length += seconds;
  }
  return batches;
}

// Starts a program and resolves with how it ended: { code, errorText }.
// While it runs it is the one that cancelTranscribe() stops. What it prints
// goes to `onData` as it comes, or to `onLine` one line of text at a time.
function run(program, args, { cwd, onData, onLine } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { cwd, windowsHide: true });
    running = child;
    try {
      // Leaves the PC free for the editor's own work: the video keeps playing smoothly.
      os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
    } catch {
      // It runs at normal priority, then.
    }

    let errorText = '';
    child.stderr.on('data', (chunk) => {
      errorText = (errorText + chunk).slice(-2000);
    });

    let unfinished = '';
    if (onData) {
      child.stdout.on('data', onData);
    } else {
      // Text can arrive cut in the middle of a line, or even of a Greek letter.
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (text) => {
        const lines = (unfinished + text).split(/\r?\n/);
        unfinished = lines.pop();
        for (const line of lines) onLine?.(line);
      });
    }

    child.on('error', reject);
    child.on('close', (code) => {
      if (running === child) running = null;
      if (unfinished) onLine?.(unfinished);
      if (stopped) reject(Object.assign(new Error('The writing out was cancelled'), { cancelled: true }));
      else resolve({ code, errorText });
    });
  });
}

// Saves the speech of one batch as `file`, a sound file whisper can read,
// with the stretches one after the other and a short silence between them.
// Resolves with where each stretch sits in that file: [{ at, start }], where
// `at` is its time in the file and `start` its time in the video.
async function saveSound(videoPath, batch, file) {
  const from = batch[0].start;
  // Each stretch as sample numbers, counted from where ffmpeg starts reading.
  const ranges = batch.map((stretch) => [Math.round((stretch.start - from) * RATE), Math.round((stretch.end - from) * RATE)]);
  const kept = []; // the sound to save, in pieces
  const places = [];
  let saved = 0; // samples kept so far
  let position = 0; // samples read so far
  let next = 0; // the stretch being filled
  let carry = Buffer.alloc(0); // a sample is two bytes, and can arrive split in two

  const result = await run(paths.ffmpeg, [
    '-hide_banner', '-nostdin', '-v', 'error',
    '-ss', String(from), '-t', String(batch.at(-1).end - from),
    '-i', videoPath,
    '-map', '0:a:0', '-ac', '1', '-ar', String(RATE),
    '-f', 's16le', // plain numbers: two bytes per sample
    'pipe:1',
  ], {
    onData(chunk) {
      const data = carry.length ? Buffer.concat([carry, chunk]) : chunk;
      const count = Math.floor(data.length / 2);
      carry = data.subarray(count * 2);

      // Keep the part of this chunk that lies inside each stretch.
      while (next < ranges.length && ranges[next][0] < position + count) {
        const [start, end] = ranges[next];
        const a = Math.max(start, position);
        const b = Math.min(end, position + count);
        if (b > a) {
          if (a === start) {
            if (saved > 0) {
              const silence = Math.round(BREATH * RATE);
              kept.push(Buffer.alloc(silence * 2));
              saved += silence;
            }
            places.push({ at: saved / RATE, start: batch[next].start });
          }
          kept.push(data.subarray((a - position) * 2, (b - position) * 2));
          saved += b - a;
        }
        if (end > position + count) break; // the rest of this stretch is in the next chunk
        next += 1;
      }
      position += count;
    },
  });
  if (result.code !== 0) throw new Error(result.errorText.trim() || 'ffmpeg could not read the sound');

  // The 44 bytes every WAV file starts with: what kind of sound follows, and how much.
  const bytes = saved * 2;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + bytes, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); // the length of this description
  header.writeUInt16LE(1, 20); // plain numbers, not compressed
  header.writeUInt16LE(1, 22); // one channel
  header.writeUInt32LE(RATE, 24);
  header.writeUInt32LE(RATE * 2, 28); // bytes per second
  header.writeUInt16LE(2, 32); // bytes per sample
  header.writeUInt16LE(16, 34); // bits per sample
  header.write('data', 36);
  header.writeUInt32LE(bytes, 40);
  fs.writeFileSync(file, Buffer.concat([header, ...kept]));
  return places;
}

// Writes out what is said in `videoPath`. Resolves with the lines:
// [[start, end, text], ...], times in seconds from the start of the video.
//   language     'el', 'en', or 'auto' to let whisper work it out
//   folder       where the speech model is kept
//   heard        what the listening heard in this video, or null
//   onProgress   called with ('model', fraction) while the model is being
//                downloaded, then with ('speech', fraction)
// Rejects with an error that has `cancelled` set if it was stopped, or
// `friendly` set to a sentence to show.
async function transcribe(videoPath, { language, folder, heard, onProgress }) {
  stopped = false;
  fs.mkdirSync(folder, { recursive: true });

  const model = path.join(folder, MODEL);
  if (!fs.existsSync(model)) {
    const controller = new AbortController();
    stopDownload = () => controller.abort();
    try {
      await download(MODEL_ADDRESS, model, { signal: controller.signal, onProgress: (fraction) => onProgress('model', fraction) });
    } catch (error) {
      if (controller.signal.aborted) throw Object.assign(error, { cancelled: true });
      console.error('Could not download the speech model:', error);
      throw friendly('The speech model could not be downloaded. Check the internet connection.');
    }
    // A file of the wrong size is not the model.
    if (fs.statSync(model).size !== MODEL_BYTES) {
      fs.rmSync(model, { force: true });
      throw friendly('The speech model did not arrive whole. Try again.');
    }
  }

  const { duration } = await probeVideo(videoPath);
  const stretches = findSpeech(heard, duration);
  const total = stretches.reduce((sum, stretch) => sum + (stretch.end - stretch.start), 0) || 1;
  // Whisper is given plain file names inside `folder`: it cannot open paths
  // with Greek letters in them, and a Windows user name may have some.
  const sound = 'speech.wav';
  const threads = Math.max(1, Math.floor(os.availableParallelism() / 2) - 1);
  const lines = [];
  let done = 0; // seconds of speech written out so far
  let useGraphicsCard = true;

  onProgress('speech', 0);
  try {
    for (const batch of intoBatches(stretches)) {
      const places = await saveSound(videoPath, batch, path.join(folder, sound));
      // Where a time in the sound file is in the video.
      const inVideo = (seconds) => {
        let place = places[0];
        for (const candidate of places) {
          if (candidate.at > seconds) break;
          place = candidate;
        }
        return Math.round((place.start + seconds - place.at) * 100) / 100;
      };

      // Whisper prints "[00:00:01.000 --> 00:00:04.500]  what was said".
      const heardHere = [];
      const onLine = (line) => {
        const found = /^\[(\d+):(\d+):(\d+\.\d+) --> (\d+):(\d+):(\d+\.\d+)\]\s*(.*)$/.exec(line);
        if (!found || places.length === 0) return;
        const from = Number(found[1]) * 3600 + Number(found[2]) * 60 + Number(found[3]);
        const to = Number(found[4]) * 3600 + Number(found[5]) * 60 + Number(found[6]);
        const text = found[7].trim();
        onProgress('speech', Math.min(1, (done + to) / total));
        // Not words: "[MUSIC]", "(laughs)", "♪".
        if (!text || /^[[(].*[\])]$/.test(text) || !/\p{L}/u.test(text)) return;
        heardHere.push([inVideo(from), inVideo(to), text]);
      };

      const ask = (extra) => run(paths.whisper, [
        '-m', MODEL, '-f', sound,
        '-l', language,
        '-t', String(threads),
        '-np', // print only what was said
        ...extra,
      ], { cwd: folder, onLine });

      let result = await ask(useGraphicsCard ? [] : ['-ng']);
      if (result.code !== 0 && useGraphicsCard) {
        // The graphics card or its driver could not do it: carry on with
        // the processor alone, which is slower but always works.
        console.error('Whisper failed on the graphics card:', result.errorText);
        useGraphicsCard = false;
        heardHere.length = 0;
        result = await ask(['-ng']);
      }
      if (result.code !== 0) throw new Error(result.errorText.trim() || 'whisper could not write out the speech');

      lines.push(...heardHere);
      done += batch.reduce((sum, stretch) => sum + (stretch.end - stretch.start), 0);
      onProgress('speech', Math.min(1, done / total));
    }
  } finally {
    fs.rmSync(path.join(folder, sound), { force: true });
  }
  return lines;
}

module.exports = { transcribe, cancelTranscribe, canTranscribe, findSpeech, intoBatches, saveSound };

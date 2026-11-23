// Listens to a video: says, about twice a second, how sure it is that it
// hears a laugh, a scream, a shout, speech or music, and how sharp and loud
// the sound is.
//
// ffmpeg reads only the sound and hands it over as plain numbers. A
// sound-recognition model (YAMNet) goes through it, run by a library called
// ONNX Runtime.
//
// This file runs in a helper process of its own, which main.js starts for one
// video and ends when that video is done (or when the listening is stopped).
// The reason is that library: when a program that has used it closes, it can
// wait for ever for its own helper threads, which Windows has already
// stopped. Inside the app that left an invisible Loudest behind after the
// window was closed. A helper process is simply ended instead, so the
// library never gets to tidy up, and the app itself never loads it.

const { spawn } = require('node:child_process');
const paths = require('./paths');

const ffmpegPath = paths.ffmpeg;

// YAMNet was trained on sound at 16000 samples per second. It looks at 0.96 s
// at a time and moves on 0.48 s for each answer.
const SAMPLE_RATE = 16000;
const FRAME_SECONDS = 0.48;
const FRAME_SAMPLES = 15360;
const STEP_SAMPLES = 7680;

// The sound goes to the model one minute at a time.
const FRAMES_PER_RUN = 125;
const RUN_SAMPLES = FRAME_SAMPLES + (FRAMES_PER_RUN - 1) * STEP_SAMPLES;
const ADVANCE_SAMPLES = FRAMES_PER_RUN * STEP_SAMPLES;

// YAMNet answers with 521 numbers per frame, one per kind of sound it knows.
// These are the positions of the ones used here (from its class list).
const CLASSES = 521;
const SPEECH = 0;
const SHOUTS = [6, 10]; // Shout, Bellow, Whoop, Yell, Children shouting
const SCREAM = 11; // Screaming
const LAUGHS = [13, 18]; // Laughter, Baby laughter, Giggle, Snicker, Belly laugh, Chuckle
const MUSIC = 132;

// For voice excitement the sound of each frame is also split into pitches
// (an FFT, 512 samples at a time, ten times per frame) to see how much of it
// sits high (1100 to 4100 Hz) compared with low (200 to 730 Hz). An excited
// voice is sharper: more of it sits high.
const FFT_SIZE = 512;
const FFT_STEP = 1600;
const LOW_BINS = [6, 23]; // 200 to 730 Hz; one bin is 31.25 Hz wide
const HIGH_BINS = [36, 133]; // 1100 to 4100 Hz
const ALL_BINS = [6, 205]; // 200 to 6400 Hz

const fftWindow = Float64Array.from({ length: FFT_SIZE }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FFT_SIZE));
const fftCos = Float64Array.from({ length: FFT_SIZE / 2 }, (_, i) => Math.cos((2 * Math.PI * i) / FFT_SIZE));
const fftSin = Float64Array.from({ length: FFT_SIZE / 2 }, (_, i) => Math.sin((2 * Math.PI * i) / FFT_SIZE));
const fftOrder = Uint16Array.from({ length: FFT_SIZE }, (_, i) => {
  let reversed = 0;
  for (let bit = 0; bit < 9; bit++) reversed |= ((i >> bit) & 1) << (8 - bit);
  return reversed;
});
const re = new Float64Array(FFT_SIZE);
const im = new Float64Array(FFT_SIZE);

// How sharp and how loud one frame of sound is, starting at `offset`.
// Both are on a logarithmic scale, so only differences between frames mean anything.
function voiceShape(sound, offset) {
  let low = 0;
  let high = 0;
  let all = 0;
  let windows = 0;

  for (let start = offset; start + FFT_SIZE <= Math.min(sound.length, offset + FRAME_SAMPLES); start += FFT_STEP) {
    // A standard FFT: afterwards re[k]² + im[k]² is the energy at pitch k.
    for (let i = 0; i < FFT_SIZE; i++) {
      re[fftOrder[i]] = sound[start + i] * fftWindow[i];
      im[fftOrder[i]] = 0;
    }
    for (let size = 2; size <= FFT_SIZE; size *= 2) {
      const half = size / 2;
      const stride = FFT_SIZE / size;
      for (let block = 0; block < FFT_SIZE; block += size) {
        for (let k = 0; k < half; k++) {
          const a = block + k;
          const b = a + half;
          const real = re[b] * fftCos[k * stride] + im[b] * fftSin[k * stride];
          const imaginary = im[b] * fftCos[k * stride] - re[b] * fftSin[k * stride];
          re[b] = re[a] - real;
          im[b] = im[a] - imaginary;
          re[a] += real;
          im[a] += imaginary;
        }
      }
    }
    low += Math.log10(energy(LOW_BINS) + 1e-9);
    high += Math.log10(energy(HIGH_BINS) + 1e-9);
    all += Math.log10(energy(ALL_BINS) + 1e-9);
    windows += 1;
  }

  if (windows === 0) return { sharp: 0, level: -9 };
  return { sharp: round((high - low) / windows), level: round(all / windows) };
}

function energy([from, to]) {
  let sum = 0;
  for (let bin = from; bin < to; bin++) sum += re[bin] * re[bin] + im[bin] * im[bin];
  return sum;
}

// Resolves with what was heard, one entry per 0.48 s of the video's first
// audio track: { laugh, scream, shout, music, speech } hold how sure the model is,
// between 0 (not at all) and 1 (certain); { sharp, level } describe the sound
// itself (see voiceShape).
// `onProgress` is called with the number of seconds listened to so far.
async function listen(videoPath, onProgress) {
  // Loaded here and not at the top of the file, so that a failure to load it
  // is reported to main.js like any other problem with the listening.
  const ort = require('onnxruntime-node');
  const model = await ort.InferenceSession.create(paths.soundModel);

  const child = spawn(
    ffmpegPath,
    [
      '-hide_banner', '-nostdin', '-v', 'error',
      '-i', videoPath,
      '-map', '0:a:0', // the first audio track; the picture is never decoded
      '-ac', '1', // mixed down to one channel
      '-ar', String(SAMPLE_RATE),
      '-f', 'f32le', // raw numbers: four bytes per sample, -1 to 1
      'pipe:1',
    ],
    { windowsHide: true },
  );

  let errorText = '';
  child.stderr.on('data', (chunk) => {
    if (errorText.length < 2000) errorText += chunk;
  });
  const ended = new Promise((resolve, reject) => {
    child.on('close', resolve);
    child.on('error', reject); // ffmpeg itself could not be started
  });
  // Looked at after the sound has been read; this stops Node from warning
  // about a failure nobody is watching yet.
  ended.catch(() => {});

  const heard = { laugh: [], scream: [], shout: [], music: [], speech: [], sharp: [], level: [] };
  let waiting = new Float32Array(RUN_SAMPLES * 2); // sound not yet given to the model
  let count = 0;
  let leftover = Buffer.alloc(0); // a sample can be split across two chunks
  let lastProgress = 0;

  // Gives the first `samples` waiting samples to the model and notes its answers.
  async function hear(samples, frames) {
    const sound = waiting.slice(0, samples);
    const result = await model.run({ waveform: new ort.Tensor('float32', sound, [samples]) }, ['output_0']);
    const scores = result.output_0.data;
    // The last piece of the video is shorter, so the model says how many frames it made.
    const made = frames ?? result.output_0.dims[0];
    for (let frame = 0; frame < made; frame++) {
      const row = frame * CLASSES;
      heard.laugh.push(highest(scores, row + LAUGHS[0], row + LAUGHS[1]));
      heard.scream.push(round(scores[row + SCREAM]));
      heard.shout.push(highest(scores, row + SHOUTS[0], row + SHOUTS[1]));
      heard.music.push(round(scores[row + MUSIC]));
      heard.speech.push(round(scores[row + SPEECH]));
      const shape = voiceShape(sound, frame * STEP_SAMPLES);
      heard.sharp.push(shape.sharp);
      heard.level.push(shape.level);
    }
  }

  let exitCode;
  try {
    // Reading with `for await` makes ffmpeg wait while the model is busy, so
    // the sound never piles up in memory.
    for await (const chunk of child.stdout) {
      const data = leftover.length ? Buffer.concat([leftover, chunk]) : chunk;
      const usable = data.length - (data.length % 4);
      const samples = new Float32Array(data.buffer.slice(data.byteOffset, data.byteOffset + usable));
      leftover = data.subarray(usable);

      if (count + samples.length > waiting.length) {
        const bigger = new Float32Array((count + samples.length) * 2);
        bigger.set(waiting.subarray(0, count));
        waiting = bigger;
      }
      waiting.set(samples, count);
      count += samples.length;

      while (count >= RUN_SAMPLES) {
        await hear(RUN_SAMPLES, FRAMES_PER_RUN);
        // Keep the end of this minute: the next frame starts inside it.
        waiting.copyWithin(0, ADVANCE_SAMPLES, count);
        count -= ADVANCE_SAMPLES;
      }

      const now = Date.now();
      if (now - lastProgress > 200) {
        lastProgress = now;
        onProgress(heard.laugh.length * FRAME_SECONDS);
      }
    }
    exitCode = await ended;
  } catch (error) {
    // Something went wrong on our side: do not leave ffmpeg running.
    child.kill();
    throw error;
  }

  if (exitCode !== 0) {
    throw new Error(errorText.trim() || 'ffmpeg could not read the sound');
  }

  if (count >= FRAME_SAMPLES) await hear(count);
  return heard;
}

// The highest of scores[from..to], rounded.
function highest(scores, from, to) {
  let best = 0;
  for (let i = from; i <= to; i++) {
    if (scores[i] > best) best = scores[i];
  }
  return round(best);
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}

// How main.js talks to this helper: it sends the path of a video, and gets
// back { seconds } as the listening goes on, then { heard } or { error }.
// (process.parentPort only exists in a helper process started by Electron.)
process.parentPort?.on('message', async ({ data: videoPath }) => {
  try {
    const heard = await listen(videoPath, (seconds) => process.parentPort.postMessage({ seconds }));
    process.parentPort.postMessage({ heard });
  } catch (error) {
    process.parentPort.postMessage({ error: error.message });
  }
});

module.exports = { listen };

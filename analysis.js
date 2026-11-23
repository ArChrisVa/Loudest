// Turns what was heard in a video into moments: where someone laughs,
// screams, shouts or raises their voice, and where nobody speaks at all.
// (The listening itself is in listen.js.)

const { spawn } = require('node:child_process');
const paths = require('./paths');

const ffmpegPath = paths.ffmpeg;

// What was heard has one entry for every 0.48 s of the video.
const FRAME_SECONDS = 0.48;

function round(value) {
  return Math.round(value * 1000) / 1000;
}

// Turns what was heard (and, if there is one, the chat) into moments.
//
// Three kinds of sign point at a moment: a reaction the model recognises
// (Laugh, Scream, Shout), a raised voice, and a spike in the chat. Signs
// within 15 seconds of each other are one moment, and a moment that several
// kinds of sign agree on ranks higher.
//
// `sensitivity` runs from 0 (only the clearest signs) to 1 (weak ones too);
// 0.5 is what was tuned by ear. `chatSpikes` comes from chat.js.
//
// Returns, strongest first, [{ time, until, kind, signs, strength }]:
//   time, until  where the moment starts and ends, in seconds
//   kind         its strongest sign; signs lists all of them, strongest first
//   strength     from 0 to 1, compared with the strongest moment
function findMoments(heard, { sensitivity = 0.5, chatSpikes = [] } = {}) {
  const NEAR = 15; // seconds

  // How much each sign counts, from its weakest to its strongest. Any
  // reaction the model recognises outranks a raised voice on its own, because
  // only about half of the raised voices are good.
  const signs = [
    ...weigh(findReactions(heard, sensitivity), 0.35, 1),
    ...weigh(chatSpikes, 0.25, 0.8),
    ...weigh(findRaisedVoices(heard, sensitivity), 0.1, 0.3),
  ].sort((a, b) => a.time - b.time);

  const moments = [];
  let current = null;
  for (const sign of signs) {
    if (current && sign.time - current.until <= NEAR) {
      current.signs.push(sign);
      current.until = Math.max(current.until, sign.until);
    } else {
      current = { time: sign.time, until: sign.until, signs: [sign] };
      moments.push(current);
    }
  }

  for (const moment of moments) {
    moment.signs.sort((a, b) => b.weight - a.weight);
    // Laugh, Scream and Shout are one kind of sign: the model heard a reaction.
    const kindsOfSign = new Set(moment.signs.map((sign) => (sign.kind === 'Chat' || sign.kind === 'Raised voice' ? sign.kind : 'reaction')));
    moment.rank = moment.signs[0].weight + 0.25 * (kindsOfSign.size - 1);
  }
  moments.sort((a, b) => b.rank - a.rank);

  const top = moments[0]?.rank || 1;
  return moments.map((moment) => ({
    time: round(moment.time),
    until: round(moment.until),
    kind: moment.signs[0].kind,
    signs: [...new Set(moment.signs.map((sign) => sign.kind))],
    strength: round(moment.rank / top),
  }));
}

// Gives each sign a weight between `least` and `most`, by how its score
// compares with the strongest sign of its kind.
function weigh(signs, least, most) {
  const strongest = Math.max(0, ...signs.map((sign) => sign.score)) || 1;
  return signs.map((sign) => ({ ...sign, weight: least + (most - least) * (sign.score / strongest) }));
}

// Stretches of talking where the voice is clearly sharper and louder than the
// talking in the five minutes around it, held for about two and a half seconds.
// Returns [{ time, until, kind: 'Raised voice', score }].
function findRaisedVoices(heard, sensitivity) {
  const TALKING = 0.6; // the model must be this sure it is speech...
  const NO_MUSIC = 0.3; // ...and music must be below this
  const AROUND = 625; // frames in five minutes
  const EVERY = 60; // "normal" is worked out again every half minute
  // How far above normal counts: 2.5 in the middle, 3.3 at the strict end, 1.7 at the loose end.
  const RAISED_ENOUGH = 2.5 + (0.5 - sensitivity) * 1.6;
  const APART = 42; // frames in twenty seconds: two picks are at least this far apart
  const frames = heard.sharp?.length || 0;

  const talking = new Uint8Array(frames);
  for (let f = 0; f < frames; f++) {
    talking[f] = heard.speech[f] > TALKING && heard.music[f] < NO_MUSIC ? 1 : 0;
  }

  // How far each talking frame is above what is normal nearby, counted in
  // "spreads" (how much the values usually vary), so sharpness and loudness
  // can be added together.
  function aboveNormal(values) {
    const result = new Float32Array(frames);
    for (let block = 0; block < frames; block += EVERY) {
      const nearby = [];
      for (let f = Math.max(0, block - AROUND); f < Math.min(frames, block + EVERY + AROUND); f++) {
        if (talking[f]) nearby.push(values[f]);
      }
      if (nearby.length < 50) continue;
      const sorted = Float32Array.from(nearby).sort();
      const normal = sorted[sorted.length >> 1];
      const distances = sorted.map((value) => Math.abs(value - normal)).sort();
      const spread = distances[distances.length >> 1] * 1.4826 || 1e-6;
      for (let f = block; f < Math.min(frames, block + EVERY); f++) {
        if (talking[f]) result[f] = (values[f] - normal) / spread;
      }
    }
    return result;
  }
  const sharper = aboveNormal(heard.sharp || []);
  const louder = aboveNormal(heard.level || []);

  const excitement = new Float32Array(frames);
  for (let f = 2; f < frames - 2; f++) {
    let sum = 0;
    let count = 0;
    for (let g = f - 2; g <= f + 2; g++) {
      if (talking[g]) {
        sum += sharper[g] + 0.5 * louder[g];
        count += 1;
      }
    }
    excitement[f] = count >= 4 ? sum / 5 : 0;
  }

  // Strongest first, skipping anything within twenty seconds of one already taken.
  const order = Array.from(excitement.keys()).sort((a, b) => excitement[b] - excitement[a]);
  const taken = new Uint8Array(frames);
  const picks = [];
  for (const f of order) {
    if (excitement[f] < RAISED_ENOUGH) break;
    if (taken[f]) continue;
    picks.push(f);
    taken.fill(1, Math.max(0, f - APART), f + APART + 1);
  }

  return picks.map((f) => ({
    time: f * FRAME_SECONDS,
    until: (f + 5) * FRAME_SECONDS,
    kind: 'Raised voice',
    score: excitement[f],
  }));
}

// Laughs, screams and shouts: [{ time, until, kind, score }], where `score`
// is how much of it there was (more, and surer, is higher).
function findReactions(heard, sensitivity) {
  // Below this the model's answer is ignored: 0.15 in the middle, 0.3 at the
  // strict end, 0.075 at the loose end.
  const SURE_ENOUGH = 0.15 * 2 ** ((0.5 - sensitivity) * 2);
  const JOIN_SECONDS = 15; // reactions closer together than this are one moment
  const SINGING = 0.4; // with music this clear, a shout or scream is taken to be a song

  const moments = [];
  let current = null;

  for (let frame = 0; frame < heard.laugh.length; frame++) {
    const singing = heard.music[frame] >= SINGING;
    const laugh = heard.laugh[frame];
    const scream = singing ? 0 : heard.scream[frame];
    const shout = singing ? 0 : heard.shout[frame];
    const strength = Math.max(laugh, scream, shout);
    if (strength < SURE_ENOUGH) continue;

    const time = frame * FRAME_SECONDS;
    if (!current || time - current.end > JOIN_SECONDS) {
      current = { time, end: time, score: 0, Laugh: 0, Scream: 0, Shout: 0 };
      moments.push(current);
    }
    current.end = time;
    current.score += strength;
    current.Laugh += laugh;
    current.Scream += scream;
    current.Shout += shout;
  }

  return moments.map((moment) => ({
    time: moment.time,
    until: moment.end + 2 * FRAME_SECONDS,
    // Named after whichever of the three there was most of.
    kind: ['Laugh', 'Scream', 'Shout'].reduce((most, kind) => (moment[kind] > moment[most] ? kind : most)),
    score: moment.score,
  }));
}

// Stretches of at least 45 seconds in which nobody talks, laughs or shouts:
// breaks, loading screens, dead air. Returns [{ start, end }] in seconds.
function findQuiet(heard) {
  const LONG_ENOUGH = 45 / FRAME_SECONDS;
  const frames = heard.speech?.length || 0;
  const voice = (f) => heard.speech[f] >= 0.3 || heard.laugh[f] >= 0.15 || heard.scream[f] >= 0.15 || heard.shout[f] >= 0.15;

  const quiet = [];
  let start = 0;
  for (let f = 0; f <= frames; f++) {
    // A single frame of "voice" on its own is the model guessing, not someone speaking.
    const talking = f < frames && voice(f) && ((f > 0 && voice(f - 1)) || (f + 1 < frames && voice(f + 1)));
    if (f < frames && !talking) continue;
    if (f - start >= LONG_ENOUGH) quiet.push({ start: round(start * FRAME_SECONDS), end: round(f * FRAME_SECONDS) });
    start = f + 1;
  }
  return quiet;
}

// What kind of video this is: { duration, fps, width, height, audioRate,
// audioChannels }. ffmpeg prints these when asked to open a file and do nothing.
function probeVideo(videoPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, ['-hide_banner', '-nostdin', '-i', videoPath], { windowsHide: true });
    let text = '';
    child.stderr.on('data', (chunk) => {
      text += chunk;
    });
    child.on('error', reject);
    child.on('close', () => {
      const length = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(text);
      const video = /Stream #.*Video:.*?(\d{2,5})x(\d{2,5}).*?([\d.]+) fps/.exec(text);
      const audio = /Stream #.*Audio:.*?(\d+) Hz, ([^,\n]+)/.exec(text);
      if (!length) {
        reject(new Error('ffmpeg could not read the video'));
        return;
      }
      const channels = { mono: 1, stereo: 2 };
      resolve({
        duration: Number(length[1]) * 3600 + Number(length[2]) * 60 + Number(length[3]),
        width: video ? Number(video[1]) : 0,
        height: video ? Number(video[2]) : 0,
        fps: video ? Number(video[3]) : 0,
        audioRate: audio ? Number(audio[1]) : 0,
        audioChannels: audio ? channels[audio[2].trim()] ?? 2 : 0,
      });
    });
  });
}

module.exports = { findMoments, findQuiet, probeVideo };

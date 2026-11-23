// Gets the moments out of the app and into the editing program:
//   resolveEdl    a list of markers that DaVinci Resolve lays over a timeline
//   premiereXml   a timeline for Premiere Pro, with the video on it and the markers above
//   cutClips      each moment as a video file of its own
//
// A moment here is { start, end, name, note, category, kind }, with the
// times in seconds from the start of the video.
//
// Neither editing program is on the PC this was written on, so the two files
// follow the programs' own exported files and other people's tested tools,
// not a test of our own.

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const paths = require('./paths');

// The marker colour for moments that are in no category, by why the app
// picked them: the Resolve colour closest to the one they have in the app.
const KIND_COLOURS = {
  Laugh: 'Rose',
  Scream: 'Lavender',
  Shout: 'Lemon',
  'Raised voice': 'Sky',
  Chat: 'Mint',
  Added: 'Cream',
};

// Premiere has eight marker colours, each written as one number. This gives
// the nearest one for every Resolve colour used here.
const PREMIERE = { red: 4281740498, orange: 4280578025, yellow: 4281049552, green: 4281828977, cyan: 4292277273, blue: 4294741314, purple: 4289825711, white: 4294967295 };
const PREMIERE_COLOURS = {
  Blue: PREMIERE.blue,
  Green: PREMIERE.green,
  Red: PREMIERE.red,
  Pink: PREMIERE.purple,
  Sand: PREMIERE.orange,
  Cyan: PREMIERE.cyan,
  Yellow: PREMIERE.yellow,
  Purple: PREMIERE.purple,
  Rose: PREMIERE.orange,
  Lavender: PREMIERE.purple,
  Lemon: PREMIERE.yellow,
  Sky: PREMIERE.cyan,
  Mint: PREMIERE.green,
  Cream: PREMIERE.white,
};

// The Resolve name of a moment's colour: that of its category, or else of
// why it was picked. `colours` gives the colour of each category.
function colourOf(moment, colours) {
  return colours.get(moment.category) || KIND_COLOURS[moment.kind] || 'Blue';
}

const two = (number) => String(number).padStart(2, '0');

// Editing programs count in frames. A video's frame rate is a whole number
// (25, 30, 60) or one of the television rates just under one (23.976, 29.97,
// 59.94). Either way the frames are numbered against the whole number.
// Returns { perSecond, ntsc, exact }: the whole number, whether it is one of
// the television rates, and the real number of frames per second.
function rateOf(video) {
  const perSecond = Math.round(video.fps) || 30;
  const ntsc = Math.abs(video.fps - perSecond / 1.001) < 0.011;
  return { perSecond, ntsc, exact: ntsc ? perSecond / 1.001 : perSecond };
}

// ---------- DaVinci Resolve ----------

// The moments as an EDL of markers, the same kind of file Resolve itself
// writes with "Export > Timeline Markers to EDL". Resolve lays them over a
// timeline that has the video at its start.
//
// Two things about the editor's timeline cannot be known here:
//   - Its starting time. Resolve's is 01:00:00:00 unless it was changed, so
//     that is what the markers are counted from.
//   - Its frame rate. So each marker sits on a whole second, which means
//     the same place at every frame rate. The lengths are counted in frames
//     of the video; on a timeline with another frame rate they come out
//     longer or shorter, but still start in the right place.
function resolveEdl(moments, video, colours) {
  const { perSecond, exact } = rateOf(video);
  const TIMELINE_START = 3600; // seconds: 01:00:00:00
  // A marker is one line, and "|" is what separates its parts.
  const oneLine = (text) => text.replace(/[\s|]+/g, ' ').trim();
  // Seconds of the timeline's clock as "01:02:03".
  const clock = (seconds) => [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60].map(two).join(':');

  const lines = ['TITLE: Loudest moments', 'FCM: NON-DROP FRAME', ''];
  moments.forEach((moment, index) => {
    // The frame the moment starts on, then the whole second of the
    // timeline's clock that frame is in.
    const firstFrame = Math.floor(moment.start * exact);
    const second = Math.floor(firstFrame / perSecond);
    const length = Math.max(1, Math.round(moment.end * exact) - second * perSecond);
    // As far as the EDL's own columns go a marker is one frame long, and is
    // written twice. Its real length is in the |D: part.
    const at = `${clock(TIMELINE_START + second)}:00 ${clock(TIMELINE_START + second)}:01`;
    lines.push(
      `${String(index + 1).padStart(3, '0')}  001      V     C        ${at} ${at}  `,
      `${oneLine(moment.note)} |C:ResolveColor${colourOf(moment, colours)} |M:${oneLine(moment.name)} |D:${length}`,
      '',
    );
  });
  return lines.join('\r\n');
}

// ---------- Premiere Pro ----------

const escapeXml = (text) => text.replace(/[<>&'"]/g, (character) => (
  { '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[character]
));

// The place of a file the way Premiere itself writes it:
// C:\Videos\a b [x].mp4 becomes file://localhost/C%3a/Videos/a%20b%20[x].mp4
// Square brackets stay as they are; Premiere does not find the file otherwise.
function addressOf(file) {
  const parts = file.split(path.sep).map((part) => (
    encodeURIComponent(part).replace(/%5B/g, '[').replace(/%5D/g, ']').replace(/%[0-9A-F]{2}/g, (code) => code.toLowerCase())
  ));
  return 'file://localhost/' + parts.join('/');
}

// The moments as a timeline in the "Final Cut Pro XML" format, which
// Premiere Pro opens with File > Import (and Resolve with File > Import >
// Timeline): one sequence with the whole video on it and a marker for every
// moment. `video` is what probeVideo found, plus `path`.
function premiereXml(moments, video, colours) {
  const { perSecond, ntsc, exact } = rateOf(video);
  const rate = `<rate><timebase>${perSecond}</timebase><ntsc>${ntsc ? 'TRUE' : 'FALSE'}</ntsc></rate>`;
  const startsAtZero = `<timecode>${rate}<string>00:00:00:00</string><frame>0</frame><displayformat>NDF</displayformat></timecode>`;
  // Premiere refuses a clip that claims to be longer than the file's picture
  // is. The sound often runs a few frames longer than the picture, so the
  // last half second is left off to be safe.
  const length = Math.max(1, Math.floor((video.duration - 0.5) * exact));
  const frame = (seconds) => Math.min(length, Math.round(seconds * exact));
  const name = escapeXml(path.basename(video.path));
  const channels = Math.min(2, Math.max(1, video.audioChannels));
  const picture = `<samplecharacteristics>${rate}<width>${video.width}</width><height>${video.height}</height>`
    + '<anamorphic>FALSE</anamorphic><pixelaspectratio>square</pixelaspectratio><fielddominance>none</fielddominance></samplecharacteristics>';
  const sound = `<samplecharacteristics><depth>16</depth><samplerate>${video.audioRate || 48000}</samplerate></samplecharacteristics>`;

  // The first mention of the file describes it; the others only point at it.
  const file = `<file id="file-1"><name>${name}</name><pathurl>${escapeXml(addressOf(video.path))}</pathurl>${rate}<duration>${length}</duration>${startsAtZero}`
    + `<media><video>${picture}</video><audio>${sound}<channelcount>${channels}</channelcount></audio></media></file>`;
  // The picture and each sound channel name each other, so they move as one clip.
  const links = '<link><linkclipref>clipitem-1</linkclipref><mediatype>video</mediatype><trackindex>1</trackindex><clipindex>1</clipindex></link>'
    + Array.from({ length: channels }, (_, channel) => (
      `<link><linkclipref>clipitem-${channel + 2}</linkclipref><mediatype>audio</mediatype><trackindex>${channel + 1}</trackindex><clipindex>1</clipindex><groupindex>1</groupindex></link>`
    )).join('');
  // The whole video, once as picture and once per sound channel.
  const clip = (id, attributes, inside) => `<clipitem id="${id}"${attributes}><name>${name}</name><enabled>TRUE</enabled><duration>${length}</duration>${rate}`
    + `<start>0</start><end>${length}</end><in>0</in><out>${length}</out>${inside}${links}</clipitem>`;
  // The extra words on the sound tracks are Premiere's own: with them the two
  // channels arrive as one stereo track, without them as two separate ones.
  const soundTracks = Array.from({ length: channels }, (_, channel) => (
    `<track currentExplodedTrackIndex="${channel}" totalExplodedTrackCount="${channels}" premiereTrackType="${channels === 2 ? 'Stereo' : 'Mono'}">`
    + clip(`clipitem-${channel + 2}`, ` premiereChannelType="${channels === 2 ? 'stereo' : 'mono'}"`,
      `<file id="file-1"/><sourcetrack><mediatype>audio</mediatype><trackindex>${channel + 1}</trackindex></sourcetrack>`)
    + `<outputchannelindex>${channel + 1}</outputchannelindex></track>`
  ));

  const markers = moments.map((moment) => (
    `<marker><comment>${escapeXml(moment.note)}</comment><name>${escapeXml(moment.name)}</name>`
    + `<in>${frame(moment.start)}</in><out>${frame(moment.end)}</out><pproColor>${PREMIERE_COLOURS[colourOf(moment, colours)]}</pproColor></marker>`
  ));

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE xmeml>',
    '<xmeml version="4">',
    `<sequence id="sequence-1" explodedTracks="true"><name>${escapeXml(path.parse(video.path).name)} moments</name><duration>${length}</duration>${rate}`,
    startsAtZero,
    '<media>',
    `<video><format>${picture}</format><track>${clip('clipitem-1', '', file)}</track></video>`,
    `<audio><numOutputChannels>${channels}</numOutputChannels><format>${sound}</format>${soundTracks.join('')}</audio>`,
    '</media>',
    ...markers,
    '</sequence>',
    '</xmeml>',
    '',
  ].join('\n');
}

// ---------- Clips ----------

let cutting = null; // the ffmpeg that is cutting now
let stopped = false;

// Stops the cutting that is in progress, if there is one.
function cancelClips() {
  stopped = true;
  if (cutting) cutting.kill();
}

// 3723 seconds becomes "1h02m03s": a time that is allowed in a file name and
// sorts in the right order.
function stamp(seconds) {
  const whole = Math.floor(seconds);
  return `${Math.floor(whole / 3600)}h${two(Math.floor(whole / 60) % 60)}m${two(whole % 60)}s`;
}

// What Windows does not allow in a file name is taken out.
function safeName(text) {
  return text.replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120).replace(/[. ]+$/, '');
}

// Cuts each moment out of the video as a file of its own, in a new folder
// inside `folder` named after the video. Nothing is re-encoded: picture and
// sound are copied as they are, which is quick and loses no quality. The
// price is that a cut can only start where the video allows one, so a clip
// may begin a few seconds early.
// `onProgress(done)` is called before each clip. Resolves with the folder
// the clips are in; rejects with an error that has `cancelled` set if it
// was stopped.
async function cutClips(videoPath, moments, folder, onProgress) {
  stopped = false;
  const video = path.parse(videoPath);
  const into = path.join(folder, safeName(video.name + ' clips'));
  fs.mkdirSync(into, { recursive: true });

  for (const [index, moment] of moments.entries()) {
    onProgress(index);
    const target = path.join(into, safeName(`${stamp(moment.start)} ${moment.name}`) + video.ext);
    await new Promise((resolve, reject) => {
      cutting = spawn(paths.ffmpeg, [
        '-hide_banner', '-nostdin', '-v', 'error',
        '-y', // cutting the same moment again replaces the earlier clip
        '-ss', String(moment.start),
        '-i', videoPath,
        '-t', String(moment.end - moment.start),
        '-map', '0:v?', '-map', '0:a?', // the picture and every sound track
        '-c', 'copy',
        '-avoid_negative_ts', 'make_zero',
        target,
      ], { windowsHide: true });
      let errorText = '';
      cutting.stderr.on('data', (chunk) => {
        if (errorText.length < 2000) errorText += chunk;
      });
      cutting.on('error', reject);
      cutting.on('close', (code) => {
        cutting = null;
        if (stopped) reject(Object.assign(new Error('The cutting was cancelled'), { cancelled: true }));
        else if (code !== 0) reject(new Error(errorText.trim() || 'ffmpeg could not cut the clip'));
        else resolve();
      });
    });
  }
  return into;
}

module.exports = { resolveEdl, premiereXml, cutClips, cancelClips };

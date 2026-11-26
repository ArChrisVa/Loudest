const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, Notification, screen, shell, utilityProcess } = require('electron');
const { findMoments, findQuiet, probeVideo } = require('./analysis');
const { readChatFile, findChatSpikes, chatDensity } = require('./chat');
const { downloadChat, cancelDownload } = require('./chat-download');
const { transcribe, cancelTranscribe, canTranscribe } = require('./transcribe');
const { resolveEdl, premiereXml, cutClips, cancelClips } = require('./exporters');

const dataFolder = app.getPath('userData');

// The helper programs and the speech model that are downloaded the first
// time they are needed, instead of making the installer carry them.
const toolsFolder = path.join(dataFolder, 'tools');
const speechFolder = path.join(dataFolder, 'speech');

// Every video that has been opened is remembered in this one file, so the
// Home screen can list them again the next day.
const recentFile = path.join(dataFolder, 'recent.json');

// What was worked out about each video, one file per video in each folder.
// All of it can be worked out again from the video (or downloaded again):
const analysisFolder = path.join(dataFolder, 'analysis'); // what the sound-recognition model heard
const chatFolder = path.join(dataFolder, 'chat'); // the stream's chat
const transcriptFolder = path.join(dataFolder, 'transcripts'); // what was said, as text

// The editor's own work on each video, one file per video: which moments they
// kept or rejected, the names, notes and categories they gave them, where
// they start and end, and the moments they added by hand. This cannot be
// worked out again.
const momentsFolder = path.join(dataFolder, 'moments');

// The colour of each category, so a category looks the same in every video.
const categoriesFile = path.join(dataFolder, 'categories.json');

// The few choices the editor makes once: how many moments to find, how
// early a moment starts, and the language spoken in the videos.
const settingsFile = path.join(dataFolder, 'settings.json');

// Colours handed to new categories, in this order, each with the name
// DaVinci Resolve gives the nearest marker colour. The first five do not look
// like the colours of Laugh, Scream, Shout and Raised voice.
const CATEGORY_COLOURS = [
  ['#4c8dff', 'Blue'],
  ['#45c46b', 'Green'],
  ['#f0524f', 'Red'],
  ['#f47fbe', 'Pink'],
  ['#c9a26b', 'Sand'],
  ['#35c9d9', 'Cyan'],
  ['#f2c94c', 'Yellow'],
  ['#a779f0', 'Purple'],
];

const STATUSES = ['', 'kept', 'rejected'];
const LANGUAGES = ['el', 'en', 'auto'];
// The jumps the menu beside the speed offers, in seconds (index.html).
const SKIP_CHOICES = [1, 5, 10, 30];
// The orders the list of moments can be in.
const SORTS = ['strength', 'time', 'kind'];
// How big everything in the window can be drawn: 1 is the normal size, and
// View, Bigger text goes up from there one step at a time.
const SIZES = [1, 1.1, 1.2, 1.3, 1.4, 1.5];

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    // No such file yet, or it cannot be read.
    return fallback;
  }
}

// Writes a temporary file and renames it over the real one, so a crash
// halfway through cannot leave a half-written file behind.
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = file + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(data));
  fs.renameSync(temporary, file);
}

// Where something about one video is saved inside `folder`. The file is named
// after a fingerprint of the video's path, because a path cannot be a file name.
function savedFile(folder, videoPath) {
  const fingerprint = crypto.createHash('sha1').update(videoPath).digest('hex');
  return path.join(folder, fingerprint + '.json');
}

function isVideoPath(value) {
  return typeof value === 'string' && path.isAbsolute(value);
}

// Every request from the window names a video by its full path. Anything else is refused.
function needVideoPath(value) {
  if (!isVideoPath(value)) throw new Error('This needs the full path of a video file');
}

function tellWindow(channel, details) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, details);
  }
}

// ---------- The list of opened videos ----------

function readRecent() {
  const list = readJson(recentFile, []);
  return Array.isArray(list) ? list.filter((entry) => typeof entry?.path === 'string') : [];
}

// What the window needs on top of what is stored: an address the player can
// load, whether the file is still where it was, and how much of the editor's
// work the video holds.
function forWindow(entry) {
  const moments = readSavedMoments(entry.path);
  return {
    ...entry,
    url: pathToFileURL(entry.path).href,
    missing: !fs.existsSync(entry.path),
    saved: moments.length,
    kept: moments.filter((moment) => moment.status === 'kept').length,
  };
}

function isThumbnail(value) {
  return typeof value === 'string'
    && value.startsWith('data:image/jpeg;base64,')
    && value.length < 200000;
}

ipcMain.handle('recent:list', () => {
  const list = readRecent();
  list.sort((a, b) => b.lastOpened - a.lastOpened);
  return list.map(forWindow);
});

// Adds a video to the list, or updates the one already there, and marks it as
// opened now. The length and picture are optional because they arrive a
// moment after the video is first opened.
ipcMain.handle('recent:save', (event, details) => {
  const videoPath = details?.path;
  needVideoPath(videoPath);

  const list = readRecent();
  let entry = list.find((item) => item.path === videoPath);
  if (!entry) {
    entry = { path: videoPath, name: path.basename(videoPath) };
    list.push(entry);
  }
  if (Number.isFinite(details.duration)) entry.duration = details.duration;
  if (isThumbnail(details.thumbnail)) entry.thumbnail = details.thumbnail;
  entry.lastOpened = Date.now();

  try {
    writeJson(recentFile, list);
  } catch (error) {
    // The video should still open even if the list cannot be saved.
    console.error('Could not save the list of recent videos:', error);
  }
  return forWindow(entry);
});

// Notes how many of a video's moments are still to review, for its card on
// the Home screen. The window says so while the video is open; this does not
// count as opening it.
ipcMain.handle('recent:progress', (event, videoPath, toReview) => {
  needVideoPath(videoPath);
  const list = readRecent();
  const entry = list.find((item) => item.path === videoPath);
  if (!entry || !Number.isInteger(toReview) || toReview < 0) return;
  entry.toReview = toReview;
  try {
    writeJson(recentFile, list);
  } catch (error) {
    console.error('Could not save the list of recent videos:', error);
  }
});

// Forgets a video and everything saved about it, including the editor's work.
// The video file itself is not touched. The window asks before calling this
// when there is work to lose.
ipcMain.handle('recent:remove', (event, videoPath) => {
  needVideoPath(videoPath);
  writeJson(recentFile, readRecent().filter((entry) => entry.path !== videoPath));
  for (const folder of [analysisFolder, chatFolder, transcriptFolder, momentsFolder]) {
    fs.rmSync(savedFile(folder, videoPath), { force: true });
  }
  chatInMemory = { path: '', messages: [] };
  unlisten(videoPath);
});

// ---------- Settings ----------

function readSettings() {
  const saved = readJson(settingsFile, {});
  const within = (value, fallback, least, most) => (Number.isFinite(value) ? Math.min(most, Math.max(least, value)) : fallback);
  return {
    // From 0 (only the clearest moments) to 1 (weak ones too).
    sensitivity: within(saved?.sensitivity, 0.5, 0, 1),
    // How many seconds before a moment its clip starts, so what led up to it is seen.
    leadIn: within(saved?.leadIn, 5, 0, 60),
    // The language spoken in the videos, for the transcript: 'el', 'en', or
    // 'auto' to have it worked out. Until the editor chooses, Greek on a PC
    // that is set up for Greek.
    language: LANGUAGES.includes(saved?.language)
      ? saved.language
      : app.getPreferredSystemLanguages().some((language) => language.startsWith('el')) ? 'el' : 'auto',
    // How many seconds the two skip buttons under the picture jump.
    skip: SKIP_CHOICES.includes(saved?.skip) ? saved.skip : 5,
    // The order of the list of moments.
    sort: SORTS.includes(saved?.sort) ? saved.sort : 'strength',
    // How big everything is drawn, one of SIZES.
    size: SIZES.includes(saved?.size) ? saved.size : 1,
    // The version of Loudest that last ran here, so that after an update
    // the window can say what is new. null until one has been noted.
    seenVersion: typeof saved?.seenVersion === 'string' && /^\d+\.\d+\.\d+$/.test(saved.seenVersion) ? saved.seenVersion : null,
  };
}

ipcMain.handle('settings:get', () => readSettings());

ipcMain.handle('settings:set', (event, changes) => {
  // The size is not among these: it changes through 'size:change' below,
  // which changes the window with it.
  const { sensitivity, leadIn, language, skip, sort, seenVersion } = { ...readSettings(), ...changes };
  writeJson(settingsFile, { sensitivity, leadIn, language, skip, sort, seenVersion, size: readSettings().size });
  // Read back, so that anything out of range comes back corrected.
  return readSettings();
});

// ---------- The editor's work ----------

// One saved moment with anything unexpected removed, or null for a record
// that makes no sense. Used on the way in from the window and from disk.
function cleanMoment(record) {
  if (!Number.isFinite(record?.time) || record.time < 0) return null;
  const text = (value, limit) => (typeof value === 'string' ? value.trim().slice(0, limit) : '');
  const seconds = (value) => (Number.isFinite(value) && value >= 0 ? value : null);
  return {
    time: record.time,
    kind: text(record.kind, 30) || 'Added',
    name: text(record.name, 200),
    category: text(record.category, 60),
    note: text(record.note, 1000),
    status: STATUSES.includes(record.status) ? record.status : '',
    // Where the editor moved its start and end to; null where they did not.
    start: seconds(record.start),
    end: seconds(record.end),
  };
}

function readSavedMoments(videoPath) {
  const saved = readJson(savedFile(momentsFolder, videoPath), null);
  return Array.isArray(saved?.moments) ? saved.moments.map(cleanMoment).filter(Boolean) : [];
}

// The categories in use across all videos, each with its colour.
// A category exists for as long as some moment is in it: this gives a colour
// to a name it has not seen before, and forgets names nothing uses any more.
function readCategories() {
  let files = [];
  try {
    files = fs.readdirSync(momentsFolder);
  } catch {
    // No work has been saved yet.
  }
  const inUse = new Set();
  for (const file of files.filter((name) => name.endsWith('.json'))) {
    const saved = readJson(path.join(momentsFolder, file), null);
    const moments = Array.isArray(saved?.moments) ? saved.moments.map(cleanMoment).filter(Boolean) : [];
    for (const moment of moments) {
      if (moment.category) inUse.add(moment.category);
    }
  }

  const known = readJson(categoriesFile, []);
  const categories = (Array.isArray(known) ? known : []).filter(
    (category) => inUse.has(category?.name) && typeof category.colour === 'string',
  );
  for (const name of inUse) {
    if (categories.some((category) => category.name === name)) continue;
    const unused = CATEGORY_COLOURS.find(([colour]) => !categories.some((category) => category.colour === colour));
    // With more categories than colours, colours start to repeat.
    const [colour] = unused ?? CATEGORY_COLOURS[categories.length % CATEGORY_COLOURS.length];
    categories.push({ name, colour });
  }

  if (JSON.stringify(categories) !== JSON.stringify(known)) {
    try {
      writeJson(categoriesFile, categories);
    } catch (error) {
      // Only the colours are at stake; the names live with the moments.
      console.error('Could not save the category colours:', error);
    }
  }
  return categories;
}

ipcMain.handle('moments:load', (event, videoPath) => {
  needVideoPath(videoPath);
  return readSavedMoments(videoPath);
});

// Saves the editor's work on one video and answers with the categories that
// are now in use. A failure here reaches the window, which tells the editor.
ipcMain.handle('moments:save', (event, videoPath, records) => {
  needVideoPath(videoPath);
  if (!Array.isArray(records)) throw new Error('moments:save needs a list of moments');

  const moments = records.map(cleanMoment).filter(Boolean);
  if (moments.length === 0) {
    fs.rmSync(savedFile(momentsFolder, videoPath), { force: true });
  } else {
    writeJson(savedFile(momentsFolder, videoPath), { path: videoPath, moments });
  }
  return readCategories();
});

ipcMain.handle('categories:list', () => readCategories());

// Every kept moment of every video, newest video first, for the Home screen.
ipcMain.handle('moments:kept', () => {
  const videos = readRecent().sort((a, b) => b.lastOpened - a.lastOpened);
  return videos.flatMap((video) =>
    readSavedMoments(video.path)
      .filter((moment) => moment.status === 'kept')
      .sort((a, b) => a.time - b.time)
      .map((moment) => ({ ...moment, path: video.path, video: video.name, missing: !fs.existsSync(video.path) })),
  );
});

// ---------- Listening to videos, one at a time ----------

// Videos waiting to be listened to, the next one first; the one being
// listened to now; and who is waiting to hear that a video is done.
const waiting = [];
let listeningTo = null;
const waiters = new Map(); // video path -> functions to call with the outcome
let closing = false;

// What was heard in a video last time, or null when there is nothing saved
// or the video file has changed since (different size or date).
function readSavedHearing(videoPath) {
  let stats;
  try {
    stats = fs.statSync(videoPath);
  } catch {
    return null;
  }
  const saved = readJson(savedFile(analysisFolder, videoPath), null);
  const unchanged = saved?.size === stats.size && saved?.modified === stats.mtimeMs;
  // `shout` was the last thing added; a result without it is listened to again.
  return unchanged && Array.isArray(saved.heard?.shout) ? saved.heard : null;
}

function queueStatus() {
  return { listening: listeningTo, waiting: [...waiting] };
}

// Takes a video out of the queue, stopping it if it is the one being
// listened to, and tells whoever was waiting for it that it will not happen.
function unlisten(videoPath) {
  const place = waiting.indexOf(videoPath);
  if (place !== -1) waiting.splice(place, 1);
  for (const done of waiters.get(videoPath) ?? []) done({ cancelled: true });
  waiters.delete(videoPath);
  if (listeningTo === videoPath) stopListening();
}

// The listening is done by a helper process, started for one video and ended
// when that video is done. (listen.js says why it is a process of its own.)
let helper = null; // the one at work now
let stoppedHelper = null; // the one that was last stopped on purpose

// Stops the listening that is in progress, if there is one.
function stopListening() {
  stoppedHelper = helper;
  helper?.kill();
}

// Has a helper listen to one video and resolves with what it heard. Rejects
// with an error that has `cancelled` set if the listening was stopped.
async function listenTo(videoPath) {
  const child = utilityProcess.fork(path.join(__dirname, 'listen.js'));
  helper = child;
  try {
    return await new Promise((resolve, reject) => {
      child.on('message', (message) => {
        if (message.seconds !== undefined) tellWindow('listen:progress', { path: videoPath, seconds: message.seconds });
        else if (message.heard) resolve(message.heard);
        else reject(new Error(message.error));
      });
      // It was stopped, or it has crashed. (After an answer this changes nothing.)
      child.on('exit', () => {
        reject(Object.assign(new Error('The listening helper ended early'), { cancelled: stoppedHelper === child }));
      });
      child.postMessage(videoPath);
    });
  } finally {
    child.kill();
    if (helper === child) helper = null;
  }
}

// Listens to one video and saves what was heard. Answers {} when that is
// done (or was done before), { error } with a sentence to show, or
// { cancelled } when it was interrupted.
async function hear(videoPath) {
  if (!fs.existsSync(videoPath)) return { error: 'The video file is no longer where it was.' };
  if (readSavedHearing(videoPath)) return {};

  // The sound-recognition library is built on a free piece of Windows that
  // most PCs have, because games and editing programs install it. Without it
  // the helper would just die, so look for it first and say what to do.
  const system = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
  if (!['msvcp140.dll', 'vcruntime140_1.dll'].every((file) => fs.existsSync(path.join(system, file)))) {
    return { error: 'Listening needs a free piece of Windows that this PC is missing: the Microsoft Visual C++ Redistributable. Install it from aka.ms/vc14/vc_redist.x64.exe, then open the video again.' };
  }

  let heard;
  try {
    heard = await listenTo(videoPath);
  } catch (error) {
    if (error.cancelled) return { cancelled: true };
    // ffmpeg's way of saying the file has no audio track.
    if (/matches no streams/.test(error.message)) return { error: 'This video has no sound to listen to.' };
    console.error('Could not listen to the video:', error);
    return { error: 'The sound of this video could not be read.' };
  }

  try {
    // Written directly: if a crash cuts this file short, the video is simply listened to again.
    const stats = fs.statSync(videoPath);
    fs.mkdirSync(analysisFolder, { recursive: true });
    const saved = { path: videoPath, size: stats.size, modified: stats.mtimeMs, heard };
    fs.writeFileSync(savedFile(analysisFolder, videoPath), JSON.stringify(saved));
  } catch (error) {
    console.error('Could not save what was heard:', error);
    return { error: 'What was heard could not be saved. Check that the disk is not full.' };
  }
  return {};
}

// Works through the queue until it is empty. Calling it while it is already
// at work does nothing.
async function workThroughQueue() {
  if (listeningTo) return;
  while (waiting.length > 0 && !closing) {
    const videoPath = waiting.shift();
    listeningTo = videoPath;
    tellWindow('queue:changed', queueStatus());

    const outcome = await hear(videoPath);
    listeningTo = null;
    // Interrupted: whoever interrupted it has put it back in the queue if it is still wanted.
    if (outcome.cancelled) continue;
    for (const done of waiters.get(videoPath) ?? []) done(outcome);
    waiters.delete(videoPath);
  }
  tellWindow('queue:changed', queueStatus());
}

// Used when a video is opened: it is listened to before anything else, and
// whatever was being listened to goes back to wait its turn. Answers when
// the video has been listened to: {} or { error }.
ipcMain.handle('listen:now', (event, videoPath) => {
  needVideoPath(videoPath);
  if (readSavedHearing(videoPath)) return {};

  return new Promise((resolve) => {
    waiters.set(videoPath, [...(waiters.get(videoPath) ?? []), resolve]);
    if (listeningTo !== videoPath) {
      const place = waiting.indexOf(videoPath);
      if (place !== -1) waiting.splice(place, 1);
      if (listeningTo) waiting.unshift(listeningTo);
      waiting.unshift(videoPath);
      if (listeningTo) stopListening();
    }
    workThroughQueue();
  });
});

// Used when several videos are added at once: they are listened to in turn.
ipcMain.handle('queue:add', (event, videoPaths) => {
  for (const videoPath of Array.isArray(videoPaths) ? videoPaths.filter(isVideoPath) : []) {
    const known = videoPath === listeningTo || waiting.includes(videoPath);
    if (!known && !readSavedHearing(videoPath)) waiting.push(videoPath);
  }
  workThroughQueue();
  return queueStatus();
});

ipcMain.handle('queue:status', () => queueStatus());

// ---------- Finding the moments ----------

const NOTHING_HEARD = { laugh: [], scream: [], shout: [], music: [], speech: [], sharp: [], level: [] };

// The chat that was read last. A busy stream's chat is a big file, and the
// moments are asked for again every time the slider moves.
let chatInMemory = { path: '', messages: [] };

function readChat(videoPath) {
  if (chatInMemory.path !== videoPath) {
    const saved = readJson(savedFile(chatFolder, videoPath), null);
    chatInMemory = { path: videoPath, messages: Array.isArray(saved?.messages) ? saved.messages : [] };
  }
  return chatInMemory.messages;
}

// The moments found in a video, from what was heard in it and from its chat
// if it has one. `sensitivity` runs from 0 (only the clearest moments) to 1
// (weak ones too). Fast: it works from what is already saved, so it can be
// asked again whenever something changes.
// Answers { moments, quiet, chat }:
//   quiet   stretches where nobody speaks
//   chat    null, or how many messages there are and how busy they are along the video
ipcMain.handle('moments:find', (event, videoPath, wanted) => {
  needVideoPath(videoPath);
  const sensitivity = Number.isFinite(wanted) ? Math.min(1, Math.max(0, wanted)) : 0.5;
  const heard = readSavedHearing(videoPath);
  const chat = readChat(videoPath);
  const duration = (heard?.laugh.length ?? 0) * 0.48;
  // A chat can run on after the video ends (a recording that was cut short,
  // or the link of another stream). What was written past the end points at nothing.
  const messages = duration ? chat.filter(([seconds]) => seconds <= duration) : chat;

  return {
    moments: findMoments(heard ?? NOTHING_HEARD, { sensitivity, chatSpikes: findChatSpikes(messages, sensitivity) }),
    quiet: heard ? findQuiet(heard) : [],
    chat: chat.length ? { count: chat.length, density: chatDensity(messages, duration) } : null,
  };
});

// How loud the video is along its length, for the Sound lane of the timeline:
// { level, seconds }, one number per `seconds` of video. They are the
// listening's own numbers (one per 0.48 s), thinned out so that even a
// ten-hour video is only a few thousand of them.
ipcMain.handle('sound:level', (event, videoPath) => {
  needVideoPath(videoPath);
  const level = readSavedHearing(videoPath)?.level ?? [];
  const every = Math.max(1, Math.ceil(level.length / 8000));
  const thinned = [];
  for (let i = 0; i < level.length; i += every) thinned.push(Math.max(...level.slice(i, i + every)));
  return { level: thinned, seconds: every * 0.48 };
});

// ---------- The chat ----------

function saveChat(videoPath, messages) {
  writeJson(savedFile(chatFolder, videoPath), { path: videoPath, messages });
  chatInMemory = { path: videoPath, messages };
  return { count: messages.length };
}

// A video downloaded with yt-dlp has the stream's code in its name, like
// "Title [hRf348Iw1kc].mp4". That is enough to know the stream's link.
ipcMain.handle('chat:guessLink', (event, videoPath) => {
  needVideoPath(videoPath);
  const code = /\[([A-Za-z0-9_-]{11})\]\.[^.]+$/.exec(path.basename(videoPath));
  return code ? `https://www.youtube.com/watch?v=${code[1]}` : '';
});

// Reads a chat file the editor already has. Answers { count } or { error }.
ipcMain.handle('chat:fromFile', async (event, videoPath, chatPath) => {
  needVideoPath(videoPath);
  needVideoPath(chatPath);
  try {
    return saveChat(videoPath, await readChatFile(chatPath));
  } catch (error) {
    console.error('Could not read the chat file:', error);
    return { error: 'No chat messages were found in that file.' };
  }
});

// Downloads the chat of the stream at `link`. Answers { count }, { error } or { cancelled }.
ipcMain.handle('chat:fromLink', async (event, videoPath, link) => {
  needVideoPath(videoPath);
  let address;
  try {
    address = new URL(String(link).trim());
  } catch {
    return { error: 'That does not look like a link.' };
  }
  if (!['http:', 'https:'].includes(address.protocol)) return { error: 'That does not look like a link.' };

  try {
    return saveChat(videoPath, await downloadChat(address, toolsFolder));
  } catch (error) {
    if (error.cancelled) return { cancelled: true };
    console.error('Could not get the chat:', error);
    return { error: error.friendly ?? 'The chat could not be downloaded.' };
  }
});

ipcMain.handle('chat:cancel', () => cancelDownload());

// What the chat was writing around `seconds` into the video, for the Chat
// tab: the messages of the twenty seconds before and after, at most thirty
// each way, as [[seconds, text], ...].
ipcMain.handle('chat:around', (event, videoPath, seconds) => {
  needVideoPath(videoPath);
  const REACH = 20; // seconds
  const MOST = 30; // messages each way
  const at = Number.isFinite(seconds) ? seconds : 0;
  const chat = readChat(videoPath);
  // The chat is in time order, so the first message after `at` is found by
  // halving, which stays quick in a chat of a million messages.
  let low = 0;
  let high = chat.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (chat[middle][0] <= at) low = middle + 1;
    else high = middle;
  }
  const before = chat.slice(Math.max(0, low - MOST), low).filter(([time]) => time >= at - REACH);
  const after = chat.slice(low, low + MOST).filter(([time]) => time <= at + REACH);
  return [...before, ...after];
});

ipcMain.handle('chat:remove', (event, videoPath) => {
  needVideoPath(videoPath);
  fs.rmSync(savedFile(chatFolder, videoPath), { force: true });
  chatInMemory = { path: '', messages: [] };
});

// ---------- The transcript ----------

// What was said in a video, if it was written out before: { lines }, where
// each line is [start, end, text]. Null if not.
ipcMain.handle('transcript:load', (event, videoPath) => {
  needVideoPath(videoPath);
  const saved = readJson(savedFile(transcriptFolder, videoPath), null);
  return Array.isArray(saved?.lines) ? { lines: saved.lines } : null;
});

ipcMain.handle('transcript:possible', () => canTranscribe());

// Writes out what is said in a video, in the language chosen in the
// settings. This takes a long time; progress goes to the window as
// { path, step, fraction }, where `step` is 'model' while the speech model
// is being downloaded and 'speech' after that.
// Answers { lines }, { error } or { cancelled }.
ipcMain.handle('transcript:run', async (event, videoPath) => {
  needVideoPath(videoPath);
  // The window hides the Transcript tab while the speech program is not
  // there. Asked anyway, this would download the 574 MB speech model for nothing.
  if (!canTranscribe()) return { error: 'This version of Loudest cannot write out speech.' };
  try {
    const lines = await transcribe(videoPath, {
      language: readSettings().language,
      folder: speechFolder,
      // Only the stretches where someone speaks are written out.
      heard: readSavedHearing(videoPath),
      onProgress: (step, fraction) => tellWindow('transcript:progress', { path: videoPath, step, fraction }),
    });
    writeJson(savedFile(transcriptFolder, videoPath), { path: videoPath, lines });
    return { lines };
  } catch (error) {
    if (error.cancelled) return { cancelled: true };
    console.error('Could not write out the speech:', error);
    return { error: error.friendly ?? 'The speech could not be written out.' };
  }
});

ipcMain.handle('transcript:cancel', () => cancelTranscribe());

// ---------- Exporting ----------

// A moment as the window sends it for exporting, with anything unexpected
// removed: { start, end, name, note, category, kind }.
function cleanExport(record) {
  if (!Number.isFinite(record?.start) || !Number.isFinite(record?.end) || record.start < 0 || record.end <= record.start) {
    return null;
  }
  const text = (value, limit) => (typeof value === 'string' ? value.trim().slice(0, limit) : '');
  return {
    start: record.start,
    end: record.end,
    name: text(record.name, 200) || 'Moment',
    note: text(record.note, 1000),
    category: text(record.category, 60),
    kind: text(record.kind, 30),
  };
}

// The colour a moment's marker gets in the editing program: its category's
// colour, by the name Resolve knows it under, or '' if it has no category.
function colourNames() {
  const names = new Map(CATEGORY_COLOURS);
  return new Map(readCategories().map((category) => [category.name, names.get(category.colour) ?? '']));
}

function windowOf(event) {
  return BrowserWindow.fromWebContents(event.sender);
}

// The file or folder the last export wrote, for "Show in folder". It is kept
// here and not handed to the window, so the window cannot ask for any other
// place to be opened.
let lastExport = '';

ipcMain.handle('export:show', () => {
  if (!lastExport || !fs.existsSync(lastExport)) return;
  if (fs.statSync(lastExport).isDirectory()) shell.openPath(lastExport);
  else shell.showItemInFolder(lastExport);
});

// Stops the cutting of clips that is going on, if any.
ipcMain.handle('export:cancel', () => cancelClips());

// Writes the moments as markers for an editing program. `format` is
// 'resolve' (an EDL of markers) or 'premiere' (a timeline with the video on
// it and the markers above). Answers { saved: path }, { cancelled } or { error }.
ipcMain.handle('export:markers', async (event, videoPath, format, list) => {
  needVideoPath(videoPath);
  const moments = (Array.isArray(list) ? list : []).map(cleanExport).filter(Boolean);
  if (moments.length === 0) return { error: 'There are no moments to export.' };

  const base = path.join(path.dirname(videoPath), path.parse(videoPath).name);
  const choice = await dialog.showSaveDialog(windowOf(event), format === 'resolve'
    ? { defaultPath: base + ' markers.edl', filters: [{ name: 'Markers for DaVinci Resolve', extensions: ['edl'] }] }
    : { defaultPath: base + ' moments.xml', filters: [{ name: 'Timeline for Premiere Pro', extensions: ['xml'] }] });
  if (choice.canceled) return { cancelled: true };

  try {
    const video = await probeVideo(videoPath);
    const colours = colourNames();
    const text = format === 'resolve'
      ? resolveEdl(moments, video, colours)
      : premiereXml(moments, { ...video, path: videoPath }, colours);
    fs.writeFileSync(choice.filePath, text);
    lastExport = choice.filePath;
    return { saved: choice.filePath };
  } catch (error) {
    console.error('Could not export the markers:', error);
    return { error: 'The file could not be written.' };
  }
});

// Cuts each moment out of the video as its own file, without re-encoding.
// Answers { folder, count }, { cancelled } or { error }.
ipcMain.handle('export:clips', async (event, videoPath, list) => {
  needVideoPath(videoPath);
  const moments = (Array.isArray(list) ? list : []).map(cleanExport).filter(Boolean);
  if (moments.length === 0) return { error: 'There are no moments to export.' };

  const choice = await dialog.showOpenDialog(windowOf(event), {
    title: 'Choose a folder for the clips',
    defaultPath: path.dirname(videoPath),
    properties: ['openDirectory', 'createDirectory'],
  });
  if (choice.canceled) return { cancelled: true };

  try {
    const folder = await cutClips(videoPath, moments, choice.filePaths[0], (done) => {
      tellWindow('clips:progress', { done, total: moments.length });
    });
    lastExport = folder;
    return { folder, count: moments.length };
  } catch (error) {
    if (error.cancelled) return { cancelled: true };
    console.error('Could not cut the clips:', error);
    return { error: error.friendly ?? 'The clips could not be written to that folder.' };
  }
});

// Puts text on the clipboard, for pasting somewhere else.
ipcMain.handle('clipboard:write', (event, text) => {
  clipboard.writeText(String(text).slice(0, 200000));
});

// ---------- Updates ----------

// The installed app looks on its GitHub page for a newer version shortly
// after it starts and every few hours, downloads it in the background, and
// then offers "Restart to update". Left alone, the update goes in the next
// time Loudest is closed. The work is done by electron-updater. It reads
// where to look from app-update.yml, which the build puts beside the app
// (the "publish" lines in package.json), and it only takes an installer
// whose fingerprint matches the one in the release's latest.yml.
//
// `state` is one of: 'off' (this copy does not update itself), 'idle',
// 'checking', 'none' (nothing newer), 'downloading', 'ready', 'error'.
// `announce` tells the window to show what is new after an update
// (whats-new.js); like updating, that is for the installed app only.
let update = { state: 'off', version: app.getVersion(), announce: false };
let updater = null;

function setUpdate(changes) {
  update = { ...update, ...changes };
  tellWindow('update:status', update);
}

function updateFailed(error) {
  const text = String(error?.message ?? error);
  // Nothing released yet counts as being up to date, and so does a release
  // whose files are still on their way up (GitHub lists a new version a
  // little before its latest.yml is there).
  if (/no published versions|cannot find latest\.yml/i.test(text)) {
    setUpdate({ state: 'none', problem: undefined });
    return;
  }
  console.error('Could not update:', error);
  const offline = /ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ENETUNREACH|EAI_AGAIN|net::ERR_/i.test(text);
  setUpdate({ state: 'error', problem: offline ? 'Could not reach GitHub. Check the connection and try again.' : 'The update could not be fetched.' });
}

async function checkForUpdate() {
  // One that is on its way or waiting to go in is not asked for again.
  if (!updater || ['checking', 'downloading', 'ready'].includes(update.state)) return update;
  try {
    await updater.checkForUpdates();
  } catch (error) {
    updateFailed(error);
  }
  return update;
}

function startUpdates() {
  // A copy run from the source has no installer to put a newer one in its
  // place. And the tests, which name their own data folder, must never
  // install anything on this PC.
  if (!app.isPackaged || app.commandLine.hasSwitch('user-data-dir')) return;

  update.announce = true;
  updater = require('electron-updater').autoUpdater;
  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = true;
  updater.on('checking-for-update', () => setUpdate({ state: 'checking', problem: undefined }));
  updater.on('update-available', (info) => setUpdate({ state: 'downloading', available: info.version, percent: 0 }));
  updater.on('update-not-available', () => setUpdate({ state: 'none' }));
  updater.on('download-progress', (progress) => setUpdate({ state: 'downloading', percent: Math.round(progress.percent) }));
  updater.on('update-downloaded', (info) => setUpdate({ state: 'ready', available: info.version }));
  updater.on('error', updateFailed);

  setUpdate({ state: 'idle' });
  setTimeout(checkForUpdate, 15 * 1000);
  setInterval(checkForUpdate, 4 * 60 * 60 * 1000);
}

ipcMain.handle('update:status', () => update);
ipcMain.handle('update:check', () => checkForUpdate());

ipcMain.handle('update:install', () => {
  if (!updater || update.state !== 'ready') return;
  // The installer shows no window of its own and can take a minute; this
  // says what is going on meanwhile.
  if (Notification.isSupported()) {
    new Notification({
      title: `Updating Loudest to ${update.available}`,
      body: 'Loudest closes, installs the update and opens again by itself. That can take up to a minute.',
      silent: true,
    }).show();
  }
  // true, true: without the installer's window, and open Loudest again after.
  updater.quitAndInstall(true, true);
});

// ---------- The Help menu ----------

// Opens Loudest's page in the browser, or with a version, the page of that
// release. The address is written here, and from the window only a plain
// version number is taken, so nothing in the window can open any other address.
ipcMain.handle('app:github', (event, version) => {
  const page = 'https://github.com/ArChrisVa/Loudest';
  const release = typeof version === 'string' && /^\d+\.\d+\.\d+$/.test(version);
  return shell.openExternal(release ? `${page}/releases/tag/v${version}` : page);
});

// ---------- The window ----------

// The app draws its own menus in its top bar (index.html, menus.js), so the
// File / Edit / View menu that Electron adds by itself is switched off.
Menu.setApplicationMenu(null);

// The tests start the app with --test-window (tests\drive.js) while someone
// is using the PC. The window then opens off the edge of the screen, without
// taking the keyboard and without a button on the taskbar, so a test is
// never in anybody's face. Nothing else about the app changes.
const quietWindow = app.commandLine.hasSwitch('test-window');

// What the window needs at the normal size: how big it opens, the least it
// can be, and how tall the top bar is. Below the least width the buttons
// under the picture no longer fit between the two side panels. (From there
// up to about 1330 the volume slider is shorter; it is the one thing that
// gives way.) At a bigger size the window needs that many times more,
// because everything in it is drawn that much bigger.
const WINDOW_OPENS = { width: 1280, height: 760 };
const WINDOW_LEAST = { width: 1140, height: 560 };
const BAR_HEIGHT = 40;

// How big everything is drawn now, one of SIZES.
let sizeNow = 1;

// The sizes a screen has room for, given the part of it that windows may
// use ({ width, height }). The normal size always counts.
function sizesThatFit(area) {
  return SIZES.filter((size) => size === 1 || (WINDOW_LEAST.width * size <= area.width && WINDOW_LEAST.height * size <= area.height));
}

// Where the size stands, for the View menu: the size, and whether it can go
// either way from here on the screen the window is on.
function sizeStatus(win) {
  const fits = sizesThatFit(screen.getDisplayMatching(win.getBounds()).workAreaSize);
  return { size: sizeNow, bigger: fits.includes(SIZES[SIZES.indexOf(sizeNow) + 1]), smaller: sizeNow > 1 };
}

// Draws everything in the window at `size`. The window keeps showing as much
// as it did: it grows or shrinks by the same amount, as far as the screen
// allows, and so does the least it can be. A maximised window stays as it is.
function changeSize(win, size) {
  const before = sizeNow;
  sizeNow = size;
  win.webContents.setZoomFactor(size);
  win.setMinimumSize(Math.round(WINDOW_LEAST.width * size), Math.round(WINDOW_LEAST.height * size));
  // Minimise, maximise and close stay as tall as the bar they sit on.
  win.setTitleBarOverlay({ height: Math.round(BAR_HEIGHT * size) });
  if (win.isMaximized() || win.isFullScreen()) return;

  const bounds = win.getBounds();
  const area = screen.getDisplayMatching(bounds).workArea;
  const width = Math.min(area.width, Math.round((bounds.width * size) / before));
  const height = Math.min(area.height, Math.round((bounds.height * size) / before));
  // A window that has grown past the edge of the screen moves back onto it.
  // (The tests' window is off the screen on purpose, and stays there.)
  const x = quietWindow ? bounds.x : Math.max(area.x, Math.min(bounds.x, area.x + area.width - width));
  const y = quietWindow ? bounds.y : Math.max(area.y, Math.min(bounds.y, area.y + area.height - height));
  win.setBounds({ x, y, width, height });
}

// From View, Bigger text and its two neighbours: `way` is 'bigger',
// 'smaller' or 'normal'. Anything else changes nothing, which is how the
// window asks where the size stands. Answers { size, bigger, smaller }.
ipcMain.handle('size:change', (event, way) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const steps = { bigger: 1, smaller: -1 };
  const wanted = way === 'normal' ? 1 : SIZES[SIZES.indexOf(sizeNow) + (steps[way] ?? 0)];
  const fits = sizesThatFit(screen.getDisplayMatching(win.getBounds()).workAreaSize);
  if (wanted !== undefined && wanted !== sizeNow && fits.includes(wanted)) {
    changeSize(win, wanted);
    writeJson(settingsFile, { ...readSettings(), size: wanted });
  }
  return sizeStatus(win);
});

function createWindow() {
  // The size chosen last time, or the biggest one below it that this screen
  // has room for.
  const area = screen.getPrimaryDisplay().workAreaSize;
  sizeNow = sizesThatFit(area).filter((size) => size <= readSettings().size).at(-1);

  const win = new BrowserWindow({
    ...(quietWindow ? { show: false, x: -20000, y: -20000, skipTaskbar: true } : {}),
    width: Math.min(area.width, Math.round(WINDOW_OPENS.width * sizeNow)),
    height: Math.min(area.height, Math.round(WINDOW_OPENS.height * sizeNow)),
    minWidth: Math.round(WINDOW_LEAST.width * sizeNow),
    minHeight: Math.round(WINDOW_LEAST.height * sizeNow),
    // Shown in the taskbar. Built from __dirname so it is found no matter
    // which folder the app is started from.
    icon: path.join(__dirname, 'icon.ico'),
    // The colour of the window before the page has drawn, so it never
    // flashes white. The same as --base in styles.css.
    backgroundColor: '#0a0b0d',
    // No title bar from Windows: the app's top bar takes its place. Windows
    // still draws minimise, maximise and close itself, over the right end of
    // that bar, in these colours and at the bar's height.
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#0a0b0d', symbolColor: '#ecebe4', height: Math.round(BAR_HEIGHT * sizeNow) },
    webPreferences: { preload: path.join(__dirname, 'preload.js'), zoomFactor: sizeNow },
  });

  // Without this, dropping a file anywhere on the window makes Electron
  // navigate away from the app and show the file itself.
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  // Nothing in the app opens a second window, so nothing is allowed to.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  win.loadFile('index.html');
  // Shown, so that the page draws as usual, but not brought to the front.
  if (quietWindow) win.showInactive();
}

// The name Windows knows the app by. It is the same as the installer's, so
// the taskbar keeps the running app and its pinned shortcut together.
app.setAppUserModelId('com.loudest.app');

app.whenReady().then(() => {
  createWindow();
  startUpdates();
});

app.on('window-all-closed', () => {
  // Do not leave any of the helper programs running after the window is gone.
  closing = true;
  waiting.length = 0;
  stopListening();
  cancelDownload();
  cancelTranscribe();
  cancelClips();
  app.quit();
});

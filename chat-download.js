// Gets the chat of a stream from its link.
//
// The work is done by two free programs. Each is downloaded from its makers'
// page the first time it is needed and kept in the app's data folder:
//   yt-dlp               for YouTube   github.com/yt-dlp/yt-dlp
//   TwitchDownloaderCLI  for Twitch    github.com/lay295/TwitchDownloader
// They are not shipped with the app because both sites keep changing, and a
// copy that worked last month may not work today. When getting a chat fails
// and the copy here is more than a day old, the newest one is fetched and
// the chat is tried once more.

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readChatFile } = require('./chat');
const { download } = require('./download');

const ONE_DAY = 24 * 60 * 60 * 1000;

const ytDlp = {
  exe: 'yt-dlp.exe',
  async fetch(folder, signal) {
    // GitHub sends this address on to the newest version.
    const newest = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe';
    await download(newest, path.join(folder, this.exe), { signal });
  },
};

const twitchDownloader = {
  exe: 'TwitchDownloaderCLI.exe',
  async fetch(folder, signal) {
    // Its download has the version in its name, so ask GitHub what the newest one is called.
    const home = 'https://github.com/lay295/TwitchDownloader/releases/download/';
    const answer = await fetch('https://api.github.com/repos/lay295/TwitchDownloader/releases/latest', { signal });
    if (!answer.ok) throw new Error(`GitHub answered ${answer.status}`);
    const release = await answer.json();
    const wanted = release.assets?.find((asset) => /^TwitchDownloaderCLI-[\d.]+-Windows-x64\.zip$/.test(asset.name));
    // Only ever download from the project's own page, whatever the answer says.
    if (!wanted?.browser_download_url?.startsWith(home)) throw new Error('No Windows version of TwitchDownloaderCLI was found');

    const zip = path.join(folder, 'TwitchDownloaderCLI.zip');
    await download(wanted.browser_download_url, zip, { signal });
    // Windows comes with a program that unpacks zip files.
    const tar = path.join(process.env.SystemRoot, 'System32', 'tar.exe');
    const { code, output } = await run(tar, ['-xf', zip, '-C', folder, this.exe], signal);
    fs.rmSync(zip, { force: true });
    if (code !== 0) throw new Error('Could not unpack TwitchDownloaderCLI: ' + output);
  },
};

// Stops the download in progress, if there is one.
let stop = () => {};

function cancelDownload() {
  stop();
}

// An error whose text is fit to show to the editor. `final` marks one that a
// newer version of the helper program would not fix.
function friendly(text, final = false) {
  const error = new Error(text);
  error.friendly = text;
  error.final = final;
  return error;
}

// Runs a program and resolves with { code, output }: how it ended and the
// last part of what it printed. Rejects if it cannot be started, or when
// `signal` stops it.
function run(program, args, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { windowsHide: true, signal });
    let output = '';
    const note = (chunk) => {
      output = (output + chunk).slice(-20000);
    };
    child.stdout.on('data', note);
    child.stderr.on('data', note);
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, output }));
  });
}

// What the program itself said went wrong, to add to a message: the last
// line it marked as an error.
function reasonIn(output) {
  const said = [...output.matchAll(/^(?:ERROR:|\[ERROR\] -)\s*(.+)$/gm)].at(-1)?.[1];
  return said ? ` (${said.trim().slice(0, 200)})` : '';
}

// Makes sure the helper program is there, then lets `attempt(exe)` use it.
async function withTool(tool, folder, signal, attempt) {
  const exe = path.join(folder, tool.exe);
  const fetchIt = async () => {
    try {
      await tool.fetch(folder, signal);
      // Unpacking keeps the date the program was made; what matters here is when it was fetched.
      fs.utimesSync(exe, new Date(), new Date());
    } catch (error) {
      console.error(`Could not fetch ${tool.exe}:`, error);
      throw friendly('The program that downloads chats could not be fetched. Check the internet connection.', true);
    }
  };

  if (!fs.existsSync(exe)) await fetchIt();
  try {
    return await attempt(exe);
  } catch (error) {
    const old = Date.now() - fs.statSync(exe).mtimeMs > ONE_DAY;
    if (error.final || signal.aborted || !old) throw error;
    await fetchIt();
    return attempt(exe);
  }
}

async function youTubeChat(exe, link, work, signal) {
  const { output } = await run(exe, [
    '--ignore-config', // not the settings of a yt-dlp the editor may have of their own
    '--no-playlist',
    '--skip-download', // not the video
    '--write-subs', '--sub-langs', 'live_chat', // yt-dlp treats the chat as a kind of subtitle
    '-o', path.join(work, 'chat.%(ext)s'),
    link,
  ], signal);

  const file = path.join(work, 'chat.live_chat.json');
  if (!fs.existsSync(file)) {
    const none = /no subtitles for the requested languages/i.test(output);
    if (none) throw friendly('YouTube has no chat replay for this stream.', true);
    throw friendly('The chat could not be downloaded from YouTube.' + reasonIn(output));
  }
  return readChatFile(file);
}

async function twitchChat(exe, link, work, signal) {
  const file = path.join(work, 'chat.json');
  const { output } = await run(exe, [
    'chatdownload', '--id', link, '-o', file,
    '--collision', 'Overwrite', // or it would stop and ask
    '--banner=false',
  ], signal);

  if (!fs.existsSync(file)) {
    const gone = /deleted|expired/i.test(output);
    if (gone) throw friendly('Twitch no longer has this stream. It only keeps streams for a few weeks.', true);
    throw friendly('The chat could not be downloaded from Twitch.' + reasonIn(output));
  }
  return readChatFile(file);
}

// Downloads the chat of the stream at `address` (a URL) and resolves with
// its messages: [[seconds, text], ...]. The helper programs live in `toolsFolder`.
// Rejects with an error that has `cancelled` set if it was stopped, or
// `friendly` set to a sentence to show.
async function downloadChat(address, toolsFolder) {
  cancelDownload();
  const controller = new AbortController();
  const signal = controller.signal;
  stop = () => controller.abort();

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'loudest-chat-'));
  try {
    const link = address.href;
    if (/(^|\.)(youtube\.com|youtu\.be)$/.test(address.hostname)) {
      return await withTool(ytDlp, toolsFolder, signal, (exe) => youTubeChat(exe, link, work, signal));
    }
    if (/(^|\.)twitch\.tv$/.test(address.hostname)) {
      return await withTool(twitchDownloader, toolsFolder, signal, (exe) => twitchChat(exe, link, work, signal));
    }
    throw friendly('Only links to YouTube and Twitch streams work here.', true);
  } catch (error) {
    if (signal.aborted) error.cancelled = true;
    else if (!error.friendly && /No chat messages/.test(error.message)) throw friendly('The chat of this stream is empty.', true);
    throw error;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

module.exports = { downloadChat, cancelDownload };

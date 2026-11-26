// Runs inside the window before the page does. The page itself is not allowed
// to touch files or talk to main.js, so this hands it a small, fixed set of
// functions as `window.loudest`.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const ask = (channel) => (...details) => ipcRenderer.invoke(channel, ...details);
// For news that main.js sends without being asked, such as progress.
const hear = (channel) => (callback) => {
  ipcRenderer.on(channel, (event, details) => callback(details));
};

contextBridge.exposeInMainWorld('loudest', {
  // Where a chosen or dropped file lives on disk ('' if it is not a real file).
  pathForFile: (file) => webUtils.getPathForFile(file),

  // The videos on the Home screen.
  listRecent: ask('recent:list'),
  saveRecent: ask('recent:save'),
  removeRecent: ask('recent:remove'),

  // The editor's choices: { sensitivity, leadIn }.
  getSettings: ask('settings:get'),
  setSettings: ask('settings:set'),

  // The editor's own work on a video: kept and rejected moments, names,
  // notes, categories, where each starts and ends, and moments added by hand.
  // Saving answers with the categories now in use, each with its colour.
  loadMoments: ask('moments:load'),
  saveMoments: ask('moments:save'),
  listCategories: ask('categories:list'),
  // Every kept moment of every video.
  keptMoments: ask('moments:kept'),

  // Listening to videos. `listenNow` is for the video being opened and
  // answers when it has been listened to; `addToQueue` lines videos up.
  listenNow: ask('listen:now'),
  addToQueue: ask('queue:add'),
  queueStatus: ask('queue:status'),
  onListenProgress: hear('listen:progress'), // { path, seconds }
  onQueueChanged: hear('queue:changed'), // { listening, waiting }

  // The moments found in a video that has been listened to.
  findMoments: ask('moments:find'),
  // How loud the video is along its length: { level, seconds }.
  soundLevel: ask('sound:level'),

  // The stream's chat, from a link or from a file.
  guessChatLink: ask('chat:guessLink'),
  chatFromLink: ask('chat:fromLink'),
  chatFromFile: ask('chat:fromFile'),
  cancelChat: ask('chat:cancel'),
  removeChat: ask('chat:remove'),

  // What is said in the video, as text.
  canTranscribe: ask('transcript:possible'),
  loadTranscript: ask('transcript:load'),
  transcribe: ask('transcript:run'),
  cancelTranscribe: ask('transcript:cancel'),
  onTranscriptProgress: hear('transcript:progress'), // { path, step, fraction }

  // Getting the moments out to the editing program.
  exportMarkers: ask('export:markers'),
  exportClips: ask('export:clips'),
  onClipsProgress: hear('clips:progress'), // { done, total }
  copyText: ask('clipboard:write'),

  // Loudest's page, in the browser.
  openGitHub: ask('app:github'),

  // Newer versions. A status is { state, version, available, percent,
  // problem }; main.js explains the states. `checkForUpdate` answers with the
  // status after looking; `installUpdate` closes Loudest and puts in the one
  // that has been downloaded.
  updateStatus: ask('update:status'),
  checkForUpdate: ask('update:check'),
  installUpdate: ask('update:install'),
  onUpdate: hear('update:status'),
});

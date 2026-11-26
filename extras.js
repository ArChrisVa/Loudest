// What sits around the moments on the work screen: the tabs of the panel on
// the left with the stream's chat and the transcript, the settings, and
// getting the moments out to the editing program.

const chatButton = document.getElementById('chat-button');
const chatBox = document.getElementById('chat-box');
const chatNone = document.getElementById('chat-none');
const chatHave = document.getElementById('chat-have');
const chatLink = document.getElementById('chat-link');
const chatGet = document.getElementById('chat-get');
const chatFile = document.getElementById('chat-file');
const chatCount = document.getElementById('chat-count');
const chatStatus = document.getElementById('chat-status');
const chatLines = document.getElementById('chat-lines');
const leadInInput = document.getElementById('lead-in');
const exportBox = document.getElementById('export-box');
const exportWhich = [...document.querySelectorAll('#export-which button')];
const exportStatus = document.getElementById('export-status');
const exportShow = document.getElementById('export-show');
const exportCancel = document.getElementById('export-cancel');
const exportButtons = [...exportBox.querySelectorAll('[data-export]')];
const momentsTab = document.getElementById('tab-moments');
const transcriptTab = document.getElementById('tab-transcript');
const momentsPanel = document.getElementById('moments-panel');
const transcriptPanel = document.getElementById('transcript-panel');
const transcriptStart = document.getElementById('transcript-start');
const speechLanguage = document.getElementById('speech-language');
const transcribeButton = document.getElementById('transcribe');
const transcriptNote = document.getElementById('transcript-note');
const transcriptWorking = document.getElementById('transcript-working');
const transcriptStatus = document.getElementById('transcript-status');
const transcriptProgress = document.getElementById('transcript-progress');
const transcriptProblem = document.getElementById('transcript-problem');
const transcriptReady = document.getElementById('transcript-ready');
const transcriptSearch = document.getElementById('transcript-search');
const transcriptCount = document.getElementById('transcript-count');
const transcriptLines = document.getElementById('transcript-lines');

// The video whose chat is being downloaded, or '' when none is.
let gettingChatFor = '';

// What is said in the open video: { lines: [[start, end, text], ...] }, or
// null while it has not been written out.
let transcript = null;

// The video whose speech is being written out, or '' when none is.
let transcribing = '';

// Called by work.js when a video is opened.
async function showExtras() {
  const videoPath = openPath;
  chatStatus.textContent = '';
  chatLink.value = '';
  exportKept = true;
  exportSaid = '';
  exportShow.hidden = true;
  transcript = null;
  transcriptProblem.textContent = '';
  transcriptSearch.value = '';
  showSideTab(momentsTab);
  showChatBusy();
  showTranscript();

  const [link, saved] = await Promise.all([
    window.loudest.guessChatLink(videoPath),
    window.loudest.loadTranscript(videoPath),
  ]);
  if (videoPath !== openPath) return;
  chatLink.value = link;
  transcript = saved;
  showTranscript();
}

// ---------- The chat ----------

// Whether the open video has a chat, and the second of the video the lines
// on the Chat tab were last fetched for (null: fetch them again).
let chatLoaded = false;
let chatShownAt = null;

// Called by work.js whenever it learns whether the open video has a chat:
// `chat` is { count, ... } or null.
function showChat(chat) {
  chatNone.hidden = Boolean(chat);
  chatHave.hidden = !chat;
  // The button is lit while the video has a chat.
  chatButton.classList.toggle('on', Boolean(chat));
  if (chat) chatCount.textContent = countOf(chat.count.toLocaleString('en'), 'chat message');
  chatLoaded = Boolean(chat);
  chatShownAt = null;
  showChatLines();
}

// On the Chat tab: what the chat was writing around where the video is now,
// the way it scrolled past during the stream. What was written after this
// point is fainter. A click on a line goes to that time. Asked for once per
// second of video, and only while the tab is the one showing.
async function showChatLines() {
  // No chat, or the video has just been closed.
  if (!chatLoaded || !openPath) {
    chatLines.replaceChildren();
    return;
  }
  if (chatBox.hidden) return;
  const second = Math.floor(seekWanted ?? player.currentTime);
  if (second === chatShownAt) return;
  chatShownAt = second;
  const videoPath = openPath;
  const lines = await window.loudest.chatAround(videoPath, second);
  // An answer about another video, or about a second that has passed since.
  if (videoPath !== openPath || second !== chatShownAt) return;

  if (lines.length === 0) {
    const quiet = document.createElement('li');
    quiet.className = 'dim';
    quiet.textContent = 'The chat was quiet around here.';
    chatLines.replaceChildren(quiet);
    return;
  }
  chatLines.replaceChildren(...lines.map(([time, text]) => {
    const item = document.createElement('li');
    const row = document.createElement('button');
    const when = document.createElement('span');
    const said = document.createElement('span');
    row.type = 'button';
    row.className = time > second ? 'line later' : 'line';
    when.className = 'when';
    when.textContent = formatDuration(time);
    said.textContent = String(text).slice(0, 300);
    row.append(when, said);
    row.addEventListener('click', () => seekTo(time));
    item.append(row);
    return item;
  }));
  // The line the video has just reached stays in the middle of the list.
  const reached = chatLines.querySelectorAll('.line:not(.later)');
  const middle = reached[reached.length - 1] ?? chatLines.querySelector('.line');
  // (The list is what its rows are measured from: styles.css.)
  chatLines.scrollTop = middle.offsetTop - chatLines.clientHeight / 2;
}

player.addEventListener('timeupdate', showChatLines);
player.addEventListener('seeking', showChatLines);

// While a chat is on its way, the button that asked for it stops it.
function showChatBusy() {
  const busy = gettingChatFor === openPath && openPath !== '';
  chatGet.textContent = busy ? 'Cancel' : 'Get chat';
  chatLink.disabled = busy;
  if (busy) chatStatus.textContent = 'Getting the chat. A long stream takes a few minutes.';
}

chatGet.addEventListener('click', async () => {
  const videoPath = openPath;
  // While this video's chat is on its way, the same button stops it.
  if (gettingChatFor === videoPath) {
    window.loudest.cancelChat();
    return;
  }
  // One chat is fetched at a time: main.js drops a download that is still
  // going on for another video when this one starts.
  gettingChatFor = videoPath;
  showChatBusy();
  const outcome = await window.loudest.chatFromLink(videoPath, chatLink.value);
  if (gettingChatFor === videoPath) gettingChatFor = '';
  showChatBusy();
  if (videoPath !== openPath) return;
  chatStatus.textContent = outcome.error ?? '';
  if (outcome.count) findAgain();
});

chatLink.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') chatGet.click();
});

document.getElementById('chat-choose').addEventListener('click', () => chatFile.click());

chatFile.addEventListener('change', () => {
  const file = chatFile.files[0];
  chatFile.value = '';
  if (file) useChatFile(file);
});

// A chat file that was chosen, or dropped on the window.
async function useChatFile(file) {
  const videoPath = openPath;
  const chatPath = window.loudest.pathForFile(file);
  // Whatever comes of it is said on the Chat tab, so make sure that is showing.
  showSideTab(chatButton);
  if (!chatPath) {
    chatStatus.textContent = "That file can't be read from where it is. Save it to a folder on this PC first.";
    return;
  }
  const outcome = await window.loudest.chatFromFile(videoPath, chatPath);
  if (videoPath !== openPath) return;
  chatStatus.textContent = outcome.error ?? '';
  if (outcome.count) findAgain();
}

// The chat can take minutes to download, so it is not thrown away on one click.
document.getElementById('chat-remove').addEventListener('click', async () => {
  const yes = await askSure('Remove the chat?', `Its ${chatCount.textContent} are deleted from Loudest. You can get them again with the link or the file.`, 'Remove');
  if (!yes) return;
  await window.loudest.removeChat(openPath);
  chatStatus.textContent = '';
  findAgain();
});

// ---------- Settings ----------

leadInInput.addEventListener('change', async () => {
  settings = await window.loudest.setSettings({ leadIn: Number(leadInInput.value) });
  // What was typed comes back corrected if it was out of range.
  leadInInput.value = settings.leadIn;
  showMoments();
});

// ---------- Export ----------

// Which moments go out: the kept ones (true), or everything that was not
// rejected. The editor chooses at the top of the box; each video starts on
// the kept ones.
let exportKept = true;
// What the last export said. It stays in the box until the next one.
let exportSaid = '';
// True while clips are being cut.
let cutting = false;

// The moments that go out, in the order they happen, each with where it
// starts and ends.
function momentsToExport() {
  const list = moments.filter((moment) => (exportKept ? moment.status === 'kept' : moment.status !== 'rejected'));
  return list
    .map((moment) => ({
      ...rangeOf(moment),
      name: moment.name || (moment.kind === 'Added' ? 'Moment' : moment.signs.join(' + ')),
      note: moment.note,
      category: moment.category,
      kind: moment.kind,
    }))
    .sort((a, b) => a.start - b.start);
}

// Brings the box up to date: which of the two choices is lit and how many
// moments each holds, whether there is anything to send out, and what the
// last export said.
function showExport() {
  const kept = moments.filter((moment) => moment.status === 'kept').length;
  const notRejected = moments.filter((moment) => moment.status !== 'rejected').length;
  for (const button of exportWhich) {
    const forKept = button.dataset.which === 'kept';
    button.setAttribute('aria-pressed', forKept === exportKept);
    button.querySelector('em').textContent = forKept ? kept : notRejected;
  }
  const nothing = (exportKept ? kept : notRejected) === 0;
  for (const button of exportButtons) button.disabled = nothing || cutting;
  if (!nothing) exportStatus.textContent = exportSaid;
  else if (exportKept && notRejected > 0) exportStatus.textContent = 'Nothing is kept yet. Keep a moment first, or choose "Everything not rejected".';
  else exportStatus.textContent = 'No moments to export yet.';
  exportCancel.hidden = !cutting;
}

// Before it opens, so it is never seen out of date.
exportBox.addEventListener('beforetoggle', (event) => {
  if (event.newState === 'open') showExport();
});

for (const button of exportWhich) {
  button.addEventListener('click', () => {
    exportKept = button.dataset.which === 'kept';
    showExport();
  });
}

// For pasting under a YouTube video: one line per moment, "1:02:03 Name".
function timestampText(list) {
  const lines = list.map((moment) => `${formatDuration(moment.start)} ${moment.name}`);
  // YouTube only turns the list into chapters if it starts at 0:00.
  if (list[0].start >= 1) lines.unshift('0:00:00 Start');
  return lines.join('\n');
}

const SAID_AFTER_EXPORT = {
  resolve: 'Saved. In Resolve, right-click the timeline in the Media Pool, then Timelines › Import › Timeline Markers from EDL.',
  premiere: 'Saved. In Premiere, use File › Import and pick this file.',
};

for (const button of exportButtons) {
  button.addEventListener('click', async () => {
    const format = button.dataset.export;
    const list = momentsToExport();

    exportShow.hidden = true;
    if (format === 'timestamps') {
      await window.loudest.copyText(timestampText(list));
      exportSaid = 'Copied. Paste it under the video on YouTube.';
      showExport();
      return;
    }

    exportSaid = format === 'clips' ? 'Choose a folder for the clips…' : '';
    showExport();
    const outcome = format === 'clips'
      ? await window.loudest.exportClips(openPath, list)
      : await window.loudest.exportMarkers(openPath, format, list);
    // Cancelled: at the question where to save (nothing to say), or with
    // the Cancel button while the clips were being cut.
    if (outcome.cancelled) exportSaid = cutting ? 'Cancelled.' : '';
    else if (outcome.error) exportSaid = outcome.error;
    else exportSaid = format === 'clips' ? `${countOf(outcome.count, 'clip')} saved.` : SAID_AFTER_EXPORT[format];
    cutting = false;
    // What was written can be shown in its folder (main.js remembers where it is).
    exportShow.hidden = Boolean(outcome.cancelled || outcome.error);
    showExport();
  });
}

window.loudest.onClipsProgress(({ done, total }) => {
  cutting = true;
  exportSaid = `Cutting clip ${done + 1} of ${total}…`;
  showExport();
});

exportShow.addEventListener('click', () => window.loudest.showExport());
exportCancel.addEventListener('click', () => window.loudest.cancelClips());

// ---------- The transcript ----------

// The tabs of the panel on the left, each with what it shows.
const SIDE_TABS = [[momentsTab, momentsPanel], [chatButton, chatBox], [transcriptTab, transcriptPanel]];

function showSideTab(chosen) {
  for (const [tab, panel] of SIDE_TABS) {
    tab.setAttribute('aria-pressed', tab === chosen);
    panel.hidden = tab !== chosen;
  }
  // The Chat tab's lines are only kept up while it is showing.
  chatShownAt = null;
  showChatLines();
}

for (const [tab] of SIDE_TABS) tab.addEventListener('click', () => showSideTab(tab));

// Shows whichever fits: the button that starts the writing out, how far it
// has got, or the text itself.
function showTranscript() {
  const busy = transcribing === openPath && openPath !== '';
  transcriptStart.hidden = Boolean(transcript) || busy;
  transcriptWorking.hidden = !busy;
  transcriptReady.hidden = !transcript;
  // One video at a time: it takes all the power the PC can spare.
  transcribeButton.disabled = transcribing !== '';
  transcriptNote.textContent = transcribing
    ? 'Another video is being written out. This one can start when that is done.'
    : 'Takes a while for a long video. You can keep working meanwhile.';
  if (transcript) showLines();
}

// Text as it is compared when searching: no capitals, no accents, and the
// two Greek ways of writing "s" taken as one.
function plain(text) {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replaceAll('ς', 'σ');
}

// Lists what was said, one row per sentence or so. Clicking a row goes there.
function showLines() {
  transcriptLines.replaceChildren(...transcript.lines.map(([start, , text]) => {
    const item = document.createElement('li');
    const row = document.createElement('button');
    const when = document.createElement('span');
    const said = document.createElement('span');

    row.type = 'button';
    row.className = 'line';
    when.className = 'when';
    when.textContent = formatDuration(start);
    said.textContent = text;
    row.append(when, said);
    row.addEventListener('click', () => {
      seekTo(start);
      play();
    });
    item.dataset.plain = plain(text);
    item.append(row);
    return item;
  }));
  searchTranscript();
}

// Leaves only the rows that hold what is typed in the search box.
function searchTranscript() {
  const wanted = plain(transcriptSearch.value.trim());
  let found = 0;
  for (const item of transcriptLines.children) {
    item.hidden = !item.dataset.plain.includes(wanted);
    if (!item.hidden) found += 1;
  }
  transcriptCount.textContent = wanted ? countOf(found, 'place') : '';
}

transcriptSearch.addEventListener('input', searchTranscript);

// The language is remembered: an editor's videos are usually all in the same one.
speechLanguage.addEventListener('change', async () => {
  settings = await window.loudest.setSettings({ language: speechLanguage.value });
  speechLanguage.blur();
});

transcribeButton.addEventListener('click', async () => {
  const videoPath = openPath;
  transcribing = videoPath;
  transcriptProblem.textContent = '';
  transcriptStatus.textContent = 'Starting…';
  transcriptProgress.removeAttribute('value');
  showTranscript();

  const outcome = await window.loudest.transcribe(videoPath);
  transcribing = '';
  if (videoPath === openPath) {
    if (outcome.lines) transcript = outcome;
    transcriptProblem.textContent = outcome.error ?? '';
  }
  showTranscript();
});

document.getElementById('transcribe-cancel').addEventListener('click', () => window.loudest.cancelTranscribe());

window.loudest.onTranscriptProgress(({ path, step, fraction }) => {
  if (path !== openPath) return;
  const percent = Math.floor(fraction * 100) + '%';
  transcriptStatus.textContent = step === 'model'
    ? `Downloading what it needs to understand speech (only this once)… ${percent}`
    : `Writing out what is said… ${percent}`;
  transcriptProgress.value = fraction;
});

// ---------- Starting up ----------

window.loudest.canTranscribe().then((possible) => {
  transcriptTab.hidden = !possible;
});

window.loudest.getSettings().then((saved) => {
  settings = saved;
  sensitivitySlider.value = saved.sensitivity;
  leadInInput.value = saved.leadIn;
  speechLanguage.value = saved.language;
  skipStep.value = saved.skip;
  sortSelect.value = saved.sort;
  nameSkipButtons();
});

showHome();

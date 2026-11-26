// The Home screen: the videos that were opened before, the moments kept in
// them, and opening videos. Also the few helpers every screen uses.

const fileInput = document.getElementById('file');
const home = document.getElementById('home');
const homeMessage = document.getElementById('home-message');
const recentTab = document.getElementById('tab-recent');
const keptTab = document.getElementById('tab-kept');
const recentList = document.getElementById('recent');
const cardTemplate = document.getElementById('card-template');
const keptView = document.getElementById('kept');
const keptCategory = document.getElementById('kept-category');
const keptEmpty = document.getElementById('kept-empty');
const keptGroups = document.getElementById('kept-groups');
const work = document.getElementById('work');
const sure = document.getElementById('sure');
const sureYes = document.getElementById('sure-yes');

const ONE_DAY = 24 * 60 * 60 * 1000;

// Turns a number of days into "today", "yesterday" or "3 days ago".
const daysAgo = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

// Which videos are being listened to: { listening: a path or null, waiting: [paths] }.
let queue = { listening: null, waiting: [] };

// The cards on screen, by the path of their video: { entry, meta }, where
// `meta` is the line of small text under the title.
const cards = new Map();

// ---------- Helpers ----------

// Whole calendar days from `from` to `to`: 0 for the same day, -1 for the day before.
function daysBetween(from, to) {
  const startOfDay = (time) => new Date(time).setHours(0, 0, 0, 0);
  return Math.round((startOfDay(to) - startOfDay(from)) / ONE_DAY);
}

// 33164.8 seconds becomes "9:12:44": what a clock shows at that point, so
// never rounded up. Every time in the app is written this way, which keeps a
// moment's time in the list the same as the player's clock when it is there.
function formatDuration(seconds) {
  const whole = Math.floor(seconds);
  const hours = Math.floor(whole / 3600);
  const minutes = String(Math.floor(whole / 60) % 60).padStart(2, '0');
  const rest = String(whole % 60).padStart(2, '0');
  return `${hours}:${minutes}:${rest}`;
}

// 1 becomes "1 moment", 3 becomes "3 moments".
function countOf(number, word) {
  return `${number} ${word}${number === 1 ? '' : 's'}`;
}

// One of the icons drawn at the top of index.html, by its name.
function iconOf(name) {
  const SVG = 'http://www.w3.org/2000/svg';
  const icon = document.createElementNS(SVG, 'svg');
  const use = document.createElementNS(SVG, 'use');
  icon.setAttribute('class', 'icon');
  icon.setAttribute('aria-hidden', 'true');
  use.setAttribute('href', '#i-' + name);
  icon.append(use);
  return icon;
}

// A round mark in a category's colour.
function dotFor(colour) {
  const dot = document.createElement('i');
  dot.className = 'dot';
  dot.style.background = colour;
  return dot;
}

// Asks before something is deleted, in a card in the middle of the window:
// a question, a line about what is lost, and the word on the button that
// goes ahead. Answers true only when that button is pressed; Cancel, Escape
// and a click beside the card all mean no. The keyboard starts on Cancel.
function askSure(title, text, yes) {
  document.getElementById('sure-title').textContent = title;
  document.getElementById('sure-text').textContent = text;
  sureYes.textContent = yes;
  sure.returnValue = '';
  sure.showModal();
  return new Promise((resolve) => {
    sure.addEventListener('close', () => resolve(sure.returnValue === 'yes'), { once: true });
  });
}
sureYes.addEventListener('click', () => sure.close('yes'));
document.getElementById('sure-no').addEventListener('click', () => sure.close(''));

// ---------- The two views of the Home screen ----------

async function showHome() {
  closeVideo();
  work.hidden = true;
  home.hidden = false;
  document.title = 'Loudest';
  await (keptView.hidden ? showCards() : showKept());
}

function showTab(kept) {
  recentTab.setAttribute('aria-pressed', !kept);
  keptTab.setAttribute('aria-pressed', kept);
  recentList.hidden = kept;
  keptView.hidden = !kept;
  if (kept) showKept();
  else showCards();
}

// ---------- Recent VODs ----------

async function showCards() {
  const [entries, status] = await Promise.all([window.loudest.listRecent(), window.loudest.queueStatus()]);
  queue = status;
  cards.clear();
  for (const card of recentList.querySelectorAll('.card')) card.remove();
  for (const entry of entries) recentList.append(buildCard(entry));
  // With no video yet the tile is drawn large, in the middle (styles.css).
  recentList.classList.toggle('empty', entries.length === 0);
}

function buildCard(entry) {
  const card = cardTemplate.content.firstElementChild.cloneNode(true);
  const open = card.querySelector('.card-open');
  const picture = card.querySelector('img');
  const meta = card.querySelector('.card-meta');
  const remove = card.querySelector('.card-remove');

  card.querySelector('.card-title').textContent = entry.name;
  open.title = entry.path;
  if (entry.duration) card.querySelector('.dur').textContent = formatDuration(entry.duration);
  if (entry.thumbnail) picture.src = entry.thumbnail;
  else picture.hidden = true;

  meta.textContent = metaText(entry);
  cards.set(entry.path, { entry, meta });
  if (entry.missing) {
    card.classList.add('missing');
    open.disabled = true;
  } else {
    open.addEventListener('click', () => openVideo(entry.path));
  }

  remove.setAttribute('aria-label', `Remove ${entry.name} from this list`);
  remove.addEventListener('click', async () => {
    // Removing a video also deletes the editor's work on it, so ask first when there is some.
    if (entry.saved > 0) {
      const lost = entry.kept > 0 ? `Its ${countOf(entry.kept, 'kept moment')} ${entry.kept === 1 ? 'goes' : 'go'}` : 'Your work on it goes';
      const yes = await askSure(`Remove "${entry.name}"?`, `${lost} with it. The video file itself stays on your PC.`, 'Remove');
      if (!yes) return;
    }
    await window.loudest.removeRecent(entry.path);
    showCards();
  });

  return card;
}

// The small text under a card's title: what is happening to the video now,
// or else how far the editor is with it, or else when it was last opened. `heard` is how many seconds of it have
// been listened to so far, when that is known.
function metaText(entry, heard) {
  if (entry.missing) return 'File not found. It was moved, renamed or deleted.';
  if (queue.listening === entry.path) {
    const known = heard !== undefined && entry.duration > 0;
    return known ? `Listening… ${Math.min(99, Math.floor((heard / entry.duration) * 100))}%` : 'Listening…';
  }
  if (queue.waiting.includes(entry.path)) return 'Waiting to be listened to';
  // toReview is there once the video has been open with its moments found.
  if (entry.kept && entry.toReview === 0) return `${entry.kept} kept · all reviewed`;
  if (entry.kept && entry.toReview) return `${entry.kept} kept · ${entry.toReview} to review`;
  const opened = 'Opened ' + daysAgo.format(daysBetween(Date.now(), entry.lastOpened), 'day');
  if (entry.kept) return `${opened} · ${entry.kept} kept`;
  return entry.toReview ? `${opened} · ${entry.toReview} to review` : opened;
}

window.loudest.onQueueChanged((status) => {
  queue = status;
  for (const { entry, meta } of cards.values()) meta.textContent = metaText(entry);
});

window.loudest.onListenProgress(({ path, seconds }) => {
  const card = cards.get(path);
  if (card) card.meta.textContent = metaText(card.entry, seconds);
});

// ---------- Kept moments ----------

// Every kept moment of every video, under the name of its video. Clicking
// one opens the video at that moment.
async function showKept() {
  const [kept, known] = await Promise.all([window.loudest.keptMoments(), window.loudest.listCategories()]);

  // The menu of categories, keeping what was chosen if it is still there.
  const chosen = known.some((category) => category.name === keptCategory.value) ? keptCategory.value : '';
  keptCategory.replaceChildren(
    new Option('All categories', ''),
    ...known.map((category) => new Option(category.name, category.name)),
  );
  keptCategory.value = chosen;
  keptCategory.hidden = known.length === 0;

  const groups = new Map(); // video path -> its kept moments
  for (const moment of kept) {
    if (chosen && moment.category !== chosen) continue;
    if (!groups.has(moment.path)) groups.set(moment.path, []);
    groups.get(moment.path).push(moment);
  }
  const colourOfCategory = (name) => known.find((category) => category.name === name)?.colour || '';

  keptEmpty.hidden = groups.size > 0;
  keptGroups.replaceChildren(...[...groups.values()].map((moments) => {
    const group = document.createElement('section');
    const heading = document.createElement('h2');
    const list = document.createElement('ol');
    heading.textContent = moments[0].video;
    if (moments[0].missing) heading.textContent += ' (file not found)';

    for (const moment of moments) {
      const item = document.createElement('li');
      const row = document.createElement('button');
      const when = document.createElement('span');
      const label = document.createElement('span');
      const note = document.createElement('span');

      row.type = 'button';
      row.className = 'kept-row';
      row.disabled = moment.missing;
      when.className = 'when';
      when.textContent = formatDuration(moment.time);
      label.className = 'label';
      if (moment.category) label.append(dotFor(colourOfCategory(moment.category)));
      label.append(moment.name || moment.category || moment.kind);
      note.className = 'note';
      note.textContent = moment.note;

      row.append(when, label, note);
      row.addEventListener('click', () => openVideo(moment.path, moment.time));
      item.append(row);
      list.append(item);
    }
    group.append(heading, list);
    return group;
  }));
}

// ---------- Opening videos ----------

function isVideoFile(file) {
  return file.type.startsWith('video/') || file.name.toLowerCase().endsWith('.mkv');
}

// Files that were just chosen or dropped. One video is opened straight away.
// Several are put on the Home screen and listened to one after the other, so
// they are ready when the editor gets to them.
async function openFiles(files) {
  const paths = [];
  for (const file of files) {
    const videoPath = isVideoFile(file) ? window.loudest.pathForFile(file) : '';
    if (videoPath) paths.push(videoPath);
    else if (isVideoFile(file)) homeMessage.textContent = `"${file.name}" can't be opened from where it is. Save it to a folder on this PC first.`;
    else homeMessage.textContent = `"${file.name}" is not a video file. Choose an MP4 or MKV.`;
  }
  if (paths.length === 0) return;
  if (paths.length === 1) {
    openVideo(paths[0]);
    return;
  }

  const entries = [];
  for (const videoPath of paths) entries.push(await window.loudest.saveRecent({ path: videoPath }));
  await window.loudest.addToQueue(paths);
  await showHome();
  // One at a time: each needs a player of its own for a moment.
  for (const entry of entries) {
    if (!entry.missing && !entry.thumbnail && !entry.duration) await rememberDetails(entry);
  }
}

// Shows a video on the work screen and marks it as opened now. With
// `atTime`, it goes straight to the saved moment at that time.
async function openVideo(videoPath, atTime) {
  const entry = await window.loudest.saveRecent({ path: videoPath });
  homeMessage.textContent = '';

  if (entry.missing) {
    homeMessage.textContent = `"${entry.name}" is no longer where it was.`;
    showHome();
    return;
  }

  document.title = entry.name + ' - Loudest';
  home.hidden = true;
  work.hidden = false;
  showVideo(entry, atTime);

  // First time this video is opened (or the last attempt did not finish).
  if (!entry.thumbnail && !entry.duration) rememberDetails(entry);
}

// Reads the video's length and grabs one frame as its picture on the Home
// screen. It uses a second, invisible player so the one on screen is left
// alone. Resolves when it is done, whether or not it worked.
function rememberDetails(entry) {
  return new Promise((resolve) => {
    const probe = document.createElement('video');

    async function finish(details) {
      probe.removeAttribute('src');
      probe.load();
      if (details) {
        await window.loudest.saveRecent({ path: entry.path, ...details });
        // If the cards are on screen, show the new picture.
        if (!home.hidden && !recentList.hidden) await showCards();
      }
      resolve();
    }

    probe.addEventListener('loadedmetadata', () => {
      if (probe.videoWidth === 0) {
        // Sound only: there is no picture to grab.
        finish({ duration: probe.duration });
        return;
      }
      // A tenth of the way in, to get past a "starting soon" screen.
      probe.currentTime = Number.isFinite(probe.duration) ? probe.duration * 0.1 : 0;
    });

    probe.addEventListener('seeked', () => {
      const canvas = document.createElement('canvas');
      canvas.width = 320;
      canvas.height = Math.round((320 * probe.videoHeight) / probe.videoWidth);
      canvas.getContext('2d').drawImage(probe, 0, 0, canvas.width, canvas.height);
      finish({ duration: probe.duration, thumbnail: canvas.toDataURL('image/jpeg', 0.7) });
    });

    probe.addEventListener('error', () => finish(null));

    probe.muted = true;
    probe.src = entry.url;
  });
}

// ---------- Wiring ----------

recentTab.addEventListener('click', () => showTab(false));
keptTab.addEventListener('click', () => showTab(true));
keptCategory.addEventListener('change', showKept);

document.getElementById('back').addEventListener('click', showHome);
document.getElementById('open-video').addEventListener('click', () => fileInput.click());
document.getElementById('add-videos').addEventListener('click', () => fileInput.click());

fileInput.addEventListener('change', () => {
  const files = [...fileInput.files];
  // Cleared so that choosing the same file twice in a row still counts as a change.
  fileInput.value = '';
  openFiles(files);
});

// Dropping videos anywhere on the window opens them. While a video is open,
// a dropped file that is not a video is taken to be its chat. While files
// are held over the window its edge is amber (styles.css), which says so.
window.addEventListener('dragover', (event) => {
  event.preventDefault();
  if (event.dataTransfer.types.includes('Files')) document.body.classList.add('dropping');
});
// Fires for every element the mouse leaves; with nothing entered next, it
// has left the window.
window.addEventListener('dragleave', (event) => {
  if (!event.relatedTarget) document.body.classList.remove('dropping');
});
window.addEventListener('drop', (event) => {
  event.preventDefault();
  document.body.classList.remove('dropping');
  const files = [...event.dataTransfer.files];
  if (!work.hidden && files.length === 1 && !isVideoFile(files[0])) useChatFile(files[0]);
  else openFiles(files);
});

// The work screen: the open video and its moments. Finding them, listing
// them, and what the editor does with them: keep, reject, name, sort into
// categories, note, and set where each starts and ends.

const workTitle = document.getElementById('work-title');
const momentCount = document.getElementById('moment-count');
const showSelect = document.getElementById('show');
const sortSelect = document.getElementById('sort');
const chatOption = document.getElementById('chat-option');
const categoryOptions = document.getElementById('category-options');
const sensitivitySlider = document.getElementById('sensitivity');
const analysisStatus = document.getElementById('analysis-status');
const analysisProgress = document.getElementById('analysis-progress');
const saveProblem = document.getElementById('save-problem');
const momentList = document.getElementById('moment-list');
const inspector = document.getElementById('inspector');
const inspectorKind = document.getElementById('inspector-kind');
const keepButton = document.getElementById('keep');
const rejectButton = document.getElementById('reject');
const nameInput = document.getElementById('moment-name');
const categoryInput = document.getElementById('moment-category');
const categoryNames = document.getElementById('category-names');
const noteInput = document.getElementById('moment-note');
const startButton = document.getElementById('set-start');
const endButton = document.getElementById('set-end');
const startInput = document.getElementById('start-time');
const endInput = document.getElementById('end-time');
const resetRange = document.getElementById('reset-range');
const momentSearch = document.getElementById('moment-search');
const listeningBox = document.getElementById('listening');
const listeningPercent = document.getElementById('listening-percent');
const listeningLeft = document.getElementById('listening-left');
const momentContext = document.getElementById('moment-context');
const rangeLength = document.getElementById('range-length');
const statusButtons = [...document.querySelectorAll('#show-status button')];
const showOnly = document.getElementById('show-only');
const inspectorEmpty = document.getElementById('inspector-empty');
const removedLine = document.getElementById('removed-line');
const rejectLabels = [document.getElementById('reject-label'), document.getElementById('moment-menu-reject'), document.getElementById('context-reject')];
const timelineSelected = document.getElementById('timeline-selected');

// Goes up every time a video is opened or closed, so an answer that arrives
// late for an earlier video can be recognised and ignored.
let run = 0;

// 'listening' while the video's sound is being gone through, then 'done' or 'failed'.
let listenState = 'done';

// The video that is open, or '' on the Home screen.
let openPath = '';

// Every moment of the open video, found by the app or added by hand:
//   time, until   where the thing itself happens, in seconds
//   kind          why it is there: 'Laugh', 'Scream', 'Shout', 'Raised voice',
//                 'Chat', or 'Added' by the editor
//   signs         every reason it is there, the strongest first
//   strength      from 0 to 1, compared with the strongest moment
//   status        '' (not decided), 'kept' or 'rejected'
//   name, category, note   the editor's own words about it
//   start, end    where the editor put its start and end; null where they did not
let moments = [];

// The moment the box under the list is about, or null.
let selected = null;
// True right after a moment of the editor's own was removed, while "Undo" is on offer.
let removed = false;
// Further moments picked in the list with Ctrl or Shift and a click. Keep,
// Reject and Take the decision back then go for all of them and the selected one.
const picked = new Set();

// Which moments the list shows by how far they are decided: 'all', 'review',
// 'kept' or 'rejected'. The kind or category is in the hidden "show" menu,
// and the two work together.
let showStatus = 'all';

// What the moments were before each of the editor's last changes, newest
// last, for Undo; and what Undo took back, for Redo.
let undoSteps = [];
let redoSteps = [];

// True from opening a video that already holds decisions until its moments
// are all there: the list then opens on what is still to review.
let resume = false;
// When the listening's first report came, and how far it was: for saying how long is left.
let listenStart = null;
// How many moments were still to review when that was last noted for the Home screen.
let notedToReview = null;

// Every category in use, in any video: [{ name, colour }].
let categories = [];

// The editor's choices. extras.js reads the saved ones when the app starts.
//   sensitivity   from 0 (only the clearest moments) to 1 (weak ones too)
//   leadIn        how many seconds before a moment it starts
let settings = { sensitivity: 0.5, leadIn: 5 };

// ---------- Opening and closing a video ----------

function showVideo(entry, atTime) {
  message.textContent = '';
  workTitle.textContent = entry.name;
  openPath = entry.path;
  player.src = entry.url;
  timeline.setVideo(entry.url);
  setPictureSource(entry.url);
  loadMoments(entry.path, atTime);
  showExtras();
}

// Lets go of the video. Listening to it carries on in the background.
function closeVideo() {
  player.pause();
  player.removeAttribute('src');
  player.load();
  timeline.setVideo('');
  setPictureSource('');
  run += 1;
  openPath = '';
}

// Fills the list beside the player. The editor's own work is there at once.
// What the app finds joins it when the listening is done, which takes a
// while the first time a video is opened.
async function loadMoments(videoPath, atTime) {
  run += 1;
  const thisRun = run;

  moments = [];
  selected = null;
  removed = false;
  picked.clear();
  undoSteps = [];
  redoSteps = [];
  // What the list was narrowed to for the last video means nothing for this one.
  showStatus = 'all';
  showSelect.value = '';
  momentSearch.value = '';
  resume = false;
  notedToReview = null;
  listenStart = null;
  listenState = 'listening';
  saveProblem.textContent = '';
  analysisStatus.textContent = '';
  listeningPercent.textContent = '';
  listeningLeft.textContent = 'Listening to the whole video…';
  listeningBox.hidden = false;
  // Without a value the bar shows "busy" instead of an amount.
  analysisProgress.removeAttribute('value');
  analysisProgress.hidden = false;
  showMoments();

  const [saved, known] = await Promise.all([
    window.loudest.loadMoments(videoPath),
    window.loudest.listCategories(),
  ]);
  if (thisRun !== run) return;
  moments = saved.map((record) => ({ ...record, until: record.time, signs: [record.kind], strength: 0 }));
  categories = known;
  showCategories();

  // Arriving from the list of kept moments: go straight to the one clicked.
  const wanted = moments.find((moment) => moment.time === atTime);
  // Coming back to a video that was being worked on: carry on with what is
  // still to review, once the moments are all there (findAgain).
  resume = !wanted && saved.some((record) => record.status);
  if (resume) showStatus = 'review';
  showMoments();
  if (wanted) jumpTo(wanted);

  // A chat that was saved earlier can point at moments before the listening is done.
  findAgain();
  const outcome = await window.loudest.listenNow(videoPath);
  if (thisRun !== run) return;

  analysisProgress.hidden = true;
  listeningBox.hidden = true;
  listenState = outcome.error ? 'failed' : 'done';
  analysisStatus.textContent = outcome.error ?? '';
  findAgain();

  // The Sound lane of the timeline: how loud the video is along its length.
  const sound = await window.loudest.soundLevel(videoPath).catch(() => null);
  if (sound && thisRun === run) timeline.setSound(sound.level, sound.seconds);
}

// While the open video is being listened to: how far it has got.
window.loudest.onListenProgress(({ path, seconds }) => {
  if (path !== openPath || listenState !== 'listening') return;
  const total = player.duration;
  if (Number.isFinite(total) && total > 0) {
    analysisProgress.max = total;
    analysisProgress.value = Math.min(seconds, total);
    listeningPercent.textContent = Math.min(99, Math.floor((seconds / total) * 100)) + '%';
    // How long is left, worked out from how fast it has gone since the
    // first report. Said only once there are a few seconds to judge by.
    listenStart ??= { at: Date.now(), seconds };
    const taken = (Date.now() - listenStart.at) / 1000;
    const speed = (seconds - listenStart.seconds) / taken;
    if (taken > 3 && speed > 0) {
      const left = (total - seconds) / speed;
      listeningLeft.textContent = left < 90 ? 'Listening · about a minute left' : `Listening · about ${Math.round(left / 60)} minutes left`;
    }
  }
});

// ---------- Finding the moments ----------

let finding = false;
let findWanted = false;

// Asks for the open video's moments and joins them with the editor's work.
// Called when the listening is done and whenever the chat or the slider
// changes. Only one question is out at a time; anything asked meanwhile is
// answered by asking once more afterwards.
async function findAgain() {
  findWanted = true;
  if (finding) return;
  finding = true;
  while (findWanted) {
    findWanted = false;
    const thisRun = run;
    const found = await window.loudest.findMoments(openPath, settings.sensitivity).catch(() => null);
    // No answer, or an answer about a video that has been closed since.
    if (!found || thisRun !== run) continue;

    joinFound(found.moments);
    timeline.setQuiet(found.quiet);
    timeline.setChat(found.chat?.density ?? []);
    // The menu offers "Chat" only when there is one.
    chatOption.hidden = !found.chat;
    chatOption.disabled = !found.chat;
    // The Audio lane says that the green hills in it are the chat.
    document.getElementById('chat-lane-name').hidden = !found.chat;
    if (!found.chat && showSelect.value === chatOption.value) showSelect.value = '';
    showChat(found.chat);
    showMoments();

    // Back in a video that was being worked on, with every moment there now:
    // the first one that is still to review, ready but not playing.
    if (resume && listenState === 'done') {
      resume = false;
      const first = visibleMoments()[0];
      if (first) {
        select(first);
        seekTo(rangeOf(first).start);
      } else {
        // Nothing is left to review: show everything instead of an empty list.
        showStatus = 'all';
        showMoments();
      }
    }
  }
  finding = false;
}

// True for a moment the editor has done something with. Only these are saved;
// the rest is found again from what was heard.
function isTouched(moment) {
  return moment.kind === 'Added' || Boolean(moment.status || moment.name || moment.category || moment.note)
    || moment.start !== null || moment.end !== null;
}

// Joins what the app found with the editor's work. A found moment that the
// editor already kept, rejected or named is the same moment: it keeps the
// editor's decisions and takes the app's fresh label and strength. They are
// matched by time: the editor's moment has to lie inside the found one, give
// or take a few seconds.
function joinFound(found) {
  const SAME_MOMENT = 7; // seconds
  // What nobody touched makes way for what is found now. The selected moment
  // is given the chance to be found again, so the box under the list does
  // not close just because the slider moved.
  const staying = moments.filter((moment) => isTouched(moment) || moment === selected);
  const unmatched = new Set(staying.filter((moment) => moment.kind !== 'Added'));
  const fresh = [];

  for (const moment of found) {
    const gapTo = (candidate) => Math.max(moment.time - candidate.time, candidate.time - moment.until, 0);
    let match = null;
    for (const candidate of unmatched) {
      if (gapTo(candidate) <= SAME_MOMENT && (!match || gapTo(candidate) < gapTo(match))) match = candidate;
    }
    if (match) {
      unmatched.delete(match);
      Object.assign(match, { until: moment.until, kind: moment.kind, signs: moment.signs, strength: moment.strength });
    } else {
      fresh.push({ ...moment, name: '', category: '', note: '', status: '', start: null, end: null });
    }
  }

  moments = [...staying.filter((moment) => isTouched(moment) || !unmatched.has(moment)), ...fresh];
}

// ---------- The list ----------

// The kinds, in the order "By kind" lists them: the editor's own first.
const KIND_ORDER = ['Added', 'Laugh', 'Scream', 'Shout', 'Raised voice', 'Chat'];

// The three things the list can be narrowed by. They work together: a
// moment is shown when it passes all of them.
function fitsStatus(moment, status) {
  if (status === 'review') return moment.status === '';
  if (status === 'kept' || status === 'rejected') return moment.status === status;
  return true;
}

// The kind or category chosen in the menu, and what is typed in the search box.
function fitsKindAndSearch(moment) {
  const show = showSelect.value;
  if (show.startsWith('kind:') && !moment.signs.includes(show.slice('kind:'.length))) return false;
  if (show.startsWith('category:') && moment.category !== show.slice('category:'.length)) return false;
  const wanted = momentSearch.value.trim().toLowerCase();
  if (!wanted) return true;
  return [moment.name, moment.note, moment.category, ...moment.signs].some((text) => text.toLowerCase().includes(wanted));
}

// Makes sure the list shows this moment, by widening what it is narrowed to.
function reveal(moment) {
  if (visibleMoments().includes(moment)) return;
  showStatus = 'all';
  showSelect.value = '';
  momentSearch.value = '';
}

// The moments the list is showing, in the order it shows them.
function visibleMoments() {
  const list = moments.filter((moment) => fitsKindAndSearch(moment) && fitsStatus(moment, showStatus));

  if (sortSelect.value === 'time') {
    list.sort((a, b) => a.time - b.time);
  } else if (sortSelect.value === 'kind') {
    // Each kind together, and within a kind the strongest first. showMoments
    // puts a heading over each group.
    list.sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || b.strength - a.strength || a.time - b.time);
  } else {
    // The editor's own first, then the strongest first.
    const own = (moment) => (moment.kind === 'Added' ? 0 : 1);
    list.sort((a, b) => own(a) - own(b) || b.strength - a.strength || a.time - b.time);
  }
  return list;
}

// The rows of the list. Ordered by kind, every group gets a small heading
// with its name and how many it holds.
function buildRows(list) {
  if (sortSelect.value !== 'kind') return list.map(buildMoment);
  const rows = [];
  for (const [n, moment] of list.entries()) {
    if (moment.kind !== list[n - 1]?.kind) {
      const count = list.filter((other) => other.kind === moment.kind).length;
      const heading = part('li', 'group ' + styleOf(moment.kind), moment.kind === 'Added' ? 'Added by you' : moment.kind, part('span', '', String(count)));
      rows.push(heading);
    }
    rows.push(buildMoment(moment));
  }
  return rows;
}

// Redraws the list, the strip's markers and the box for the selected moment.
// Called after anything about the moments changes.
function showMoments() {
  const list = visibleMoments();
  // A moment that the list no longer shows cannot stay selected or picked.
  if (selected && !list.includes(selected)) selected = null;
  for (const moment of [...picked]) {
    if (!selected || moment === selected || !list.includes(moment)) picked.delete(moment);
  }

  // The tab says how many moments there are in all; the four buttons under
  // it say how many each of them holds.
  momentCount.textContent = moments.length || '';
  showFilter();
  noteProgress();
  // Pictures asked for by rows that are about to go are no longer wanted.
  picturesWanted = [];
  momentList.replaceChildren(...buildRows(list));
  timeline.setMoments(list, selected, (moment) => colourOf(moment.category), rangeOf);

  if (listenState === 'done') {
    const kept = moments.filter((moment) => moment.status === 'kept').length;
    const onlyReview = showStatus === 'review' && showSelect.value === '' && momentSearch.value.trim() === '';
    if (list.length) analysisStatus.textContent = '';
    else if (moments.length === 0) analysisStatus.textContent = 'Nothing stood out in this video.';
    else if (onlyReview) analysisStatus.textContent = `All reviewed. ${kept} kept.`;
    else analysisStatus.textContent = 'No moments to show here.';
  }
  showSelected();
}

// Tells the Home screen's card how many moments are still to review, each
// time that number changes. Only once the moments are all there.
function noteProgress() {
  if (listenState !== 'done' || !openPath) return;
  const toReview = moments.filter((moment) => moment.status === '').length;
  if (toReview === notedToReview) return;
  notedToReview = toReview;
  window.loudest.noteProgress(openPath, toReview);
}

// What a moment is called: the editor's name for it, else its category, else
// why the app picked it.
function labelOf(moment) {
  return moment.name || moment.category || moment.kind;
}

// 'Raised voice' becomes the style name 'raised-voice'.
function styleOf(kind) {
  return kind.toLowerCase().replace(' ', '-');
}

// A piece of a row, with its style name.
function part(tag, className, ...children) {
  const element = document.createElement(tag);
  element.className = className;
  element.append(...children);
  return element;
}

// One row: a small picture of the moment, what it is called, the time and
// why it was found, and on the right whether it was kept or rejected and a
// three-step meter for how strong it is. The meter is the row's one spot of
// colour, the colour of its kind; the amber tick aside.
function buildMoment(moment) {
  const item = document.createElement('li');
  const button = document.createElement('button');
  const text = labelOf(moment);
  const time = formatDuration(moment.time);
  const kindName = moment.kind === 'Added' ? 'Added by you' : moment.kind;

  button.type = 'button';
  // The status ('kept', 'rejected') is a style name too: kept rows get a tick, rejected ones fade.
  button.className = `moment ${styleOf(moment.kind)} ${moment.status}`;
  if (moment === selected) button.setAttribute('aria-current', 'true');
  if (picked.has(moment)) button.classList.add('picked');

  const picture = document.createElement('img');
  picture.alt = '';
  picture.hidden = true;
  showPicture(picture, rangeOf(moment).start);

  const label = part('span', 'label', text);
  // After the time: the kind, unless that is already what the row is called,
  // and every further reason ("+ Chat").
  const why = [...(text === moment.kind ? [] : [kindName]), ...moment.signs.slice(1).map((sign) => '+ ' + sign)];
  const sub = part('span', 'sub', part('span', 'when', time), part('span', 'why', why.join(' ')));

  const mark = part('span', 'mark');
  if (moment.status) mark.append(iconOf(moment.status === 'kept' ? 'check-circle-fill' : 'x-circle'));
  const how = part('span', 'how');
  if (moment.kind !== 'Added') {
    const meter = part('span', 'meter', part('i', ''), part('i', ''), part('i', ''));
    meter.dataset.steps = moment.strength >= 0.67 ? 3 : moment.strength >= 0.34 ? 2 : 1;
    how.append(meter);
  }

  // The meter, the tick and the fading are only visible; this says the same aloud.
  const aloud = [`${time} ${text}`];
  if (moment.signs.length > 1) aloud.push(moment.signs.join(' and '));
  if (moment.status) aloud.push(moment.status);
  if (picked.has(moment)) aloud.push('picked');
  button.setAttribute('aria-label', aloud.join(', '));
  button.append(part('span', 'shot', picture), part('span', 'text', label, sub), part('span', 'state', mark, how));
  // A plain click goes to the moment. With Ctrl it is picked as well as the
  // selected one (or let go again), with Shift everything from the selected
  // one to it is picked, as in a list of files.
  button.addEventListener('click', (event) => {
    if (selected && moment !== selected && (event.ctrlKey || event.shiftKey)) {
      if (event.shiftKey) {
        const list = visibleMoments();
        const [from, to] = [list.indexOf(selected), list.indexOf(moment)].sort((a, b) => a - b);
        for (const between of list.slice(from, to + 1)) if (between !== selected) picked.add(between);
      } else if (!picked.delete(moment)) {
        picked.add(moment);
      }
      showMoments();
      return;
    }
    picked.clear();
    jumpTo(moment);
  });
  button.addEventListener('contextmenu', (event) => openContext(event, moment));

  item.append(button);
  return item;
}

// ---------- The small pictures in the list and along the timeline ----------

// A second, silent player that is sent to one place after the other and
// has its picture copied. A jump takes it about a sixth of a second in a
// long recording, so the pictures arrive one by one; each is kept, so a row
// or a tile that is drawn again has it at once. (Several such players side
// by side were tried and measured: together they fetch no faster than one.)
const pictureSource = document.createElement('video');
const pictures = new Map(); // whole second -> the picture, as a data: address
let picturesWanted = []; // [{ second, image }], the next one first
let filmWanted = []; // the same, for the pictures along the timeline; these go first
let pictureJob = null; // the one the player has been sent to

pictureSource.muted = true;
pictureSource.preload = 'metadata';

function setPictureSource(url) {
  pictures.clear();
  picturesWanted = [];
  filmWanted = [];
  pictureJob = null;
  if (url) {
    pictureSource.src = url;
  } else {
    pictureSource.removeAttribute('src');
    pictureSource.load();
  }
}

// Puts the picture of the video at `seconds` into `image`, now if it is
// known and otherwise when its turn has come.
function showPicture(image, seconds) {
  const second = Math.floor(seconds);
  if (pictures.has(second)) {
    image.src = pictures.get(second);
    image.hidden = false;
    return;
  }
  picturesWanted.push({ second, image });
  nextPicture();
}

// The timeline hands over, each time it is drawn, every picture its film
// still misses: [{ second, image }], the ones nearest to where the video is
// first. The new list takes
// the place of the last one, so pictures for a part that has been zoomed or
// slid away from are no longer fetched. They go before the list's pictures:
// there are few of them, and the list can have a hundred.
function showFilmPictures(wanted) {
  filmWanted = wanted;
  nextPicture();
}

function nextPicture() {
  // Busy, or there is no picture to copy (not loaded yet, or sound only).
  if (pictureJob || pictureSource.videoWidth === 0) return;
  pictureJob = filmWanted.shift() ?? picturesWanted.shift() ?? null;
  if (!pictureJob) return;
  if (pictures.has(pictureJob.second)) pictureArrived();
  else pictureSource.currentTime = pictureJob.second + 0.05;
}

function pictureArrived() {
  const job = pictureJob;
  pictureJob = null;
  if (job && !pictures.has(job.second)) {
    const canvas = document.createElement('canvas');
    canvas.width = 144;
    canvas.height = 80;
    canvas.getContext('2d').drawImage(pictureSource, 0, 0, canvas.width, canvas.height);
    pictures.set(job.second, canvas.toDataURL('image/jpeg', 0.6));
  }
  if (job && pictures.has(job.second)) {
    job.image.src = pictures.get(job.second);
    job.image.hidden = false;
  }
  nextPicture();
}

pictureSource.addEventListener('seeked', pictureArrived);
pictureSource.addEventListener('loadedmetadata', nextPicture);

// ---------- Which moments to show ----------

// Lights the one of the four buttons that is chosen and writes on each how
// many moments it holds (of the kind and search chosen), so it can be seen
// how many are left. And copies what the hidden "show" menu offers to the
// menu that is seen, leaving out what is switched off (Chat, with no chat).
function showFilter() {
  const inScope = moments.filter(fitsKindAndSearch);
  for (const button of statusButtons) {
    button.setAttribute('aria-pressed', button.dataset.show === showStatus);
    const count = inScope.filter((moment) => fitsStatus(moment, button.dataset.show)).length;
    button.querySelector('em').textContent = moments.length ? count : '';
  }
  const offered = [...showSelect.options].filter((option) => !option.hidden);
  showOnly.replaceChildren(...offered.map((option) => new Option(option.textContent, option.value)));
  showOnly.value = showSelect.value;
}

for (const button of statusButtons) {
  button.addEventListener('click', () => {
    showStatus = button.dataset.show;
    showMoments();
  });
}

showOnly.addEventListener('change', () => {
  showSelect.value = showOnly.value;
  showOnly.blur();
  showMoments();
});

momentSearch.addEventListener('input', showMoments);

function colourOf(categoryName) {
  return categories.find((category) => category.name === categoryName)?.colour || '';
}

// Puts the categories where they can be picked: as suggestions under the
// Category box, and as choices in the "show" menu.
function showCategories() {
  categoryNames.replaceChildren(...categories.map((category) => new Option(category.name, category.name)));

  const chosen = showSelect.value;
  categoryOptions.replaceChildren(
    ...categories.map((category) => new Option(category.name, 'category:' + category.name)),
  );
  // An empty group would still show its heading in the menu.
  if (categories.length) showSelect.append(categoryOptions);
  else categoryOptions.remove();
  // Keep what was chosen, unless that category has just gone.
  const stillThere = [...showSelect.options].some((option) => option.value === chosen);
  showSelect.value = stillThere ? chosen : '';
}

// Where a moment starts and ends: where the editor put it, or else a little
// before the thing happens (so what led up to it is seen) until a little
// after it is over.
function rangeOf(moment) {
  const TAIL = 5; // seconds
  const length = Number.isFinite(player.duration) ? player.duration : Infinity;
  const start = Math.min(moment.start ?? Math.max(0, moment.time - settings.leadIn), length);
  const end = Math.min(moment.end ?? Math.max(moment.until, moment.time) + TAIL, length);
  return { start, end: Math.max(end, start) };
}

// Fills the box under the list with the selected moment, or hides it.
function showSelected() {
  inspector.hidden = !selected;
  // With nothing selected: the offer to undo a removal, or else the hint.
  // While there are no moments yet there is nothing to pick, so no hint.
  removedLine.hidden = Boolean(selected) || !removed;
  inspectorEmpty.hidden = Boolean(selected) || removed || moments.length === 0;
  timeline.setRange(selected ? rangeOf(selected) : null);
  timelineSelected.replaceChildren();
  if (!selected) return;

  // A moment the editor added can be removed; one the app found can only be
  // rejected, because taken out it would just be found again.
  const own = selected.kind === 'Added';
  inspectorKind.textContent = own ? 'Added by you' : selected.signs.join(' + ');
  keepButton.setAttribute('aria-pressed', selected.status === 'kept');
  document.getElementById('keep-label').textContent = selected.status === 'kept' ? 'Kept' : 'Keep';
  rejectButton.setAttribute('aria-pressed', selected.status === 'rejected');
  // The same word in the box, in the Moment menu and in the right-click menu.
  for (const label of rejectLabels) label.textContent = own ? 'Remove' : 'Reject';
  rejectButton.title = own ? 'Remove this moment of yours (X or Delete)' : 'Reject, and go to the next (X or Delete)';
  // A box that is being typed in is left alone.
  if (document.activeElement !== nameInput) nameInput.value = selected.name;
  if (document.activeElement !== categoryInput) categoryInput.value = selected.category;
  if (document.activeElement !== noteInput) noteInput.value = selected.note;

  const range = rangeOf(selected);
  if (document.activeElement !== startInput) startInput.value = formatDuration(range.start);
  if (document.activeElement !== endInput) endInput.value = formatDuration(range.end);
  // Worked out from the two times as they are shown (whole seconds), so the
  // three numbers always agree.
  rangeLength.textContent = Math.floor(range.end) - Math.floor(range.start) + ' s';
  resetRange.hidden = selected.start === null && selected.end === null;
  // Above the timeline: which moment the white band is, and from when to when.
  timelineSelected.append(
    part('b', '', labelOf(selected)),
    part('span', '', `${formatDuration(range.start)} – ${formatDuration(range.end)}`),
  );
}

// ---------- Undo and redo ----------

// The moments as they are now, and which one is selected.
function snapshot() {
  return { moments: JSON.stringify(moments), selected: moments.indexOf(selected) };
}

// Called right before each change the editor makes to the moments, so Undo
// can put back what was there.
function remember() {
  undoSteps.push(snapshot());
  if (undoSteps.length > 100) undoSteps.shift();
  redoSteps = [];
}

// Puts back the newest of `from` and notes what is there now in `to`.
function restore(from, to) {
  const step = from.pop();
  if (!step) return;
  to.push(snapshot());
  moments = JSON.parse(step.moments);
  selected = moments[step.selected] ?? null;
  picked.clear();
  removed = false;
  if (selected) reveal(selected);
  saveWork();
  showMoments();
  // What nobody touched is found again, in case the slider has moved since.
  findAgain();
}

function undo() {
  restore(undoSteps, redoSteps);
}

function redo() {
  restore(redoSteps, undoSteps);
}

// ---------- Working on the moments ----------

function select(moment) {
  selected = moment;
  // Going on to another moment ends the offer to undo a removal.
  removed = false;
  showMoments();
  momentList.querySelector('[aria-current]')?.scrollIntoView({ block: 'nearest' });
  // In a long video a moment is a sliver on the timeline: look closer.
  timeline.reveal(rangeOf(moment));
}

// Selects a moment, goes to its start, and plays it.
function jumpTo(moment) {
  select(moment);
  seekTo(rangeOf(moment).start);
  play();
}

// The row after (direction 1) or before (direction -1) the selected one, in
// the order the list is showing. With nothing selected: the first row.
function stepMoment(direction) {
  const list = visibleMoments();
  const target = selected ? list[list.indexOf(selected) + direction] : list[0];
  if (target) {
    picked.clear();
    jumpTo(target);
  }
}

// The moment that starts next after where the video is now (direction 1) or
// last before it (-1), whatever order the list is in. For the two buttons
// either side of the skip buttons, which point along the video.
function stepInTime(direction) {
  const now = seekWanted ?? player.currentTime;
  const starts = visibleMoments().map((moment) => ({ moment, start: rangeOf(moment).start })).sort((a, b) => a.start - b.start);
  // A little slack: playing has moved on a bit from the start it was sent to.
  const target = direction > 0
    ? starts.find(({ start }) => start > now + 0.5)
    : starts.findLast(({ start }) => start < now - 1.5);
  if (target) {
    picked.clear();
    jumpTo(target.moment);
  }
}

// The selected moment and the ones picked with it.
function chosen() {
  return selected ? [selected, ...picked] : [];
}

// Keeps or rejects the selected moment (and any picked with it) and moves on
// to the next row, so a whole list can be gone through with one key per
// moment. Doing the same thing again changes nothing; U takes a decision back.
function decide(status) {
  if (!selected) return;
  const group = chosen();
  // Rejecting a moment of one's own would only leave it lying in the list.
  if (status === 'rejected' && group.length === 1 && selected.kind === 'Added') {
    removeSelected();
    return;
  }
  const list = visibleMoments();
  const next = list.slice(list.indexOf(selected) + 1).find((moment) => !group.includes(moment));
  const going = status === 'rejected' ? group.filter((moment) => moment.kind === 'Added') : [];
  const changing = group.filter((moment) => moment.status !== status && !going.includes(moment));

  if (changing.length || going.length) {
    remember();
    for (const moment of changing) moment.status = status;
    moments = moments.filter((moment) => !going.includes(moment));
    saveWork();
  }
  picked.clear();
  if (next) jumpTo(next);
  else showMoments();
}

// Makes the selected moment (and any picked with it) undecided again.
function clearDecision() {
  const changing = chosen().filter((moment) => moment.status !== '');
  if (!changing.length) return;
  remember();
  for (const moment of changing) moment.status = '';
  saveWork();
  showMoments();
}

// Takes the selected moment, one the editor added, out of the video's
// moments altogether. "Undo" is offered where its details were, until
// another moment is selected or another video is opened; Ctrl+Z does the same.
function removeSelected() {
  remember();
  moments = moments.filter((moment) => moment !== selected);
  selected = null;
  removed = true;
  saveWork();
  showMoments();
}

// A moment of the editor's own, where the video is now. It starts out kept:
// nobody marks a spot they do not want. The name box is ready to be typed in.
function addMoment() {
  if (!Number.isFinite(player.duration)) return;
  const time = Math.round(player.currentTime * 100) / 100;
  const moment = {
    time,
    until: time,
    kind: 'Added',
    signs: ['Added'],
    strength: 0,
    name: '',
    category: '',
    note: '',
    status: 'kept',
    start: null,
    end: null,
  };
  remember();
  moments.push(moment);
  picked.clear();
  // A choice such as "Rejected" would hide it, and it would seem nothing happened.
  reveal(moment);
  saveWork();
  select(moment);
  nameMoment();
}

// Puts the keyboard in the Name box of the selected moment. Enter there
// saves the name and hands the keyboard back.
function nameMoment() {
  if (!selected) return;
  nameInput.focus();
  nameInput.select();
}

// The edge that is being dragged, from the first move until it is let go:
// the whole drag is one step for Undo.
let dragging = false;

// Moves where the selected moment starts or ends ('start' or 'end') to
// `seconds`. The other end makes room if it has to, so a moment is never
// shorter than a second. While an edge is being dragged, `finished` is false
// and nothing is saved yet.
function setEdge(edge, seconds, finished = true) {
  if (!selected) return;
  const SHORTEST = 1;
  const range = rangeOf(selected);
  const length = Number.isFinite(player.duration) ? player.duration : Infinity;
  const at = Math.round(Math.min(Math.max(0, seconds), length) * 100) / 100;

  if (!dragging) remember();
  dragging = !finished;

  if (edge === 'start') {
    selected.start = at;
    if (range.end < at + SHORTEST) selected.end = at + SHORTEST;
  } else {
    selected.end = Math.max(at, SHORTEST);
    if (range.start > selected.end - SHORTEST) selected.start = selected.end - SHORTEST;
  }
  if (finished) saveWork();
  showSelected();
}

// What was typed as a time, in seconds: "1:02:03", "62:03" or "45". Null
// when it is not a time.
function parseTime(text) {
  const parts = text.trim().split(':');
  if (parts.length > 3 || parts.some((piece) => !/^\d+([.,]\d+)?$/.test(piece))) return null;
  return parts.reduce((total, piece) => total * 60 + Number(piece.replace(',', '.')), 0);
}

// The two boxes with the start and the end. A time typed in is taken when
// the box is left or Enter is pressed; Escape puts back what was there. The
// up and down keys move the edge a second at a time, and the picture follows.
for (const [box, edge] of [[startInput, 'start'], [endInput, 'end']]) {
  box.addEventListener('change', () => {
    const seconds = parseTime(box.value);
    if (selected && seconds !== null) setEdge(edge, seconds);
    // Shows it the way Loudest writes times, or puts back what was there.
    if (selected) box.value = formatDuration(rangeOf(selected)[edge]);
  });
  box.addEventListener('keydown', (event) => {
    if (!selected) return;
    const nudge = { ArrowUp: 1, ArrowDown: -1 }[event.key];
    if (nudge) {
      event.preventDefault();
      // From the whole second, so that the time shown changes with every press.
      const seconds = Math.floor(rangeOf(selected)[edge]) + nudge;
      setEdge(edge, seconds);
      box.value = formatDuration(rangeOf(selected)[edge]);
      seekTo(rangeOf(selected)[edge]);
    }
    if (event.key === 'Escape') box.value = formatDuration(rangeOf(selected)[edge]);
    if (event.key === 'Escape' || event.key === 'Enter') box.blur();
  });
}

// Back to where the moment started and ended before the editor moved them.
resetRange.addEventListener('click', () => {
  if (!selected) return;
  remember();
  selected.start = null;
  selected.end = null;
  saveWork();
  showMoments();
});

// Saves the editor's work on this video: the moments they added and the ones
// they decided on, named, noted, put in a category or changed the length of.
// What the app found and nobody touched is not saved; it is found again from
// the saved listening.
async function saveWork() {
  const records = moments.filter(isTouched).map(({ time, kind, name, category, note, status, start, end }) => (
    { time, kind, name, category, note, status, start, end }
  ));

  try {
    categories = await window.loudest.saveMoments(openPath, records);
    saveProblem.textContent = '';
  } catch {
    saveProblem.textContent = 'Your changes could not be saved. Check that the disk is not full.';
    return;
  }
  // A category that was just made up now has its colour.
  showCategories();
  showMoments();
}

nameInput.addEventListener('change', () => {
  if (!selected) return;
  remember();
  selected.name = nameInput.value.trim();
  saveWork();
  showMoments();
});

categoryInput.addEventListener('change', () => {
  if (!selected) return;
  const typed = categoryInput.value.trim();
  // "funny" means the "Funny" that already exists.
  const existing = categories.find((category) => category.name.toLowerCase() === typed.toLowerCase());
  remember();
  selected.category = existing ? existing.name : typed;
  saveWork();
  showMoments();
});

noteInput.addEventListener('change', () => {
  if (!selected) return;
  remember();
  selected.note = noteInput.value.trim();
  saveWork();
});

// In the boxes Escape puts back what was there, and Enter saves (leaving a
// box saves it). In the note Enter starts a new line, as it does anywhere
// else one writes several lines.
for (const [box, field] of [[nameInput, 'name'], [categoryInput, 'category'], [noteInput, 'note']]) {
  box.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && selected) box.value = selected[field];
    if (event.key === 'Escape' || (event.key === 'Enter' && box !== noteInput)) box.blur();
  });
}

keepButton.addEventListener('click', () => decide('kept'));
rejectButton.addEventListener('click', () => decide('rejected'));
document.getElementById('undo-remove').addEventListener('click', undo);
startButton.addEventListener('click', () => setEdge('start', player.currentTime));
endButton.addEventListener('click', () => setEdge('end', player.currentTime));

// ---------- The timeline, and the right-click menu ----------

function zoomToSelected() {
  if (selected) timeline.zoomTo(rangeOf(selected));
}

// A right-click on a moment, in the list or on the timeline, opens the small
// menu where the mouse is. The moment is selected first (without playing it),
// unless it is one of several that are picked: then the menu is about all of
// them. menus.js makes the menu work, like the ones in the top bar.
function openContext(event, moment) {
  event.preventDefault();
  if (!chosen().includes(moment)) {
    picked.clear();
    select(moment);
    seekTo(rangeOf(moment).start);
  }
  momentContext.showPopover();
  // Where the mouse is, but never sticking out of the window.
  const box = momentContext.getBoundingClientRect();
  momentContext.style.left = Math.max(0, Math.min(event.clientX, window.innerWidth - box.width - 6)) + 'px';
  momentContext.style.top = Math.max(0, Math.min(event.clientY, window.innerHeight - box.height - 6)) + 'px';
}

timeline.onMoment = (moment) => {
  picked.clear();
  // The list may be narrowed to something else; the timeline shows only
  // what the list shows, so this is always one of its rows.
  jumpTo(moment);
};
timeline.onContext = openContext;
// Dragging an edge of the selected moment's band on the strip. The picture
// follows the edge, so it is clear where the cut will be.
timeline.onRange = (edge, seconds, finished) => {
  setEdge(edge, seconds, finished);
  seekTo(seconds);
};

// Choosing from a menu leaves the keyboard on the menu; hand it back, so the
// arrow keys go through the moments again and not through the menu.
for (const menu of [showSelect, sortSelect]) {
  menu.addEventListener('change', () => {
    menu.blur();
    showMoments();
  });
}
// The order of the list is remembered for next time (extras.js puts it back).
sortSelect.addEventListener('change', () => window.loudest.setSettings({ sort: sortSelect.value }));

// The slider finds more or fewer moments as it moves, and the choice is
// remembered when it is let go.
sensitivitySlider.addEventListener('input', () => {
  settings.sensitivity = Number(sensitivitySlider.value);
  findAgain();
});
sensitivitySlider.addEventListener('change', () => {
  window.loudest.setSettings({ sensitivity: settings.sensitivity });
  sensitivitySlider.blur();
});

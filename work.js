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
const categoryDot = document.getElementById('category-dot');
const categoryNames = document.getElementById('category-names');
const noteInput = document.getElementById('moment-note');
const startButton = document.getElementById('set-start');
const endButton = document.getElementById('set-end');
const rangeLength = document.getElementById('range-length');
const statusButtons = [...document.querySelectorAll('#show-status button')];
const showOnly = document.getElementById('show-only');
const inspectorEmpty = document.getElementById('inspector-empty');
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
  listenState = 'listening';
  saveProblem.textContent = '';
  analysisStatus.textContent = 'Listening to the whole video…';
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
  showMoments();

  // Arriving from the list of kept moments: go straight to the one clicked.
  const wanted = moments.find((moment) => moment.time === atTime);
  if (wanted) {
    if (!visibleMoments().includes(wanted)) showSelect.value = 'all';
    jumpTo(wanted);
  }

  // A chat that was saved earlier can point at moments before the listening is done.
  findAgain();
  const outcome = await window.loudest.listenNow(videoPath);
  if (thisRun !== run) return;

  analysisProgress.hidden = true;
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
  let text = 'Listening… ' + formatDuration(seconds);
  if (Number.isFinite(total) && total > 0) {
    analysisProgress.max = total;
    analysisProgress.value = Math.min(seconds, total);
    text += ' of ' + formatDuration(total);
  }
  analysisStatus.textContent = text;
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
    if (!found.chat && showSelect.value === chatOption.value) showSelect.value = 'all';
    showChat(found.chat);
    showMoments();
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

// The moments the list is showing, in the order it shows them.
function visibleMoments() {
  const show = showSelect.value;
  const list = moments.filter((moment) => {
    if (show === 'review') return moment.status === '';
    if (show === 'kept' || show === 'rejected') return moment.status === show;
    if (show.startsWith('kind:')) return moment.signs.includes(show.slice('kind:'.length));
    if (show.startsWith('category:')) return moment.category === show.slice('category:'.length);
    return true;
  });

  if (sortSelect.value === 'time') {
    list.sort((a, b) => a.time - b.time);
  } else {
    // The editor's own first, then the strongest first.
    const own = (moment) => (moment.kind === 'Added' ? 0 : 1);
    list.sort((a, b) => own(a) - own(b) || b.strength - a.strength || a.time - b.time);
  }
  return list;
}

// Redraws the list, the strip's markers and the box for the selected moment.
// Called after anything about the moments changes.
function showMoments() {
  const list = visibleMoments();
  // A moment that the list no longer shows cannot stay selected.
  if (selected && !list.includes(selected)) selected = null;

  momentCount.textContent = moments.length ? list.length : '';
  showFilter();
  // Pictures asked for by rows that are about to go are no longer wanted.
  picturesWanted = [];
  momentList.replaceChildren(...list.map(buildMoment));
  timeline.setMoments(list, selected, (moment) => colourOf(moment.category), rangeOf);

  if (listenState === 'done') {
    if (list.length) analysisStatus.textContent = '';
    else analysisStatus.textContent = moments.length ? 'No moments to show here.' : 'Nothing stood out in this video.';
  }
  showSelected();
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

// One row: a small picture of the moment, what it is called, a square in the
// colour of why it was found, the time, and on the right whether it was kept
// or rejected, a small square for every further reason, and a three-step
// meter for how strong it is.
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

  const picture = document.createElement('img');
  picture.alt = '';
  picture.hidden = true;
  showPicture(picture, rangeOf(moment).start);

  const label = part('span', 'label');
  if (moment.category) label.append(dotFor(colourOf(moment.category)));
  label.append(text);
  const sub = part('span', 'sub', part('i', 'sq'), part('span', 'when', time));
  // The kind is already what the row is called when it has no name of its own.
  if (text !== moment.kind) sub.append(kindName);

  const mark = part('span', 'mark');
  if (moment.status) mark.append(iconOf(moment.status === 'kept' ? 'check-circle-fill' : 'x-circle'));
  const more = part('span', 'signs', ...moment.signs.slice(1).map((sign) => part('i', styleOf(sign))));
  const how = part('span', 'how', more);
  if (moment.kind !== 'Added') {
    const meter = part('span', 'meter', part('i', ''), part('i', ''), part('i', ''));
    meter.dataset.steps = moment.strength >= 0.67 ? 3 : moment.strength >= 0.34 ? 2 : 1;
    how.append(meter);
  }

  // The squares, the tick and the fading are only visible; this says the same aloud.
  const aloud = [`${time} ${text}`];
  if (moment.signs.length > 1) aloud.push(moment.signs.join(' and '));
  if (moment.status) aloud.push(moment.status);
  button.setAttribute('aria-label', aloud.join(', '));
  button.append(part('span', 'shot', picture), part('span', 'text', label, sub), part('span', 'state', mark, how));
  button.addEventListener('click', () => jumpTo(moment));

  item.append(button);
  return item;
}

// ---------- The small pictures in the list ----------

// A second, silent player that is sent to one moment after the other and
// has its picture copied. Jumping takes it a moment, so the pictures arrive
// one by one; each is kept, so a row that is drawn again has it at once.
const pictureSource = document.createElement('video');
const pictures = new Map(); // whole second -> the picture, as a data: address
let picturesWanted = []; // [{ second, image }], the next one first
let pictureJob = null; // the one the player has been sent to

pictureSource.muted = true;
pictureSource.preload = 'metadata';

function setPictureSource(url) {
  pictures.clear();
  picturesWanted = [];
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

function nextPicture() {
  // Nothing to do, busy, or there is no picture to copy (not loaded yet, or sound only).
  if (pictureJob || picturesWanted.length === 0 || pictureSource.videoWidth === 0) return;
  pictureJob = picturesWanted.shift();
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

const STATUS_CHOICES = ['all', 'review', 'kept', 'rejected'];

// The hidden "show" menu holds the choice. This puts it on the four buttons
// and on the menu beside them, which offers the kinds and the categories.
function showFilter() {
  for (const button of statusButtons) button.setAttribute('aria-pressed', button.dataset.show === showSelect.value);
  const others = [...showSelect.options].filter((option) => !STATUS_CHOICES.includes(option.value) && !option.hidden);
  showOnly.replaceChildren(new Option('Any kind', ''), ...others.map((option) => new Option(option.textContent, option.value)));
  showOnly.value = others.some((option) => option.value === showSelect.value) ? showSelect.value : '';
}

for (const button of statusButtons) {
  button.addEventListener('click', () => {
    showSelect.value = button.dataset.show;
    showMoments();
  });
}

showOnly.addEventListener('change', () => {
  showSelect.value = showOnly.value || 'all';
  showOnly.blur();
  showMoments();
});

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
  showSelect.value = stillThere ? chosen : 'all';
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
  inspectorEmpty.hidden = Boolean(selected);
  timeline.setRange(selected ? rangeOf(selected) : null);
  timelineSelected.replaceChildren();
  if (!selected) return;

  inspectorKind.textContent = selected.kind === 'Added' ? 'Added by you' : selected.signs.join(' + ');
  keepButton.setAttribute('aria-pressed', selected.status === 'kept');
  rejectButton.setAttribute('aria-pressed', selected.status === 'rejected');
  // A box that is being typed in is left alone.
  if (document.activeElement !== nameInput) nameInput.value = selected.name;
  if (document.activeElement !== categoryInput) categoryInput.value = selected.category;
  if (document.activeElement !== noteInput) noteInput.value = selected.note;
  categoryDot.style.background = colourOf(selected.category) || 'transparent';

  const range = rangeOf(selected);
  startButton.textContent = formatDuration(range.start);
  endButton.textContent = formatDuration(range.end);
  rangeLength.textContent = Math.round(range.end - range.start) + ' s';
  // Above the timeline: which moment the white band is, and from when to when.
  timelineSelected.append(
    part('b', '', labelOf(selected)),
    part('span', '', `${formatDuration(range.start)} – ${formatDuration(range.end)}`),
  );
}

// ---------- Working on the moments ----------

function select(moment) {
  selected = moment;
  showMoments();
  momentList.querySelector('[aria-current]')?.scrollIntoView({ block: 'nearest' });
}

// Selects a moment, goes to its start, and plays it.
function jumpTo(moment) {
  select(moment);
  player.currentTime = rangeOf(moment).start;
  play();
}

// The row after (direction 1) or before (direction -1) the selected one, in
// the order the list is showing. With nothing selected: the first row.
function stepMoment(direction) {
  const list = visibleMoments();
  const target = selected ? list[list.indexOf(selected) + direction] : list[0];
  if (target) jumpTo(target);
}

// Keeps or rejects the selected moment and moves on to the next row, so a
// whole list can be gone through with one key per moment. Doing the same
// thing to a moment a second time takes the decision back, and stays.
function decide(status) {
  if (!selected) return;
  const list = visibleMoments();
  const next = list[list.indexOf(selected) + 1];
  const takingBack = selected.status === status;

  selected.status = takingBack ? '' : status;
  saveWork();
  if (!takingBack && next) jumpTo(next);
  else showMoments();
}

// A moment of the editor's own, where the video is now. It starts out kept:
// nobody marks a spot they do not want.
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
  moments.push(moment);
  // A choice such as "Rejected" would hide it, and it would seem nothing happened.
  if (!visibleMoments().includes(moment)) showSelect.value = 'all';
  saveWork();
  select(moment);
}

// Moves where the selected moment starts or ends ('start' or 'end') to
// `seconds`. The other end makes room if it has to, so a moment is never
// shorter than a second. While an edge is being dragged, `finished` is false
// and nothing is saved yet.
function setEdge(edge, seconds, finished = true) {
  if (!selected) return;
  const SHORTEST = 1;
  const range = rangeOf(selected);
  const at = Math.round(Math.max(0, seconds) * 100) / 100;

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
  selected.name = nameInput.value.trim();
  saveWork();
  showMoments();
});

categoryInput.addEventListener('change', () => {
  if (!selected) return;
  const typed = categoryInput.value.trim();
  // "funny" means the "Funny" that already exists.
  const existing = categories.find((category) => category.name.toLowerCase() === typed.toLowerCase());
  selected.category = existing ? existing.name : typed;
  saveWork();
  showMoments();
});

noteInput.addEventListener('change', () => {
  if (!selected) return;
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
startButton.addEventListener('click', () => setEdge('start', player.currentTime));
endButton.addEventListener('click', () => setEdge('end', player.currentTime));

timeline.onMoment = jumpTo;
// Dragging an edge of the selected moment's band on the strip. The picture
// follows the edge, so it is clear where the cut will be.
timeline.onRange = (edge, seconds, finished) => {
  setEdge(edge, seconds, finished);
  player.currentTime = seconds;
};

// Choosing from a menu leaves the keyboard on the menu; hand it back, so the
// arrow keys go through the moments again and not through the menu.
for (const menu of [showSelect, sortSelect]) {
  menu.addEventListener('change', () => {
    menu.blur();
    showMoments();
  });
}

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

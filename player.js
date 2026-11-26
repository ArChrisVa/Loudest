// The player on the work screen: the buttons under the picture, the keyboard,
// and keeping the strip in step with the video.

const player = document.getElementById('player');
const message = document.getElementById('message');
const stage = document.getElementById('stage');
const playButton = document.getElementById('play');
const muteButton = document.getElementById('mute');
const volume = document.getElementById('volume');
const speed = document.getElementById('speed');
const skipStep = document.getElementById('skip-step');
const skipBack = document.getElementById('skip-back');
const skipForward = document.getElementById('skip-forward');
const timeNow = document.getElementById('time-now');
const timeTotal = document.getElementById('time-total');

const UNPLAYABLE = "This video's format can't be shown here. Try an mp4 (H.264) file.";

function play() {
  // A video that cannot be played refuses; the message on screen already says so.
  player.play().catch(() => {});
}

function togglePlay() {
  if (player.paused) play();
  else player.pause();
}

// Where the video is to go next, while the player is still busy with its
// last jump. Nothing is waiting most of the time.
let seekWanted = null;

// Sends the video to `seconds`. A jump takes the player a moment, longer in
// a big file, and a jump started before the last one has finished throws
// that one away: dragging along the timeline would then show no new picture
// until the mouse stopped. So while the player is busy only the latest place
// is remembered, and it goes there as soon as it is free. The timeline's
// small picture works the same way.
function seekTo(seconds) {
  if (player.seeking) {
    seekWanted = seconds;
    showTime(true);
  } else {
    seekWanted = null;
    player.currentTime = seconds;
  }
}

// The clock and the playhead show where the video is going, not the jump it
// is still finishing on the way there.
function showTime(reveal) {
  const now = seekWanted ?? player.currentTime;
  timeNow.textContent = formatDuration(now);
  timeline.setTime(now, reveal);
}

function skip(seconds) {
  const end = Number.isFinite(player.duration) ? player.duration : 0;
  seekTo(Math.min(end, Math.max(0, (seekWanted ?? player.currentTime) + seconds)));
}

// How far the two skip buttons and the left and right keys jump: as far as
// the menu beside the speed says, or 1 second with Shift held down, or 30
// with Ctrl. `event` is the click or the key press.
function skipSize(event) {
  if (event.shiftKey) return 1;
  if (event.ctrlKey) return 30;
  return Number(skipStep.value);
}

// The two buttons say how far they jump when pointed at, and to a screen reader.
function nameSkipButtons() {
  const far = skipStep.value === '1' ? '1 second' : `${skipStep.value} seconds`;
  for (const [button, way, key] of [[skipBack, 'Back', 'Left'], [skipForward, 'Forward', 'Right']]) {
    button.title = `${way} ${far} (${key}). With Shift 1 second, with Ctrl 30.`;
    button.setAttribute('aria-label', `${way} ${far}`);
  }
}
nameSkipButtons();

// J, K and L, as in Resolve and Premiere: L plays, and each further press
// plays faster; K stops and goes back to normal speed; J slows down again,
// and at normal speed steps back ten seconds (this player cannot play
// backwards).
const FAST = [2, 4];

function playFaster() {
  if (player.paused) play();
  else player.playbackRate = FAST.find((rate) => rate > player.playbackRate) ?? player.playbackRate;
}

function stop() {
  player.pause();
  player.playbackRate = 1;
}

function playSlower() {
  if (player.playbackRate > 1) player.playbackRate = FAST.findLast((rate) => rate < player.playbackRate) ?? 1;
  else skip(-10);
}

// One picture back or forward, with the video standing still. The player
// does not say how many pictures a second the video has; a thirtieth of a
// second is one picture of most recordings, and two of a 60-a-second one.
function stepFrame(direction) {
  player.pause();
  skip(direction / 30);
}

function toggleFullScreen() {
  // The whole stage goes full screen, so the buttons and the strip come along.
  if (document.fullscreenElement) document.exitFullscreen();
  else stage.requestFullscreen();
}

playButton.addEventListener('click', togglePlay);
player.addEventListener('click', togglePlay);
player.addEventListener('dblclick', toggleFullScreen);
skipBack.addEventListener('click', (event) => skip(-skipSize(event)));
skipForward.addEventListener('click', (event) => skip(skipSize(event)));
// The choice is remembered for next time (extras.js puts it back at the
// start), and the keyboard is handed back, as with the speed.
skipStep.addEventListener('change', () => {
  window.loudest.setSettings({ skip: Number(skipStep.value) });
  nameSkipButtons();
  skipStep.blur();
});
// The outer pair points along the video: the moment before or after where
// it is now, whatever order the list is in. (Up and Down follow the list.)
document.getElementById('previous-moment').addEventListener('click', () => stepInTime(-1));
document.getElementById('next-moment').addEventListener('click', () => stepInTime(1));
document.getElementById('add-moment').addEventListener('click', () => addMoment());
document.getElementById('fullscreen').addEventListener('click', toggleFullScreen);
speed.addEventListener('change', () => {
  player.playbackRate = Number(speed.value);
  speed.blur();
});
muteButton.addEventListener('click', () => {
  player.muted = !player.muted;
});
volume.addEventListener('input', () => {
  player.volume = Number(volume.value);
  player.muted = false;
});
// Fires when the slider is let go: hand the keyboard back, as with the menus.
volume.addEventListener('change', () => volume.blur());

// The buttons and the strip show what the player is doing, whoever caused it.
player.addEventListener('play', () => playButton.classList.add('playing'));
player.addEventListener('pause', () => playButton.classList.remove('playing'));
player.addEventListener('volumechange', () => {
  muteButton.classList.toggle('muted', player.muted || player.volume === 0);
  volume.value = player.muted ? 0 : player.volume;
});
// Also when another video is opened, which starts at normal speed again.
player.addEventListener('ratechange', () => {
  speed.value = String(player.playbackRate);
});
player.addEventListener('durationchange', () => {
  const known = Number.isFinite(player.duration);
  timeTotal.textContent = formatDuration(known ? player.duration : 0);
  timeline.setDuration(player.duration);
});
player.addEventListener('timeupdate', () => showTime(false));
player.addEventListener('seeking', () => showTime(true));
// A jump has finished: on to the place that was asked for in the meantime.
player.addEventListener('seeked', () => {
  if (seekWanted === null) return;
  const next = seekWanted;
  seekWanted = null;
  player.currentTime = next;
});
// Another video, or none: a place in the last one means nothing now.
player.addEventListener('emptied', () => {
  seekWanted = null;
});

timeline.onSeek = seekTo;

// The file could not be opened at all.
player.addEventListener('error', () => {
  message.textContent = UNPLAYABLE;
});

// The file opened, but it has no picture this player can decode (sound only).
player.addEventListener('loadedmetadata', () => {
  if (player.videoWidth === 0) message.textContent = UNPLAYABLE;
});

// Clicking a button with the mouse leaves the keyboard where it was, so that
// Space still plays and pauses afterwards instead of pressing that button
// again. A box that was being typed in is left first, which saves it.
work.addEventListener('mousedown', (event) => {
  if (!event.target.closest('button')) return;
  if (document.activeElement?.matches('input, textarea')) document.activeElement.blur();
  event.preventDefault();
});

// ---------- Keyboard ----------

// Named by where the key sits on the keyboard, not by the letter it types,
// so they work the same when the keyboard is switched to Greek.
const KEYS = {
  Space: togglePlay,
  KeyK: stop,
  KeyJ: playSlower,
  KeyL: playFaster,
  ArrowLeft: (event) => skip(-skipSize(event)),
  ArrowRight: (event) => skip(skipSize(event)),
  Comma: () => stepFrame(-1),
  Period: () => stepFrame(1),
  Home: () => seekTo(0),
  End: () => skip(Infinity),
  ArrowUp: () => stepMoment(-1),
  ArrowDown: () => stepMoment(1),
  // M adds a marker, and I and O set where a clip starts and ends, in
  // Premiere and in Resolve too. With Shift, I and O go to the start or the
  // end of the selected moment instead, as they do there.
  KeyM: () => addMoment(),
  KeyI: (event) => (event.shiftKey ? goToEdge('start') : setEdge('start', player.currentTime)),
  KeyO: (event) => (event.shiftKey ? goToEdge('end') : setEdge('end', player.currentTime)),
  KeyA: () => decide('kept'),
  KeyX: () => decide('rejected'),
  // The same as X: rejects a found moment, removes one the editor added.
  Delete: () => decide('rejected'),
  KeyU: () => clearDecision(),
  Enter: () => nameMoment(),
  NumpadEnter: () => nameMoment(),
  KeyZ: (event) => (event.shiftKey ? timeline.showAll() : zoomToSelected()),
  KeyF: toggleFullScreen,
};
// Holding one of these down keeps going. The others act once per press.
const REPEATING = ['ArrowLeft', 'ArrowRight', 'Comma', 'Period'];

function goToEdge(edge) {
  if (selected) seekTo(rangeOf(selected)[edge]);
}

window.addEventListener('keydown', (event) => {
  // Ctrl belongs to the menus (menus.js), except with the left and right
  // keys, where it means the long jump.
  const jump = event.code === 'ArrowLeft' || event.code === 'ArrowRight';
  if (work.hidden || event.altKey || event.metaKey || (event.ctrlKey && !jump)) return;
  // Typing in a box, or pressing Space on a button reached with Tab, keeps its normal meaning.
  // (closest, not matches: the rows of a menu's open list are inside the menu.)
  // So does any key while a card is open in front of the window.
  if (event.target.closest('input, select, textarea, dialog')) return;
  // The same for Enter: on a button it presses the button.
  if (['Space', 'Enter', 'NumpadEnter'].includes(event.code) && event.target.matches('button')) return;

  const action = KEYS[event.code];
  if (!action) return;
  event.preventDefault();
  if (event.repeat && !REPEATING.includes(event.code)) return;
  action(event);
});

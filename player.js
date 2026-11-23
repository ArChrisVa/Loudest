// The player on the work screen: the buttons under the picture, the keyboard,
// and keeping the strip in step with the video.

const player = document.getElementById('player');
const message = document.getElementById('message');
const stage = document.getElementById('stage');
const playButton = document.getElementById('play');
const muteButton = document.getElementById('mute');
const volume = document.getElementById('volume');
const speed = document.getElementById('speed');
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

function skip(seconds) {
  const end = Number.isFinite(player.duration) ? player.duration : 0;
  player.currentTime = Math.min(end, Math.max(0, player.currentTime + seconds));
}

function toggleFullScreen() {
  // The whole stage goes full screen, so the buttons and the strip come along.
  if (document.fullscreenElement) document.exitFullscreen();
  else stage.requestFullscreen();
}

playButton.addEventListener('click', togglePlay);
player.addEventListener('click', togglePlay);
player.addEventListener('dblclick', toggleFullScreen);
document.getElementById('skip-back').addEventListener('click', () => skip(-5));
document.getElementById('skip-forward').addEventListener('click', () => skip(5));
document.getElementById('previous-moment').addEventListener('click', () => stepMoment(-1));
document.getElementById('next-moment').addEventListener('click', () => stepMoment(1));
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
player.addEventListener('durationchange', () => {
  const known = Number.isFinite(player.duration);
  timeTotal.textContent = formatDuration(known ? player.duration : 0);
  timeline.setDuration(player.duration);
});
player.addEventListener('timeupdate', () => {
  timeNow.textContent = formatDuration(player.currentTime);
  timeline.setTime(player.currentTime, false);
});
player.addEventListener('seeking', () => {
  timeNow.textContent = formatDuration(player.currentTime);
  timeline.setTime(player.currentTime, true);
});

timeline.onSeek = (seconds) => {
  player.currentTime = seconds;
};

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
  KeyK: togglePlay,
  KeyJ: () => skip(-10),
  KeyL: () => skip(10),
  ArrowLeft: () => skip(-5),
  ArrowRight: () => skip(5),
  ArrowUp: () => stepMoment(-1),
  ArrowDown: () => stepMoment(1),
  // M adds a marker, and I and O set where a clip starts and ends, in
  // Premiere and in Resolve too.
  KeyM: () => addMoment(),
  KeyI: () => setEdge('start', player.currentTime),
  KeyO: () => setEdge('end', player.currentTime),
  KeyA: () => decide('kept'),
  KeyX: () => decide('rejected'),
  KeyF: toggleFullScreen,
};
// Holding one of these down keeps going. The others act once per press.
const REPEATING = ['KeyJ', 'KeyL', 'ArrowLeft', 'ArrowRight'];

window.addEventListener('keydown', (event) => {
  if (work.hidden || event.ctrlKey || event.altKey || event.metaKey) return;
  // Typing in a box, or pressing Space on a button reached with Tab, keeps its normal meaning.
  if (event.target.matches('input, select, textarea')) return;
  if (event.code === 'Space' && event.target.matches('button')) return;

  const action = KEYS[event.code];
  if (!action) return;
  event.preventDefault();
  if (event.repeat && !REPEATING.includes(event.code)) return;
  action();
});

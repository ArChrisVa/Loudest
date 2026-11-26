// The timeline at the bottom of the work screen: the video laid out from left
// to right, with a ruler, the playhead, and three lanes: a marker for every
// moment, the video as a row of its pictures with the kept moments on it as
// the clips they would be cut into, and how loud the sound is.
//
//   click or drag      jump to that point
//   click a moment     its marker, or its clip once it is kept: selects it
//   right-click one    the small menu for it
//   double-click       show the whole video again
//   point at it        shows the time and the picture there
//   mouse wheel        zoom in and out around the pointer
//   Shift + wheel      slide left and right
//   the thin bar below shows the whole video, which part is zoomed in on,
//   and where the video is
//
// It also shows where nobody speaks (striped), how busy the chat is (the low
// green hills under the sound), and where the selected moment starts and
// ends (the white band, whose two edges can be dragged).
//
// The other scripts talk to it through `timeline`:
//   timeline.setVideo(url)                      a new video: forget the old one
//   timeline.setDuration(seconds)
//   timeline.setMoments(list, selected, colourFor, rangeFor)
//   timeline.setSound([loudness per so many seconds], seconds)
//   timeline.setRange({ start, end } or null)   of the selected moment
//   timeline.setQuiet([{ start, end }])
//   timeline.setChat([0..1 per ten seconds])
//   timeline.setTime(seconds, reveal)
//   timeline.reveal({ start, end })             look closer if that stretch is too thin to grab
//   timeline.zoomTo({ start, end })             look at that stretch
//   timeline.showAll()                          the whole video again
//   timeline.onSeek = (seconds) => ...
//   timeline.onMoment = (moment) => ...
//   timeline.onContext = (event, moment) => ...           a moment was right-clicked
//   timeline.onRange = (edge, seconds, finished) => ...   'start' or 'end' is being dragged
const timeline = (() => {
  const main = document.getElementById('timeline-main');
  const ruler = document.getElementById('timeline-ruler');
  const quietLayer = document.getElementById('timeline-quiet');
  const chatCanvas = document.getElementById('timeline-chat');
  const played = document.getElementById('timeline-played');
  const rangeBand = document.getElementById('timeline-range');
  const markerLayer = document.getElementById('timeline-markers');
  const filmLayer = document.getElementById('timeline-film');
  const clipLayer = document.getElementById('timeline-clips');
  const soundCanvas = document.getElementById('timeline-sound');
  const hover = document.getElementById('timeline-hover');
  const hoverCard = document.getElementById('timeline-hover-card');
  const hoverTime = document.getElementById('timeline-hover-time');
  const preview = document.getElementById('timeline-preview');
  const playhead = document.getElementById('timeline-playhead');
  const overview = document.getElementById('timeline-overview');
  const overviewMarks = document.getElementById('timeline-overview-marks');
  const windowBox = document.getElementById('timeline-window');
  const overviewNow = document.getElementById('timeline-overview-now');
  const clock = document.querySelector('.clock');

  const SMALLEST_VIEW = 30; // seconds: how far in you can zoom
  // Distances between labelled ruler ticks, in seconds. The first one that
  // leaves the labels room to breathe is used.
  const TICK_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200];
  const LABEL_ROOM = 90; // pixels
  const CHAT_BIN = 10; // seconds per number of the chat's busyness
  const FILM_SHAPE = 16 / 9; // how wide a picture of the film is for its height

  const THIN = 28; // pixels: a selected moment narrower than this has its two handles on top of each other
  const ROOMY = 56; // pixels: how wide it is made then

  const api = { onSeek() {}, onMoment() {}, onRange() {}, onContext() {} };
  let duration = 0;
  let viewStart = 0; // the part of the video the strip is showing
  let viewEnd = 0;
  let time = 0;
  let markers = []; // [{ moment, element }]
  let clips = []; // [{ moment, element }], one per kept moment
  const film = new Map(); // the pictures along the Video lane: which one, counted from the video's start -> its tile
  let filmEach = 0; // how many seconds of video one of those pictures stands for
  let shown = { moments: [], selected: null, colourFor: () => '', rangeFor: null }; // what was last asked for
  let sound = { level: [], seconds: 1, quietest: 0, loudest: 1 };
  let quiet = []; // [{ start, end, element }]
  let chat = [];
  let range = null;
  let previewWanted = null; // where the small picture should go once it has finished its last jump

  const width = () => main.clientWidth;
  const toX = (seconds) => ((seconds - viewStart) / (viewEnd - viewStart)) * width();
  const toTime = (x) => viewStart + (x / width()) * (viewEnd - viewStart);
  const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

  function setView(start, end) {
    const span = clamp(end - start, Math.min(SMALLEST_VIEW, duration), duration);
    viewStart = clamp(start, 0, duration - span);
    viewEnd = viewStart + span;
    draw();
  }

  function draw() {
    if (!duration || !width()) return;
    drawRuler();
    drawChat();
    drawSound();
    drawFilm();
    for (const { moment, element } of clips) {
      const span = shown.rangeFor(moment);
      stretch(element, span.start, span.end);
    }
    for (const { moment, element } of markers) {
      const visible = moment.time >= viewStart && moment.time <= viewEnd;
      element.hidden = !visible;
      if (visible) element.style.left = toX(moment.time) + 'px';
    }
    for (const { start, end, element } of quiet) stretch(element, start, end);
    drawRange();
    windowBox.style.left = (viewStart / duration) * 100 + '%';
    windowBox.style.width = ((viewEnd - viewStart) / duration) * 100 + '%';
    drawPlayhead();
  }

  // Lays a block over the strip from `start` to `end`. What sticks out past
  // the ends of the strip is cut off by the strip itself.
  function stretch(element, start, end) {
    element.hidden = end < viewStart || start > viewEnd;
    element.style.left = toX(start) + 'px';
    element.style.width = toX(end) - toX(start) + 'px';
  }

  function drawRange() {
    rangeBand.hidden = !range;
    if (range) stretch(rangeBand, range.start, range.end);
  }

  function drawPlayhead() {
    const x = toX(time);
    playhead.hidden = x < 0 || x > width();
    playhead.style.left = x + 'px';
    played.style.width = clamp(x, 0, width()) + 'px';
    // The same on the thin bar, where the whole video is always in view.
    overviewNow.style.left = (time / duration) * 100 + '%';
  }

  // Sizes a canvas to the strip and hands back a pen that draws in CSS pixels.
  function penFor(canvas) {
    const sharpness = window.devicePixelRatio || 1;
    canvas.width = width() * sharpness;
    canvas.height = canvas.clientHeight * sharpness;
    const pen = canvas.getContext('2d');
    pen.scale(sharpness, sharpness);
    return pen;
  }

  function drawRuler() {
    const pen = penFor(ruler);
    const height = ruler.clientHeight;
    const secondsPerPixel = (viewEnd - viewStart) / width();
    const step = TICK_STEPS.find((s) => s / secondsPerPixel >= LABEL_ROOM) || TICK_STEPS.at(-1);
    const small = step / 5; // four unlabelled ticks between two labelled ones

    pen.font = '10px "Geist Mono", Consolas, monospace';
    pen.textBaseline = 'top';
    for (let n = Math.ceil(viewStart / small); n * small <= viewEnd; n++) {
      const x = Math.round(toX(n * small)) + 0.5;
      const labelled = n % 5 === 0;
      pen.fillStyle = labelled ? '#ffffff38' : '#ffffff1f';
      pen.fillRect(x, labelled ? height - 12 : height - 5, 1, labelled ? 12 : 5);
      if (labelled) {
        pen.fillStyle = '#80828d'; // --faint in styles.css
        // Rounded, because 15 × 0.2 is not exactly 3 to a computer.
        pen.fillText(formatDuration(Math.round(n * small)), x + 5, 2);
      }
    }
  }

  // How busy the chat is, as hills along the bottom of the strip.
  function drawChat() {
    const pen = penFor(chatCanvas);
    const height = chatCanvas.clientHeight;
    pen.fillStyle = '#6fcf9c';
    const first = Math.max(0, Math.floor(viewStart / CHAT_BIN));
    const last = Math.min(chat.length - 1, Math.floor(viewEnd / CHAT_BIN));
    for (let bin = first; bin <= last; bin++) {
      const x = toX(bin * CHAT_BIN);
      const tall = chat[bin] * height;
      pen.fillRect(x, height - tall, Math.max(1, toX((bin + 1) * CHAT_BIN) - x), tall);
    }
  }

  // How loud the sound is, as thin bars either side of a middle line. The
  // bars where a moment is are bright, so the moments can be seen in the sound.
  function drawSound() {
    const pen = penFor(soundCanvas);
    const height = soundCanvas.clientHeight;
    if (sound.level.length === 0 || height === 0) return;
    const range = sound.loudest - sound.quietest || 1;
    for (let x = 0; x < width(); x += 2) {
      const from = Math.max(0, Math.floor(toTime(x) / sound.seconds));
      const to = Math.min(sound.level.length, Math.max(from + 1, Math.ceil(toTime(x + 2) / sound.seconds)));
      let loudest = -Infinity;
      for (let i = from; i < to; i++) loudest = Math.max(loudest, sound.level[i]);
      if (loudest === -Infinity) continue;
      const share = clamp((loudest - sound.quietest) / range, 0, 1);
      const tall = 2 + share * share * (height - 6);
      const seconds = toTime(x + 1);
      const inMoment = shown.moments.some((moment) => seconds >= moment.time - 2 && seconds <= moment.until + 3);
      pen.fillStyle = inMoment ? '#c9cad3' : '#3a3c45';
      pen.fillRect(x, (height - tall) / 2, 1, tall);
    }
  }

  // The video itself along its lane, as a row of its pictures side by side.
  // Each picture stands for the stretch of video under it and shows a frame
  // from inside that stretch. The frames are fetched one at a time by
  // work.js (showFilmPictures), so a picture starts as an empty tile.
  function drawFilm() {
    const wide = Math.round(filmLayer.clientHeight * FILM_SHAPE);
    if (!wide) return;
    // Seconds of video per picture. Rounded, so that sliding along at the
    // same zoom gives exactly the same number and keeps the tiles.
    const each = Math.round(((viewEnd - viewStart) / width()) * wide * 1000) / 1000;
    if (each !== filmEach) {
      // Zoomed: every picture now stands for a different stretch.
      film.clear();
      filmLayer.replaceChildren();
      filmEach = each;
    }
    // Frames are taken at round times (every 1, 2, 4, 8... seconds: the
    // largest such step that still gives each picture its own frame), so
    // after a zoom most of the frames wanted are ones already fetched.
    const step = Math.max(1, 2 ** Math.floor(Math.log2(each)));
    const lastFrame = Math.max(0, Math.floor(duration) - 1);
    const first = Math.floor(viewStart / each);
    const last = Math.ceil(Math.min(viewEnd, duration) / each) - 1;

    for (const [n, tile] of film) {
      if (n >= first && n <= last) continue;
      tile.remove();
      film.delete(n);
    }
    const missing = [];
    for (let n = first; n <= last; n++) {
      let tile = film.get(n);
      if (!tile) {
        tile = document.createElement('i');
        const picture = document.createElement('img');
        picture.alt = '';
        picture.hidden = true;
        tile.append(picture);
        // One pixel narrower than its place, which leaves a line between pictures.
        tile.style.width = wide - 1 + 'px';
        filmLayer.append(tile);
        film.set(n, tile);
      }
      tile.style.left = toX(n * each) + 'px';
      const picture = tile.firstChild;
      if (picture.hidden) missing.push({ second: Math.min(Math.ceil((n * each) / step) * step, lastFrame), image: picture });
    }
    showFilmPictures(missing);
  }

  // ---------- The mouse ----------

  function pointerX(event) {
    return clamp(event.clientX - main.getBoundingClientRect().left, 0, width());
  }

  main.addEventListener('pointerdown', (event) => {
    if (!duration || event.button !== 0) return;
    main.setPointerCapture(event.pointerId);
    api.onSeek(toTime(pointerX(event)));
  });

  main.addEventListener('pointermove', (event) => {
    if (!duration) return;
    const x = pointerX(event);
    const seconds = toTime(x);
    // Pointing at a marker shows that moment; anywhere else, the point itself.
    const marker = markers.find(({ element }) => element.contains(event.target));
    hover.hidden = false;
    hover.style.left = x + 'px';
    hoverTime.textContent = marker
      ? `${formatDuration(marker.moment.time)}  ${labelOf(marker.moment)}`
      : formatDuration(seconds);
    // The card is centred on the pointer, but never sticks out past the strip's ends.
    const half = hoverCard.offsetWidth / 2;
    let centre = clamp(x, half, Math.max(half, width() - half));
    // It rises over the buttons under the picture. Where it would cover the
    // clock there, it steps aside to whichever side is nearer.
    const edge = main.getBoundingClientRect().left;
    const around = clock.getBoundingClientRect();
    const from = around.left - edge - 8;
    const to = around.right - edge + 8;
    if (around.width && centre + half > from && centre - half < to) {
      centre = centre < (from + to) / 2 && from - half >= half ? from - half : to + half;
    }
    hoverCard.style.left = centre - x + 'px';
    showPreview(marker ? marker.moment.time : seconds);
    // Dragging with the button held down keeps jumping.
    if (main.hasPointerCapture(event.pointerId)) api.onSeek(seconds);
  });

  main.addEventListener('pointerleave', () => {
    hover.hidden = true;
  });

  // A double-click on the strip itself (not on a moment) shows the whole video again.
  main.addEventListener('dblclick', (event) => {
    if (!event.target.closest('.marker, .clip, .handle')) api.showAll();
  });

  // The small picture is a second, silent player that is sent to wherever
  // the pointer is. A jump takes it a moment, so while it is busy only the
  // latest place is remembered, and it goes there when it is free again.
  function showPreview(seconds) {
    if (preview.hidden) return;
    if (preview.seeking) previewWanted = seconds;
    else preview.currentTime = seconds;
  }

  preview.addEventListener('seeked', () => {
    if (previewWanted === null) return;
    preview.currentTime = previewWanted;
    previewWanted = null;
  });

  // No picture to show (sound only, or a format the player cannot decode).
  preview.addEventListener('error', () => {
    preview.hidden = true;
  });
  preview.addEventListener('loadedmetadata', () => {
    preview.hidden = preview.videoWidth === 0;
  });

  main.addEventListener('wheel', (event) => {
    if (!duration) return;
    event.preventDefault();
    const span = viewEnd - viewStart;
    if (event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
      const shift = ((event.deltaX || event.deltaY) / width()) * span;
      setView(viewStart + shift, viewEnd + shift);
      return;
    }
    // Zoom so that the point under the pointer stays under the pointer.
    const x = pointerX(event);
    const anchor = toTime(x);
    const newSpan = clamp(span * (event.deltaY < 0 ? 0.8 : 1.25), Math.min(SMALLEST_VIEW, duration), duration);
    const start = anchor - (x / width()) * newSpan;
    setView(start, start + newSpan);
  }, { passive: false });

  // The two edges of the selected moment's band: drag to move its start or end.
  for (const handle of rangeBand.children) {
    const drag = (event, finished) => {
      if (handle.hasPointerCapture(event.pointerId)) api.onRange(handle.dataset.edge, toTime(pointerX(event)), finished);
    };
    handle.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      // Stops the press from also counting as a jump to that point.
      event.stopPropagation();
      handle.setPointerCapture(event.pointerId);
    });
    handle.addEventListener('pointermove', (event) => drag(event, false));
    handle.addEventListener('pointerup', (event) => drag(event, true));
  }

  // The thin bar: click or drag to move the zoomed-in part.
  function moveWindow(event) {
    const box = overview.getBoundingClientRect();
    const centre = clamp((event.clientX - box.left) / box.width, 0, 1) * duration;
    const span = viewEnd - viewStart;
    setView(centre - span / 2, centre + span / 2);
  }

  overview.addEventListener('pointerdown', (event) => {
    if (!duration || event.button !== 0) return;
    overview.setPointerCapture(event.pointerId);
    moveWindow(event);
  });

  overview.addEventListener('pointermove', (event) => {
    if (overview.hasPointerCapture(event.pointerId)) moveWindow(event);
  });

  // The two buttons above the timeline: look closer, or see more, around
  // where the video is now.
  function zoomBy(factor) {
    if (!duration) return;
    const span = clamp((viewEnd - viewStart) * factor, Math.min(SMALLEST_VIEW, duration), duration);
    const centre = time >= viewStart && time <= viewEnd ? time : (viewStart + viewEnd) / 2;
    setView(centre - span / 2, centre + span / 2);
  }
  document.getElementById('zoom-in').addEventListener('click', () => zoomBy(0.5));
  document.getElementById('zoom-out').addEventListener('click', () => zoomBy(2));

  new ResizeObserver(draw).observe(main);

  // ---------- What the other scripts call ----------

  // Called when a video is opened, and with nothing when it is closed.
  api.setVideo = (url) => {
    previewWanted = null;
    preview.hidden = false;
    if (url) {
      preview.src = url;
    } else {
      preview.removeAttribute('src');
      preview.load();
    }
    // The film's pictures were the last video's.
    film.clear();
    filmLayer.replaceChildren();
    api.setQuiet([]);
    api.setChat([]);
    api.setSound([], 1);
    api.setRange(null);
  };

  api.setDuration = (seconds) => {
    duration = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
    time = 0;
    viewStart = 0;
    viewEnd = duration;
    // The moments can arrive before the video's length is known.
    build();
  };

  // `moments` are the ones to draw, `selected` the one to ring,
  // `colourFor(moment)` gives the colour of its category ('' if it has
  // none), and `rangeFor(moment)` where it starts and ends.
  api.setMoments = (moments, selected, colourFor, rangeFor) => {
    shown = { moments, selected, colourFor, rangeFor };
    build();
  };

  // `level` holds how loud the video is, one number per `seconds` of it.
  // The quietest and loudest twentieth are left out when deciding what
  // counts as quiet and loud, so one bang does not flatten everything else.
  api.setSound = (level, seconds) => {
    const sorted = [...level].sort((a, b) => a - b);
    sound = {
      level,
      seconds,
      quietest: sorted[Math.floor(sorted.length * 0.05)] ?? 0,
      loudest: sorted[Math.floor(sorted.length * 0.995)] ?? 1,
    };
    draw();
  };

  api.setRange = (newRange) => {
    range = newRange;
    if (duration) drawRange();
  };

  api.setQuiet = (stretches) => {
    quiet = stretches.map(({ start, end }) => {
      const element = document.createElement('i');
      return { start, end, element };
    });
    quietLayer.replaceChildren(...quiet.map((stretch) => stretch.element));
    draw();
  };

  api.setChat = (busyness) => {
    chat = busyness;
    draw();
  };

  // A marker and a clip are both the moment itself: a click selects it, a
  // right-click opens its menu.
  function makeClickable(element, moment) {
    // Stops the press from also counting as a jump to that exact point.
    element.addEventListener('pointerdown', (event) => event.stopPropagation());
    element.addEventListener('click', () => api.onMoment(moment));
    element.addEventListener('contextmenu', (event) => api.onContext(event, moment));
  }

  function build() {
    markerLayer.replaceChildren();
    clipLayer.replaceChildren();
    overviewMarks.replaceChildren();
    // A kept moment is drawn on the Video lane from its start to its end.
    clips = shown.moments.filter((moment) => moment.status === 'kept' && moment !== shown.selected).map((moment) => {
      const element = document.createElement('div');
      const name = document.createElement('span');
      element.className = 'clip ' + moment.kind.toLowerCase().replace(' ', '-');
      name.textContent = labelOf(moment);
      element.append(name);
      makeClickable(element, moment);
      clipLayer.append(element);
      return { moment, element };
    });
    markers = shown.moments.map((moment) => {
      // 'Raised voice' becomes the style name 'raised-voice'.
      const style = moment.kind.toLowerCase().replace(' ', '-');
      const element = document.createElement('button');
      element.type = 'button';
      element.tabIndex = -1;
      element.className = `marker ${style} ${moment.status}`;
      if (moment === shown.selected) element.classList.add('selected');
      // A kept moment gets a dot on top, in the colour of its category.
      if (moment.status === 'kept') {
        const cap = document.createElement('i');
        cap.className = 'cap';
        cap.style.background = shown.colourFor(moment) || '#e6b455'; // --accent in styles.css
        element.append(cap);
      }
      makeClickable(element, moment);
      markerLayer.append(element);

      if (duration) {
        const mark = document.createElement('i');
        mark.className = `${style} ${moment.status}`;
        mark.style.left = (moment.time / duration) * 100 + '%';
        overviewMarks.append(mark);
      }
      return { moment, element };
    });
    draw();
  }

  // `reveal` slides the strip so the new position is in view (used after a
  // jump). Without it the strip only follows when playback runs off its edge,
  // so looking around elsewhere while the video plays is not undone.
  api.setTime = (seconds, reveal) => {
    const wasInView = time >= viewStart && time <= viewEnd;
    time = seconds;
    if (!duration) return;
    const outOfView = time < viewStart || time > viewEnd;
    if (outOfView && (reveal || wasInView)) {
      const span = viewEnd - viewStart;
      const start = time - span * 0.1;
      setView(start, start + span);
    } else {
      drawPlayhead();
    }
  };

  // Shows `stretch` in the middle of the strip, `pixels` wide.
  function zoomOn(stretch, pixels) {
    if (!duration || !width()) return;
    const span = Math.max(stretch.end - stretch.start, 1) * (width() / pixels);
    const middle = (stretch.start + stretch.end) / 2;
    setView(middle - span / 2, middle + span / 2);
  }

  // Called when a moment is selected. Over a whole long video a moment is a
  // sliver with its two handles on top of each other; then the strip looks
  // closer, just far enough to leave something to grab.
  api.reveal = (stretch) => {
    if (!duration || !width()) return;
    const wide = ((stretch.end - stretch.start) / (viewEnd - viewStart)) * width();
    if (wide < THIN) zoomOn(stretch, ROOMY);
  };

  // The moment across a fifth of the strip, with what is around it on either side.
  api.zoomTo = (stretch) => zoomOn(stretch, width() / 5);

  api.showAll = () => {
    if (duration) setView(0, duration);
  };

  return api;
})();

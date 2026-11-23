// The strip under the player: the video laid out from left to right, with a
// ruler, a marker for every moment, and the playhead.
//
//   click or drag      jump to that point
//   point at it        shows the time and the picture there
//   mouse wheel        zoom in and out around the pointer
//   Shift + wheel      slide left and right
//   the thin bar below shows the whole video and which part is zoomed in on
//
// Behind the markers it also shows where nobody speaks (striped), how busy
// the chat is (the low green hills), and where the selected moment starts and
// ends (the lighter band, whose two edges can be dragged).
//
// The other scripts talk to it through `timeline`:
//   timeline.setVideo(url)                      a new video: forget the old one
//   timeline.setDuration(seconds)
//   timeline.setMoments(list, selected, colourFor)
//   timeline.setRange({ start, end } or null)   of the selected moment
//   timeline.setQuiet([{ start, end }])
//   timeline.setChat([0..1 per ten seconds])
//   timeline.setTime(seconds, reveal)
//   timeline.onSeek = (seconds) => ...
//   timeline.onMoment = (moment) => ...
//   timeline.onRange = (edge, seconds, finished) => ...   'start' or 'end' is being dragged
const timeline = (() => {
  const main = document.getElementById('timeline-main');
  const ruler = document.getElementById('timeline-ruler');
  const quietLayer = document.getElementById('timeline-quiet');
  const chatCanvas = document.getElementById('timeline-chat');
  const played = document.getElementById('timeline-played');
  const rangeBand = document.getElementById('timeline-range');
  const markerLayer = document.getElementById('timeline-markers');
  const hover = document.getElementById('timeline-hover');
  const hoverCard = document.getElementById('timeline-hover-card');
  const hoverTime = document.getElementById('timeline-hover-time');
  const preview = document.getElementById('timeline-preview');
  const playhead = document.getElementById('timeline-playhead');
  const overview = document.getElementById('timeline-overview');
  const overviewMarks = document.getElementById('timeline-overview-marks');
  const windowBox = document.getElementById('timeline-window');

  const SMALLEST_VIEW = 30; // seconds: how far in you can zoom
  // Distances between labelled ruler ticks, in seconds. The first one that
  // leaves the labels room to breathe is used.
  const TICK_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200];
  const LABEL_ROOM = 90; // pixels
  const CHAT_BIN = 10; // seconds per number of the chat's busyness

  const api = { onSeek() {}, onMoment() {}, onRange() {} };
  let duration = 0;
  let viewStart = 0; // the part of the video the strip is showing
  let viewEnd = 0;
  let time = 0;
  let markers = []; // [{ moment, element }]
  let shown = { moments: [], selected: null, colourFor: () => '' }; // what was last asked for
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

    pen.font = '10px Consolas, monospace';
    pen.textBaseline = 'top';
    for (let n = Math.ceil(viewStart / small); n * small <= viewEnd; n++) {
      const x = Math.round(toX(n * small)) + 0.5;
      const labelled = n % 5 === 0;
      pen.fillStyle = '#3a4050';
      pen.fillRect(x, labelled ? height - 12 : height - 5, 1, labelled ? 12 : 5);
      if (labelled) {
        pen.fillStyle = '#9aa1ad';
        // Rounded, because 15 × 0.2 is not exactly 3 to a computer.
        pen.fillText(formatDuration(Math.round(n * small)), x + 5, 2);
      }
    }
  }

  // How busy the chat is, as hills along the bottom of the strip.
  function drawChat() {
    const pen = penFor(chatCanvas);
    const height = chatCanvas.clientHeight;
    pen.fillStyle = '#6ee7a0';
    const first = Math.max(0, Math.floor(viewStart / CHAT_BIN));
    const last = Math.min(chat.length - 1, Math.floor(viewEnd / CHAT_BIN));
    for (let bin = first; bin <= last; bin++) {
      const x = toX(bin * CHAT_BIN);
      const tall = chat[bin] * height;
      pen.fillRect(x, height - tall, Math.max(1, toX((bin + 1) * CHAT_BIN) - x), tall);
    }
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
    hoverCard.style.left = clamp(x, half, Math.max(half, width() - half)) - x + 'px';
    showPreview(marker ? marker.moment.time : seconds);
    // Dragging with the button held down keeps jumping.
    if (main.hasPointerCapture(event.pointerId)) api.onSeek(seconds);
  });

  main.addEventListener('pointerleave', () => {
    hover.hidden = true;
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
    api.setQuiet([]);
    api.setChat([]);
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

  // `moments` are the ones to draw, `selected` the one to ring, and
  // `colourFor(moment)` gives the colour of its category ('' if it has none).
  api.setMoments = (moments, selected, colourFor) => {
    shown = { moments, selected, colourFor };
    build();
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

  function build() {
    markerLayer.replaceChildren();
    overviewMarks.replaceChildren();
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
        cap.style.background = shown.colourFor(moment) || '#fff';
        element.append(cap);
      }
      // Stops the click from also counting as a jump to that exact point.
      element.addEventListener('pointerdown', (event) => event.stopPropagation());
      element.addEventListener('click', () => api.onMoment(moment));
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

  return api;
})();

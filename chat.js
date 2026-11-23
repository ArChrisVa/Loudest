// The chat of a stream: reading it from a file, and finding where it went wild.
//
// Everywhere in the app a chat is a list of [seconds, text] pairs in time
// order: when a message was written, counted from the start of the video,
// and what it said.

const fs = require('node:fs');
const readline = require('node:readline');

// ---------- Reading a chat file ----------

// Reads a chat file into [[seconds, text], ...]. It recognises:
//   - what yt-dlp saves for a YouTube stream (one JSON object per line)
//   - what TwitchDownloader, RechatTool and chat-downloader save (one JSON document)
//   - plain text with a time at the start of each line, e.g. "[1:02:03] name: hello"
// Throws if it finds no messages.
//
// The file is read line by line because a busy stream's chat can be hundreds
// of megabytes, which is more than fits in memory as one piece of text.
async function readChatFile(file) {
  const messages = [];
  let isOneDocument = false;
  let first = true;

  // Some programs start a text file with an invisible mark; it is not part of the text.
  const withoutMark = (text) => text.replace(/^﻿/, '');

  const lines = readline.createInterface({ input: fs.createReadStream(file, 'utf8'), crlfDelay: Infinity });
  for await (const rawLine of lines) {
    const line = first ? withoutMark(rawLine) : rawLine;
    if (!line.trim()) continue;
    const fromText = fromTextLine(line);
    if (fromText) {
      messages.push(fromText);
    } else {
      let entry = null;
      try {
        entry = JSON.parse(line);
      } catch {
        // A first line that only opens a bracket: the whole file is one JSON
        // document, laid out over many lines.
        if (first && /^\s*[{[]/.test(line)) {
          isOneDocument = true;
          break;
        }
      }
      if (entry?.replayChatItemAction) messages.push(fromYouTube(entry));
      else if (entry) messages.push(...fromDocument(entry));
    }
    first = false;
  }
  lines.close();

  if (isOneDocument) messages.push(...fromDocument(JSON.parse(withoutMark(fs.readFileSync(file, 'utf8')))));

  const usable = messages
    .filter((message) => message && Number.isFinite(message[0]) && message[0] >= 0 && message[1])
    .sort((a, b) => a[0] - b[0]);
  if (usable.length === 0) throw new Error('No chat messages were found in that file');
  return usable;
}

// One line of a YouTube chat file. The message sits a few layers deep, and
// its words are a list of pieces: plain text, or an emoji. Returns null for
// lines that are not a message (deleted messages, banners, stickers...).
function fromYouTube(entry) {
  const replay = entry.replayChatItemAction;
  const item = replay.actions?.[0]?.addChatItemAction?.item;
  const message = item?.liveChatTextMessageRenderer ?? item?.liveChatPaidMessageRenderer;
  if (!Array.isArray(message?.message?.runs)) return null;
  // Written before the stream started. They all carry the time 0, and would
  // look like a burst of chat in the first second.
  if (message.timestampText?.simpleText?.startsWith('-')) return null;

  const words = message.message.runs.map((piece) => {
    if (!piece.emoji) return piece.text ?? '';
    // A normal emoji is the character itself. A channel's own emote only has
    // a name, like ":kekw:".
    return (piece.emoji.isCustomEmoji ? piece.emoji.shortcuts?.[0] : piece.emoji.emojiId) ?? '';
  });
  return [Number(replay.videoOffsetTimeMsec) / 1000, words.join('').trim()];
}

// A chat saved as one JSON document: a list of comments, or an object
// holding that list under `comments`. Each tool names its fields differently.
function fromDocument(data) {
  const comments = Array.isArray(data) ? data : data?.comments;
  if (!Array.isArray(comments)) return [];

  return comments.map((comment) => {
    const seconds = comment?.content_offset_seconds ?? comment?.contentOffsetSeconds ?? comment?.time_in_seconds;
    const message = comment?.message;
    const pieces = Array.isArray(message?.fragments) ? message.fragments.map((piece) => piece?.text ?? '').join('') : '';
    const words = typeof message === 'string' ? message : message?.body ?? pieces;
    return [Number(seconds), String(words ?? '').trim()];
  });
}

// One line of plain text: "[1:02:03] name: hello", "1:02:03 | name: hello",
// "[0:12:34] <name> hello", "02:03 hello". Returns null for anything else.
function fromTextLine(line) {
  const found = /^\s*\[?(?:(\d+):)?(\d{1,2}):(\d{2})(?:\.\d+)?\]?\s*(.*)$/.exec(line);
  if (!found) return null;
  const seconds = Number(found[1] ?? 0) * 3600 + Number(found[2]) * 60 + Number(found[3]);
  // Leave the name out, if the line has one.
  const words = found[4].replace(/^(?:<[^>]{1,40}>|[^:]{1,40}:)\s+/, '');
  return [seconds, words.trim()];
}

// ---------- Finding where the chat went wild ----------

// True for a message that is laughter: lol, lmao, kekw, xd, hahaha, and the
// Greek ways of writing it (χαχαχα, αχαχα, xaxaxa, axaxax), or a laughing emoji.
function isLaughing(words) {
  if (/[😂🤣💀]/u.test(words)) return true;
  const LAUGH = /^(?:lo+l+|lmf?a+o+|rofl|kekw*|lu+l+w*|omegalul|xd+|a?(?:ha){2,}h?|x?(?:ax){2,}a?|a?(?:xa){2,}x?|α?(?:χα){2,}χ?|χ?(?:αχ){2,}α?)$/;
  return words.toLowerCase().split(/[^\p{L}\p{N}]+/u).some((word) => LAUGH.test(word));
}

// The stretches where the chat is far busier than in the five minutes around
// them. A laughing message counts three times.
// Returns [{ time, until, kind: 'Chat', score }], in the form analysis.js joins
// with what it heard. `sensitivity` runs from 0 (strict) to 1 (loose).
function findChatSpikes(messages, sensitivity = 0.5) {
  const BIN = 5; // seconds per count
  const AROUND = 60; // counts in five minutes
  const EVERY = 12; // "normal" is worked out again every minute
  const BUSY_ENOUGH = 4 + (0.5 - sensitivity) * 3; // how far above normal counts
  const AT_LEAST = 5; // a spike in a nearly silent chat is not a spike
  // People type after the thing has happened. This is a guess.
  const DELAY = 6;
  if (messages.length === 0) return [];

  const bins = Math.floor(messages.at(-1)[0] / BIN) + 1;
  const activity = new Float32Array(bins);
  for (const [seconds, words] of messages) {
    activity[Math.floor(seconds / BIN)] += isLaughing(words) ? 3 : 1;
  }

  const above = new Float32Array(bins);
  for (let block = 0; block < bins; block += EVERY) {
    const nearby = activity.slice(Math.max(0, block - AROUND), Math.min(bins, block + EVERY + AROUND)).sort();
    const normal = nearby[nearby.length >> 1];
    const distances = nearby.map((value) => Math.abs(value - normal)).sort();
    // How much the counts usually vary; never less than one message.
    const spread = Math.max(distances[distances.length >> 1] * 1.4826, 1);
    for (let bin = block; bin < Math.min(bins, block + EVERY); bin++) {
      above[bin] = (activity[bin] - normal) / spread;
    }
  }

  const spikes = [];
  let current = null;
  for (let bin = 0; bin < bins; bin++) {
    if (above[bin] >= BUSY_ENOUGH && activity[bin] >= AT_LEAST) {
      if (!current) {
        current = { time: Math.max(0, bin * BIN - DELAY), until: 0, kind: 'Chat', score: 0 };
        spikes.push(current);
      }
      current.until = Math.max(current.time + BIN, (bin + 1) * BIN - DELAY);
      current.score = Math.max(current.score, above[bin]);
    } else {
      current = null;
    }
  }
  return spikes;
}

// How busy the chat is along the video, for drawing: one number from 0 to 1
// for every ten seconds.
function chatDensity(messages, duration) {
  const BIN = 10;
  const bins = Math.max(1, Math.ceil(Math.max(duration, messages.at(-1)?.[0] ?? 0) / BIN));
  const counts = new Float32Array(bins);
  for (const [seconds] of messages) counts[Math.min(bins - 1, Math.floor(seconds / BIN))] += 1;

  // Measured against a busy stretch, not the single busiest one, so one
  // enormous spike does not flatten everything else.
  const busy = counts.slice().sort()[Math.floor(bins * 0.99)] || 1;
  return Array.from(counts, (count) => Math.round(Math.min(1, count / busy) * 100) / 100);
}

module.exports = { readChatFile, findChatSpikes, chatDensity, isLaughing };

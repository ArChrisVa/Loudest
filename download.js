// Saves a file from the internet. Used for the helper programs and the speech
// model that are fetched the first time they are needed.

const fs = require('node:fs');
const path = require('node:path');
const { once } = require('node:events');
const { finished } = require('node:stream/promises');

// Saves what is at `url` as `file`. It is written under a temporary name
// first and renamed when it is complete, so a download that was cut short
// never looks like the real thing.
//   onProgress(fraction)   called as it arrives, when the size is known
//   signal                 an AbortSignal that stops the download
async function download(url, file, { onProgress, signal } = {}) {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  const total = Number(response.headers.get('content-length')) || 0;

  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = file + '.part';
  const out = fs.createWriteStream(temporary);
  let received = 0;
  try {
    for await (const chunk of response.body) {
      received += chunk.length;
      // Wait when the disk is slower than the network.
      if (!out.write(chunk)) await once(out, 'drain');
      if (total) onProgress?.(received / total);
    }
    out.end();
    await finished(out);
  } catch (error) {
    out.destroy();
    fs.rmSync(temporary, { force: true });
    throw error;
  }
  fs.renameSync(temporary, file);
}

module.exports = { download };

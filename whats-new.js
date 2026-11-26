// What's new: the changes worth knowing about in each version, shown once in
// a card after Loudest has updated to it, and any time from Help, What's new.
//
// For a release with something people should notice, add an entry at the top:
// a few short lines each, saying what it is and where to find it. Leave out
// fixes nobody would look for. `icon` is the name of one of the icons drawn at
// the top of index.html.
const RELEASE_NOTES = [
  {
    version: '2.0.0',
    highlights: [
      {
        icon: 'film-strip',
        title: 'A new look, built around a timeline',
        body: 'The moments are on the left, the video in the middle and the selected moment on the right. Under them, the timeline shows the moments, the video as a row of pictures, and how loud the sound is.',
      },
      {
        icon: 'scissors',
        title: 'Kept moments show as clips',
        body: 'A moment you keep lights up on the timeline from its start to its end. Drag either edge of the selected one to make it longer or shorter.',
      },
      {
        icon: 'text-align-left',
        title: 'Menus at the top',
        body: 'File, View and Help hold the actions and their keys. Help, Keyboard shortcuts lists every key.',
      },
      {
        icon: 'upload-simple',
        title: 'Loudest updates itself',
        body: 'From this version on, a newer one downloads by itself. When it is ready, Restart to update appears at the top.',
      },
    ],
  },
];

const whatsNew = document.getElementById('whats-new');
const whatsNewTitle = document.getElementById('whats-new-title');
const whatsNewList = document.getElementById('whats-new-list');

// -1, 0 or 1: compares versions like 1.0.14 number by number, so that 1.0.10
// comes after 1.0.9.
function compareVersions(one, other) {
  const numbers = (version) => version.split('.').map((part) => parseInt(part, 10) || 0);
  const a = numbers(one);
  const b = numbers(other);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const difference = (a[i] ?? 0) - (b[i] ?? 0);
    if (difference) return difference < 0 ? -1 : 1;
  }
  return 0;
}

// The notes to show after updating from version `seen` to `current`: every
// release after the one last seen, up to this one. When the version last
// seen is not known (a copy from before this card existed), only this
// version's notes.
function notesSince(seen, current) {
  if (!seen) return RELEASE_NOTES.filter((release) => release.version === current);
  return RELEASE_NOTES.filter((release) => compareVersions(release.version, seen) > 0 && compareVersions(release.version, current) <= 0);
}

// Opens the card with these releases' notes, the newest first. With none,
// nothing happens.
function showWhatsNew(notes) {
  if (notes.length === 0) return;
  const newest = notes[0].version;
  whatsNew.dataset.version = newest;
  whatsNewTitle.textContent = `What's new in Loudest ${newest}`;
  whatsNewList.replaceChildren(...notes.map((release) => {
    const items = release.highlights.map((highlight) => part('li', '',
      part('span', 'whats-new-icon', iconOf(highlight.icon)),
      part('span', 'whats-new-text', part('b', '', highlight.title), part('span', '', highlight.body))));
    const section = part('section', '', part('ul', '', ...items));
    // With several releases at once, each list says which one it is.
    if (notes.length > 1) section.prepend(part('h3', '', 'In ' + release.version));
    return section;
  }));
  whatsNew.showModal();
  // The keyboard goes to the card as a whole, not to its first button.
  whatsNew.focus();
}

document.getElementById('whats-new-ok').addEventListener('click', () => whatsNew.close());
// Every change of that version, on its page on GitHub.
document.getElementById('whats-new-all').addEventListener('click', () => window.loudest.openGitHub(whatsNew.dataset.version));
// While the card is open the keys belong to it: without this, A would keep a
// moment behind it (player.js). Enter on the card itself, where the keyboard
// is when it opens, means "Got it"; on a button, Enter presses that button.
whatsNew.addEventListener('keydown', (event) => {
  event.stopPropagation();
  if (event.code === 'Enter' && event.target === whatsNew) whatsNew.close();
});

// At the start: has this copy been updated since it last ran? Only the
// installed app asks (`announce`, from main.js). A first install has nothing
// to compare with, so it only notes its version; a copy that already has
// videos in it was there before, and gets the card.
Promise.all([window.loudest.updateStatus(), window.loudest.getSettings(), window.loudest.listRecent()]).then(async ([status, saved, videos]) => {
  if (!status.announce || saved.seenVersion === status.version) return;
  await window.loudest.setSettings({ seenVersion: status.version });
  if (videos.length > 0) showWhatsNew(notesSince(saved.seenVersion, status.version));
});

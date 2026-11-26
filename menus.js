// The File, View and Help menus in the top bar, and the keys that go with them.
//
// A menu is one of the page's own pop-up boxes (the "popover" in index.html):
// the browser opens it from its word in the bar, and closes it on Escape or
// on a click anywhere else. What is added here is what makes a row of them
// feel like menus: greyed-out items, moving with the arrow keys, sliding from
// one open menu to the next, and the Ctrl and Alt keys.

const menuButtons = [...document.querySelectorAll('.menubar > button')];
const menus = menuButtons.map((button) => button.popoverTargetElement);
const shortcutsBox = document.getElementById('shortcuts-box');

// What the items without a button of their own do.
const MENU_DOES = {
  home: showHome,
  exit: () => window.close(),
  shortcuts: () => shortcutsBox.showPopover(),
  github: () => window.loudest.openGitHub(),
};

// The button an item presses, if it has one.
const buttonOf = (item) => document.getElementById(item.dataset.press);

// Whether an item can be used right now: its button is there and not switched
// off, and a video is open if it needs one.
function canDo(item) {
  const button = buttonOf(item);
  if (button && (button.hidden || button.disabled)) return false;
  return !('needsVideo' in item.dataset && work.hidden);
}

function doItem(item) {
  const button = buttonOf(item);
  if (button) button.click();
  else MENU_DOES[item.dataset.do]();
}

// The items of a menu that the arrow keys stop at.
const usableItems = (menu) => [...menu.querySelectorAll('[role="menuitem"]')].filter((item) => !item.disabled && item.checkVisibility());

for (const menu of menus) {
  // Each time a menu opens, its items are brought up to date.
  menu.addEventListener('beforetoggle', (event) => {
    if (event.newState !== 'open') return;
    for (const item of menu.querySelectorAll('[role="menuitem"]')) {
      // An item whose button the app has taken away (Transcript, without the
      // speech program) is left out; the others stay in place and go grey.
      item.hidden = Boolean(buttonOf(item)?.hidden);
      item.disabled = !canDo(item);
    }
  });
  menu.addEventListener('toggle', (event) => {
    if (event.newState === 'open') usableItems(menu)[0]?.focus();
  });

  menu.addEventListener('click', (event) => {
    const item = event.target.closest('[role="menuitem"]');
    if (!item) return;
    menu.hidePopover();
    doItem(item);
  });

  menu.addEventListener('keydown', (event) => {
    // For the blink after a menu closes in which its item is still the one
    // the keyboard points at: the key is then not the menu's to take.
    if (!menu.matches(':popover-open')) return;
    // While a menu is open the keys belong to it: without this, A would keep
    // a moment and the arrows would move through the video (player.js).
    event.stopPropagation();
    const items = usableItems(menu);
    const at = items.indexOf(document.activeElement);
    const beside = { ArrowLeft: -1, ArrowRight: 1 }[event.code];
    if (event.code === 'ArrowDown') items[(at + 1) % items.length]?.focus();
    else if (event.code === 'ArrowUp') items[(at - 1 + items.length) % items.length]?.focus();
    else if (beside) menus[(menus.indexOf(menu) + beside + menus.length) % menus.length].showPopover();
    else return;
    event.preventDefault();
  });
}

// With one menu open, moving the mouse onto another word opens that one.
for (const button of menuButtons) {
  button.addEventListener('pointerenter', () => {
    const open = menus.find((menu) => menu.matches(':popover-open'));
    if (open && open !== button.popoverTargetElement) button.popoverTargetElement.showPopover();
  });
}

// Ctrl with a key does the item that names it, and Alt with F, V or H opens
// that menu, as in other Windows programs. Keys are named by where they sit
// on the keyboard, so they work the same when it is switched to Greek.
const MENU_KEYS = { KeyF: 'file-menu', KeyV: 'view-menu', KeyH: 'help-menu' };

window.addEventListener('keydown', (event) => {
  if (event.repeat || event.shiftKey || event.metaKey) return;
  // AltGr counts as Ctrl and Alt together, and means neither.
  if (event.ctrlKey === event.altKey) return;

  if (event.altKey) {
    const menu = document.getElementById(MENU_KEYS[event.code]);
    if (!menu) return;
    event.preventDefault();
    menu.showPopover();
    return;
  }

  const item = document.querySelector(`.menubar [data-key="${event.code}"]`);
  if (!item) return;
  event.preventDefault();
  if (canDo(item)) doItem(item);
});

window.loudest.version().then((version) => {
  document.getElementById('version').textContent = 'Version ' + version;
});

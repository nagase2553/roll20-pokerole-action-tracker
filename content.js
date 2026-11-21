/* ============================================================================
 * Roll20 Action Tracker – content script (GM side)
 *
 * Counts, per combatant and per round:
 *   - actions  : any roll whose name ends in "Accuracy", plus Evade and Clash
 *   - evade    : flag, set by an "Evade" roll or by clicking E (clicking also adds/removes one action)
 *   - clash    : flag, set by a "Clash" roll or by clicking C (clicking also adds/removes one action)
 * Damage rolls, generic rolls, ability checks and plain dice rolls are ignored.
 *
 * Everything you might need to tweak when Roll20 or your sheet changes lives
 * in the CFG block just below.
 * ========================================================================== */
(() => {
  'use strict';

  const IS_TEST = typeof module !== 'undefined' && !!module.exports;
  if (!IS_TEST) {
    if (window.__r20atLoaded) return;
    window.__r20atLoaded = true;
  }

  // ------------------------------------------------------------------ CONFIG
  const CFG = {
    maxActions: 5,          // number of X's before the overflow number appears
    pollMs: 700,            // how often the initiative tracker / chat attachment is checked
    removeAfterMisses: 3,   // a combatant must be missing this many polls in a row to be removed
    chatDelayMs: 100,       // small wait so a new chat message is fully rendered before parsing
    floatAfterMs: 8000,     // show the floating launcher if the toolbar isn't found after this long
    storeKey: 'r20at_state_v1',
    logo: 'logo.jpg',
    sel: {
      chat: '#textchat',
      message: '.message[data-messageid]',
      // "PMD" roll template (public rolls)
      rollContainer: '.sheet-roll-container',
      rollRow: '.sheet-roll-row',
      rollName: '.sheet-roll-name',
      rollChar: '.sheet-roll-grey',            // first one in the row = character name
      // "default" roll template (rolls from the other extension, public and whispered)
      defaultTemplate: '.sheet-rolltemplate-default',
      // Roll20 initiative tracker
      trackerList: '.turn-tracker .characterlist',
      trackerEntry: 'li.token',
      trackerName: '.name',
      trackerInit: '.initiative',
      // Roll20 toolbar (the launcher is cloned from the anchor)
      toolbarAnchor: '#turn-order-button',
      toolbarInsertBefore: '#more-tools-button',
    },
    re: {
      evade: /^evade$/i,
      clash: /^clash$/i,
      action: /(^|\s)accuracy$/i,              // whole word at the END of the roll name
      accuracyLabel: /^accuracy$/i,            // table-row label in the default template
      captionSplit: /^(.*?)\s*[—–]\s*(.+)$/,   // default-template caption: "Name — Roll"
      captionEvade: /(^|\s)evade$/i,           // roll part ends in the word Evade
      captionClash: /(^|\s)clash$/i,           // ...or Clash (so "Special Clash" / "Physical Clash" both match)
    },
  };

  // ---------------------------------------------------------------- HELPERS
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const keyOf = (s) => clean(s).toLowerCase();
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };
  const btn = (cls, text, title) => {
    const b = el('button', cls, text);
    b.type = 'button';
    if (title) b.title = title;
    return b;
  };

  // ---------------------------------------------------------- LOGGING / ERRORS
  // Everything is always logged to the browser console (F12 -> Console), tagged [R20AT],
  // so anyone hitting a problem can copy the lines straight out without enabling anything.
  // Tip: type  R20AT  in the console's filter box to see only this extension's lines.
  const TAG = '[R20AT]';
  const version = () => {
    try { return chrome.runtime.getManifest().version; } catch (e) { return '?'; }
  };
  const log = (...a) => console.log(TAG, ...a);
  const warn = (...a) => console.warn(TAG, ...a);
  const reportedErrors = new Set();
  let dead = false;

  function fail(where, err) {
    const msg = String((err && err.message) || err);
    if (/Extension context invalidated/i.test(msg)) {
      // The extension was reloaded/updated: this old copy can no longer work.
      if (!dead) {
        dead = true;
        clearInterval(pollTimer);
        clearInterval(launcherTimer);
        if (chatObs) chatObs.disconnect();
        warn('The extension was reloaded or updated. Refresh this Roll20 tab to reconnect.');
        toast('Extension was reloaded. Refresh this Roll20 tab to reconnect.');
      }
      return;
    }
    console.error(TAG, 'error in ' + where + ':', err);
    if (!reportedErrors.has(where)) { // one on-screen notice per problem area, not a flood
      reportedErrors.add(where);
      try { toast('Something went wrong in "' + where + '". Details are in the browser console (F12).'); } catch (e) { /* ignore */ }
    }
  }

  // Wrap a function so one failure can't break the timers/observers that call it
  function safe(where, fn) {
    return function (...args) {
      try { return fn.apply(this, args); } catch (err) { fail(where, err); }
    };
  }

  // ------------------------------------------------------------ RUNTIME STATE
  let state = null;            // persisted: { open, combatants, trackerSeen, lastId, pos }
  let ui = null;               // { panel, list, empty, toasts, confirm, rows }
  let pollTimer = null;
  let launcherTimer = null;
  let saveTimer = null;
  let chatMissingLogged = false;
  let trackerMissingLogged = false;
  let trackerNamesWarned = false;
  let chatObs = null;
  let chatEl = null;
  let baselineId = '';         // messages with an id <= this are "old" and never counted
  const processed = new Set(); // ids of messages already counted
  const ignoredLogged = new Set(); // ids whose "ignored" line was already logged (avoids repeats)
  const pending = new Set();   // ids waiting for their short parse delay
  const missing = new Map();   // combatant key -> consecutive polls it was absent
  const startedAt = Date.now();

  // ------------------------------------------------------------ MESSAGE PARSING
  function classifyRollName(name) {
    const n = clean(name);
    if (CFG.re.evade.test(n)) return 'evade';
    if (CFG.re.clash.test(n)) return 'clash';
    if (CFG.re.action.test(n)) return 'action';
    return null;
  }

  // Public rolls from the PMD template: <character> <roll name> [<target>]
  function parseRollTemplate(msg) {
    const container = msg.querySelector(CFG.sel.rollContainer);
    if (!container) return null;
    const nameEl = container.querySelector(CFG.sel.rollName);
    if (!nameEl) return null;
    const label = clean(nameEl.textContent);
    const kind = classifyRollName(label);
    if (!kind) return null;
    const row = nameEl.closest(CFG.sel.rollRow) || container;
    const charEl = row.querySelector(CFG.sel.rollChar) || container.querySelector(CFG.sel.rollChar);
    const name = charEl ? clean(charEl.textContent) : '';
    return name ? { kind, name, label } : { kind: 'unnamed', label };
  }

  // Rolls from the other extension use the "default" template, and the caption carries
  // the character name:  "Robert— Evade", "Hippopotas — Bite", "Robert— Special Clash".
  function splitCaption(text) {
    const t = clean(text);
    const m = CFG.re.captionSplit.exec(t);
    return m ? { name: clean(m[1]), roll: clean(m[2]) } : { name: '', roll: t };
  }

  function parseDefaultTemplate(msg) {
    const tpl = msg.querySelector(CFG.sel.defaultTemplate);
    if (!tpl) return null;
    const cap = tpl.querySelector('caption');
    const { name, roll } = splitCaption(cap && cap.textContent);
    const hasAccuracy = Array.from(tpl.querySelectorAll('tr')).some(
      (tr) => tr.cells[0] && CFG.re.accuracyLabel.test(clean(tr.cells[0].textContent))
    );
    let kind = null;
    if (hasAccuracy) kind = 'action';                       // an Accuracy row always wins
    else if (CFG.re.captionEvade.test(roll)) kind = 'evade';
    else if (CFG.re.captionClash.test(roll)) kind = 'clash';
    if (!kind) return null;
    return name ? { kind, name, label: roll } : { kind: 'unnamed', what: kind, label: roll };
  }

  function parseMessage(msg) {
    return parseRollTemplate(msg) || parseDefaultTemplate(msg);
  }

  // -------------------------------------------------------------- CHAT WATCHING
  function maxMessageId() {
    let max = '';
    document.querySelectorAll(CFG.sel.chat + ' ' + CFG.sel.message).forEach((m) => {
      const id = m.getAttribute('data-messageid');
      if (id && id > max) max = id;
    });
    return max;
  }

  function scheduleEvaluate(msg) {
    const id = msg.getAttribute('data-messageid');
    if (!id || processed.has(id) || pending.has(id) || id <= baselineId) return;
    pending.add(id);
    setTimeout(() => {
      pending.delete(id);
      if (state) safe('evaluate message', evaluate)(msg, id);
    }, CFG.chatDelayMs);
  }

  // Debug helper: why was this message not counted?
  function describeMessage(msg) {
    const n = msg.querySelector(CFG.sel.rollName);
    if (n) return 'roll "' + clean(n.textContent) + '" is not an action';
    const cap = msg.querySelector(CFG.sel.defaultTemplate + ' caption');
    if (cap) {
      return 'default-template roll "' + clean(cap.textContent) +
        '" is not an action (no Accuracy row, and the caption does not end in Evade or Clash)';
    }
    return 'not a roll template (chat text, dice roll, etc.)';
  }

  function evaluate(msg, id) {
    if (processed.has(id)) return;
    const ev = parseMessage(msg);
    if (id > state.lastId) {
      state.lastId = id;
      save();
    }
    if (!ev) {
      if (!ignoredLogged.has(id)) {
        ignoredLogged.add(id);
        log('message', id, 'ignored:', describeMessage(msg));
      }
      return;
    }
    log('message', id, 'recognised:', ev);
    processed.add(id);
    applyEvent(ev);
  }

  function onChatMutations(mutations) {
    const touched = new Set();
    for (const m of mutations) {
      m.addedNodes.forEach((n) => {
        if (n.nodeType !== 1) return;
        const owner = n.closest(CFG.sel.message);
        if (owner) touched.add(owner);
        else n.querySelectorAll(CFG.sel.message).forEach((x) => touched.add(x));
      });
    }
    touched.forEach(scheduleEvaluate);
  }

  function attachChat() {
    const chat = document.querySelector(CFG.sel.chat);
    if (!chat) {
      if (!chatMissingLogged && Date.now() - startedAt > 15000) {
        chatMissingLogged = true;
        warn('Chat container "' + CFG.sel.chat + '" not found; will keep retrying. Check CFG.sel.chat if this persists.');
      }
      return;
    }
    if (chatObs) chatObs.disconnect();
    chatEl = chat;
    chatObs = new MutationObserver(safe('chat observer', onChatMutations));
    chatObs.observe(chat, { childList: true, subtree: true });
    const existing = chat.querySelectorAll(CFG.sel.message);
    log('chat observer attached;', existing.length, 'messages already in chat; baseline id:', baselineId || '(none)');
    existing.forEach(scheduleEvaluate); // catch-up after a reload
  }

  function applyEvent(ev) {
    if (ev.kind === 'unnamed') {
      const what = { action: 'Accuracy roll', evade: 'Evade', clash: 'Clash' }[ev.what] || 'Accuracy roll';
      log(what + ' without a character name:', ev.label);
      toast(what + ' detected' + (ev.label ? ' (' + ev.label + ')' : '') + ', but no character name was found.');
      return;
    }
    const c = state.combatants[keyOf(ev.name)];
    if (!c) {
      // not in the initiative tracker: intentionally ignored
      log('ignored ' + ev.kind + ' from "' + ev.name + '": not in the initiative tracker. Tracked:',
        Object.values(state.combatants).map((x) => x.name));
      return;
    }
    c.actions += 1;
    if (ev.kind === 'evade' || ev.kind === 'clash') {
      const word = ev.kind === 'evade' ? 'Evade' : 'Clash';
      if (c[ev.kind]) toast(c.name + ' has already used ' + word + ' this round.');
      c[ev.kind] = true;
    }
    log('counted ' + ev.kind + ' for ' + c.name + ' -> actions:', c.actions, '| evade:', c.evade, '| clash:', c.clash);
    render();
    save();
  }

  // ------------------------------------------------------- INITIATIVE TRACKER
  function readTracker() {
    if (!state) return;
    const list = document.querySelector(CFG.sel.trackerList);
    if (!list) {
      // tracker window closed: keep the last known combatants
      if (!trackerMissingLogged) {
        trackerMissingLogged = true;
        log('initiative tracker not on screen; keeping last known combatants');
      }
      return;
    }
    if (trackerMissingLogged) {
      trackerMissingLogged = false;
      log('initiative tracker found');
    }

    const found = new Map();
    list.querySelectorAll(CFG.sel.trackerEntry).forEach((li) => {
      const nameEl = li.querySelector(CFG.sel.trackerName);
      const name = clean(nameEl && nameEl.textContent);
      const k = keyOf(name);
      if (!k || found.has(k)) return;
      const initEl = li.querySelector(CFG.sel.trackerInit);
      const n = parseFloat(clean(initEl && initEl.textContent));
      found.set(k, { name, init: Number.isFinite(n) ? n : null });
    });

    const entryCount = list.querySelectorAll(CFG.sel.trackerEntry).length;
    if (entryCount > 0 && found.size === 0 && !trackerNamesWarned) {
      trackerNamesWarned = true;
      warn('Found ' + entryCount + ' initiative entries but could not read any names. Check CFG.sel.trackerName.');
    }

    let changed = !state.trackerSeen;
    state.trackerSeen = true;

    found.forEach((v, k) => {
      missing.delete(k);
      const c = state.combatants[k];
      if (!c) {
        state.combatants[k] = { name: v.name, init: v.init, actions: 0, evade: false, clash: false };
        log('combatant added:', v.name, '(initiative ' + v.init + ')');
        changed = true;
      } else if (c.name !== v.name || c.init !== v.init) {
        c.name = v.name;
        c.init = v.init;
        changed = true;
      }
    });

    Object.keys(state.combatants).forEach((k) => {
      if (found.has(k)) return;
      const n = (missing.get(k) || 0) + 1;
      if (n >= CFG.removeAfterMisses) {
        log('combatant removed:', state.combatants[k].name);
        delete state.combatants[k];
        missing.delete(k);
        changed = true;
      } else {
        missing.set(k, n);
      }
    });

    if (changed) {
      render();
      save();
    }
  }

  // ------------------------------------------------------------- PERSISTENCE
  async function loadSaved() {
    try {
      const r = await chrome.storage.local.get(CFG.storeKey);
      return r[CFG.storeKey] || null;
    } catch (e) {
      warn('Could not read saved state (starting fresh):', e);
      return null;
    }
  }
  function save() {
    if (!state) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        const p = chrome.storage.local.set({ [CFG.storeKey]: state });
        if (p && p.catch) p.catch((e) => fail('save state', e));
      } catch (e) {
        fail('save state', e);
      }
    }, 150);
  }
  function clearStore() {
    clearTimeout(saveTimer);
    try { chrome.storage.local.remove(CFG.storeKey); } catch (e) { fail('clear saved state', e); }
  }

  // ------------------------------------------------------------------- PANEL
  function sortedKeys() {
    const cs = state.combatants;
    return Object.keys(cs).sort((a, b) => {
      const va = typeof cs[a].init === 'number' ? cs[a].init : -Infinity;
      const vb = typeof cs[b].init === 'number' ? cs[b].init : -Infinity;
      if (va !== vb) return va < vb ? 1 : -1;
      return a.localeCompare(b);
    });
  }

  function createRow(key) {
    const row = el('div', 'r20at-row');
    row.dataset.key = key;
    const name = el('span', 'r20at-name');
    const xs = el('span', 'r20at-xs');
    for (let i = 1; i <= CFG.maxActions; i++) {
      const x = btn('r20at-x', 'X');
      x.dataset.n = String(i);
      xs.append(x);
    }
    const over = el('span', 'r20at-over');
    const e = btn('r20at-flag', 'E', 'Evade used (click also adds/removes one action)');
    e.dataset.flag = 'evade';
    const c = btn('r20at-flag', 'C', 'Clash used (click also adds/removes one action)');
    c.dataset.flag = 'clash';
    row.append(name, xs, over, e, c);
    return row;
  }

  function updateRow(row, c) {
    const name = row.querySelector('.r20at-name');
    name.textContent = c.name;
    name.title = c.name;

    const filled = Math.min(c.actions, CFG.maxActions);
    row.querySelectorAll('.r20at-x').forEach((x, i) => x.classList.toggle('r20at-on', i < filled));

    const over = row.querySelector('.r20at-over');
    let input = over.firstElementChild;
    const extra = c.actions - CFG.maxActions;
    if (extra > 0) {
      if (!input) {
        input = el('input', 'r20at-over-input');
        input.type = 'number';
        input.min = '0';
        input.step = '1';
        input.title = 'Extra actions (editable)';
        over.append(input);
      }
      if (document.activeElement !== input) input.value = String(extra);
    } else if (input) {
      input.remove();
    }

    row.querySelector('[data-flag="evade"]').classList.toggle('r20at-on', !!c.evade);
    row.querySelector('[data-flag="clash"]').classList.toggle('r20at-on', !!c.clash);
  }

  function render() {
    if (!ui || !state) return;
    const keys = sortedKeys();

    ui.empty.textContent = state.trackerSeen
      ? 'The initiative tracker is empty.'
      : 'Please activate initiative tracker to start';
    ui.empty.style.display = keys.length ? 'none' : '';

    for (const [k, row] of ui.rows) {
      if (!state.combatants[k]) { row.remove(); ui.rows.delete(k); }
    }
    for (const k of keys) {
      let row = ui.rows.get(k);
      if (!row) { row = createRow(k); ui.rows.set(k, row); ui.list.append(row); }
      updateRow(row, state.combatants[k]);
    }
    // Only reorder when the order really changed (moving nodes would drop input focus)
    const have = Array.from(ui.list.querySelectorAll('.r20at-row')).map((r) => r.dataset.key);
    if (have.join('\u0000') !== keys.join('\u0000')) keys.forEach((k) => ui.list.append(ui.rows.get(k)));
  }

  function onListClick(e) {
    if (!state) return;
    const row = e.target.closest('.r20at-row');
    if (!row) return;
    const c = state.combatants[row.dataset.key];
    if (!c) return;
    const x = e.target.closest('.r20at-x');
    const f = e.target.closest('.r20at-flag');
    if (x) {
      const n = Number(x.dataset.n);
      c.actions = c.actions === n ? n - 1 : n; // clicking the last filled X removes one
    } else if (f) {
      // Toggling a flag also adds (on) or removes (off) one action, saving a click
      const flag = f.dataset.flag;
      c[flag] = !c[flag];
      c.actions = Math.max(0, c.actions + (c[flag] ? 1 : -1));
    } else {
      return;
    }
    log('manual edit:', c.name, '-> actions:', c.actions, '| evade:', c.evade, '| clash:', c.clash);
    render();
    save();
  }

  function onListChange(e) {
    if (!state || !e.target.matches('.r20at-over-input')) return;
    const row = e.target.closest('.r20at-row');
    const c = row && state.combatants[row.dataset.key];
    if (!c) return;
    const v = Math.floor(Number(e.target.value));
    c.actions = CFG.maxActions + (Number.isFinite(v) && v > 0 ? v : 0);
    log('manual edit (overflow):', c.name, '-> actions:', c.actions);
    render();
    save();
  }

  // Keep typing in the overflow box away from Roll20's keyboard shortcuts
  function onListKey(e) {
    if (!e.target.matches || !e.target.matches('.r20at-over-input')) return;
    e.stopPropagation();
    if (e.type === 'keydown' && e.key === 'Enter') e.target.blur();
  }

  function toast(text) {
    if (!ui) return;
    const t = el('div', 'r20at-toast');
    const ok = btn('r20at-toast-ok', 'OK', 'Dismiss');
    ok.addEventListener('click', () => t.remove());
    t.append(el('span', 'r20at-toast-text', text), ok);
    ui.toasts.append(t);
    while (ui.toasts.children.length > 4) ui.toasts.firstElementChild.remove();
  }

  function askConfirm(text, onYes) {
    if (!ui) return;
    const hide = () => { if (ui) ui.confirm.classList.remove('r20at-show'); };
    const yes = btn('r20at-confirm-btn r20at-confirm-yes', 'Yes');
    const no = btn('r20at-confirm-btn r20at-confirm-no', 'Cancel');
    yes.addEventListener('click', () => { hide(); onYes(); });
    no.addEventListener('click', hide);
    const box = el('div', 'r20at-confirm-box');
    box.append(el('p', null, text), yes, no);
    ui.confirm.replaceChildren(box);
    ui.confirm.classList.add('r20at-show');
  }

  function newRound() {
    if (!state) return;
    Object.values(state.combatants).forEach((c) => {
      c.actions = 0;
      c.evade = false;
      c.clash = false;
    });
    if (ui) ui.toasts.replaceChildren();
    log('new round: all actions and flags cleared');
    render();
    save();
  }

  function place(panel, left, top) {
    const l = Math.max(0, Math.min(left, window.innerWidth - 60));
    const t = Math.max(0, Math.min(top, window.innerHeight - 30));
    panel.style.left = l + 'px';
    panel.style.top = t + 'px';
  }

  function enableDrag(panel, handle) {
    handle.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button')) return;
      const r = panel.getBoundingClientRect();
      const dx = e.clientX - r.left;
      const dy = e.clientY - r.top;
      handle.setPointerCapture(e.pointerId);
      const move = (ev) => place(panel, ev.clientX - dx, ev.clientY - dy);
      const up = () => {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
        handle.removeEventListener('pointercancel', up);
        if (state) {
          const r2 = panel.getBoundingClientRect();
          state.pos = { left: r2.left, top: r2.top };
          save();
        }
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
      handle.addEventListener('pointercancel', up);
      e.preventDefault();
    });
  }

  function buildPanel() {
    const panel = el('div', 'r20at-panel');

    const header = el('div', 'r20at-header');
    const closeBtn = btn('r20at-close', '✕', 'Close tracker');
    header.append(el('span', 'r20at-title', 'Action Tracker'), closeBtn);

    const list = el('div', 'r20at-list');
    const empty = el('div', 'r20at-empty');
    list.append(empty);

    const toasts = el('div', 'r20at-toasts');

    const footer = el('div', 'r20at-footer');
    const roundBtn = btn('r20at-round', 'New Round');
    footer.append(roundBtn);

    const confirm = el('div', 'r20at-confirm');

    panel.append(header, list, toasts, footer, confirm);
    document.body.append(panel);
    ui = { panel, list, empty, toasts, confirm, rows: new Map() };

    closeBtn.addEventListener('click', requestClose);
    roundBtn.addEventListener('click', () =>
      askConfirm('Start a new round? All actions and Evade/Clash flags will be cleared.', newRound)
    );
    list.addEventListener('click', safe('row click', onListClick));
    list.addEventListener('change', safe('overflow edit', onListChange));
    ['keydown', 'keyup', 'keypress'].forEach((t) => list.addEventListener(t, onListKey));
    enableDrag(panel, header);

    const pos = state.pos || { left: 260, top: 100 };
    place(panel, pos.left, pos.top);
  }

  // ------------------------------------------------------------ OPEN / CLOSE
  function tick() {
    readTracker();
    if (!chatEl || !chatEl.isConnected) attachChat();
  }

  function openTracker(saved) {
    if (state) return;
    const fresh = !saved;
    state = saved || { open: true, combatants: {}, trackerSeen: false, lastId: '', pos: null };
    state.open = true;
    if (fresh) state.lastId = maxMessageId();
    baselineId = state.lastId || '';
    processed.clear();
    ignoredLogged.clear();
    pending.clear();
    missing.clear();
    buildPanel();
    render();
    safe('first poll', tick)();
    pollTimer = setInterval(safe('poll', tick), CFG.pollMs);
    save();
    updateLauncher();
    log('opened (' + (fresh ? 'fresh' : 'restored after reload') + '); baseline message id:',
      baselineId || '(none)', '| combatants:', Object.keys(state.combatants).length);
  }

  function closeTracker() {
    clearInterval(pollTimer);
    pollTimer = null;
    if (chatObs) chatObs.disconnect();
    chatObs = null;
    chatEl = null;
    if (ui) ui.panel.remove();
    ui = null;
    state = null;
    clearStore();
    updateLauncher();
    log('closed; saved state cleared');
  }

  function requestClose() {
    askConfirm('Close the tracker? Counting stops and all counts are cleared.', closeTracker);
  }

  // ---------------------------------------------------------------- LAUNCHER
  function logoUrl() {
    try { return chrome.runtime.getURL(CFG.logo); } catch (e) { return ''; }
  }
  function logoImg() {
    const i = document.createElement('img');
    i.className = 'r20at-logo';
    i.src = logoUrl();
    i.alt = 'Action Tracker';
    return i;
  }

  function onLauncherClick(e) {
    try {
      e.preventDefault();
      e.stopPropagation();
      if (!state) openTracker(null);
      else requestClose();
    } catch (err) {
      fail('launcher click', err);
    }
  }

  function buildToolbarButton(anchor) {
    const clone = anchor.cloneNode(true); // keeps Roll20's scoped styling
    clone.id = 'r20at-button';
    const slot = clone.querySelector('.icon-slot');
    if (slot) {
      slot.classList.remove('icon-selected');
      slot.style.backgroundColor = '';
      slot.replaceChildren(logoImg());
    }
    const b = clone.querySelector('button');
    if (b) {
      b.title = 'Action Tracker';
      b.addEventListener('click', onLauncherClick);
    }
    return clone;
  }

  function buildFloatingButton() {
    const b = el('button', 'r20at-float');
    b.id = 'r20at-float';
    b.type = 'button';
    b.title = 'Action Tracker';
    b.append(logoImg());
    b.addEventListener('click', onLauncherClick);
    document.body.append(b);
  }

  function ensureLauncher() {
    const anchor = document.querySelector(CFG.sel.toolbarAnchor);
    const parent = anchor && anchor.parentElement;
    if (parent) {
      const fl = document.getElementById('r20at-float');
      if (fl) fl.remove();
      if (!document.getElementById('r20at-button')) {
        const ref = document.querySelector(CFG.sel.toolbarInsertBefore);
        parent.insertBefore(buildToolbarButton(anchor), ref && ref.parentElement === parent ? ref : null);
        log('toolbar button injected');
      }
    } else if (!document.getElementById('r20at-float') && Date.now() - startedAt > CFG.floatAfterMs) {
      buildFloatingButton();
      log('toolbar anchor "' + CFG.sel.toolbarAnchor + '" not found; using the floating button');
    }
    updateLauncher();
  }

  function updateLauncher() {
    const on = !!state;
    const tb = document.getElementById('r20at-button');
    const slot = tb && tb.querySelector('.icon-slot');
    if (slot) {
      slot.classList.toggle('icon-selected', on);
      slot.style.backgroundColor = on ? 'var(--vtt-toolbar-active-selection-bg)' : '';
    }
    const fl = document.getElementById('r20at-float');
    if (fl) fl.classList.toggle('r20at-active', on);
  }

  // -------------------------------------------------------------------- INIT
  async function init() {
    try {
      log('content script loaded, version ' + version());
      const saved = await loadSaved();
      if (saved && saved.open && saved.combatants) openTracker(saved);
      ensureLauncher();
      launcherTimer = setInterval(safe('launcher', ensureLauncher), 1000);
    } catch (err) {
      fail('init', err);
    }
  }

  if (IS_TEST) {
    module.exports = {
      parseMessage, classifyRollName, openTracker, closeTracker, scheduleEvaluate,
      readTracker, newRound, ensureLauncher, render,
      _get: () => ({ state, ui }),
    };
    return;
  }
  init();
})();

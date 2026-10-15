/**
 * The dropdown, shared by the popup and the settings page.
 *
 * A listbox rather than a <select> for one reason: the native control cannot
 * show that an option is locked behind Pro. Hiding the Pro formats entirely
 * means nobody discovers what Pro buys, so they stay listed, chipped, and
 * unselectable. Once one picker on a page is custom, the rest have to be too,
 * or the page has two kinds of dropdown in it.
 *
 * The list is positioned absolutely and flipped above the button when there is
 * no room below. In a browser action popup that is not cosmetic: the popup is
 * sized to its document, so a list in the normal flow makes the whole popup
 * grow and shrink as it opens and closes.
 *
 * @license MIT
 */
(function (root) {
  'use strict';
  const AISE = (root.AISE = root.AISE || {});

  /** Space left between the open list and the edge of the window. */
  const EDGE_GAP = 10;
  /** Never taller than this, however much room there is. */
  const MAX_HEIGHT = 260;
  /** Below this, flipping above the button gains enough to be worth it. */
  const MIN_HEIGHT = 96;

  /**
   * @param {HTMLElement} host - an empty element; the control is built inside it
   * @param {Object} [config]
   * @param {string} [config.label] - accessible name for the listbox
   * @param {string} [config.caret] - id of an inlined <symbol> for the caret
   * @param {function(string): void} [config.onPick] - called with the new value
   */
  function create(host, config) {
    const options = config || {};
    let entries = [];
    let value = null;
    let disabled = false;

    host.classList.add('picker');

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'picker-btn';
    button.setAttribute('aria-haspopup', 'listbox');
    button.setAttribute('aria-expanded', 'false');
    if (options.label) button.setAttribute('aria-label', options.label);

    const valueNode = document.createElement('span');
    valueNode.className = 'picker-value';
    button.appendChild(valueNode);

    // The caret is an inlined symbol on both pages; drawn inline here so the
    // component works on a page that has not defined one.
    const caret = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    if (options.caret) {
      const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
      use.setAttribute('href', `#${options.caret}`);
      caret.appendChild(use);
    } else {
      caret.setAttribute('viewBox', '0 0 24 24');
      caret.setAttribute('fill', 'none');
      caret.setAttribute('stroke', 'currentColor');
      caret.setAttribute('stroke-width', '2.4');
      caret.setAttribute('stroke-linecap', 'round');
      caret.setAttribute('stroke-linejoin', 'round');
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', 'm6 9.5 6 6 6-6');
      caret.appendChild(path);
    }
    button.appendChild(caret);

    const list = document.createElement('div');
    list.className = 'picker-list';
    list.setAttribute('role', 'listbox');
    if (options.label) list.setAttribute('aria-label', options.label);
    list.hidden = true;

    host.appendChild(button);
    host.appendChild(list);

    const isOpen = () => button.getAttribute('aria-expanded') === 'true';

    /**
     * Fit the list into whatever room there actually is.
     *
     * Two boxes constrain it and the smaller wins. The viewport is the obvious
     * one. The other is the document: a browser action popup is sized to its
     * content, so a list hanging past the last element makes Chrome grow the
     * whole popup, which is the thing an overlaid dropdown exists to avoid.
     * On the settings page the document is taller than the viewport, so the
     * viewport wins and this costs nothing.
     *
     * Must be called while the list is still hidden, or it measures itself.
     */
    function place() {
      const rect = button.getBoundingClientRect();
      // How far the content itself reaches, in viewport coordinates so it can
      // be compared with a bounding rect. body rather than documentElement:
      // documentElement.clientHeight is the viewport, which is the number we
      // are trying not to use.
      const contentBottom = document.body.scrollHeight - window.scrollY;

      const below = Math.min(window.innerHeight, contentBottom) - rect.bottom - EDGE_GAP;
      const above = rect.top - EDGE_GAP;
      const flip = below < MIN_HEIGHT && above > below;

      list.classList.toggle('is-above', flip);
      list.style.maxHeight = `${Math.min(MAX_HEIGHT, flip ? above : below)}px`;
    }

    function open() {
      if (disabled || !entries.length) return;
      // Placed before it is shown: an open list is part of the document it is
      // being measured against.
      place();
      list.hidden = false;
      button.setAttribute('aria-expanded', 'true');
      const current = list.querySelector('[aria-selected="true"]:not([aria-disabled="true"])');
      const first = list.querySelector('.picker-opt:not([aria-disabled="true"])');
      if (current || first) (current || first).focus();
    }

    function close(refocus) {
      list.hidden = true;
      list.classList.remove('is-above');
      button.setAttribute('aria-expanded', 'false');
      if (refocus) button.focus();
    }

    function paintSelection() {
      const entry = entries.find((item) => item.value === value);
      valueNode.textContent = entry ? entry.label : '';
      valueNode.classList.toggle('is-empty', !entry);
      for (const node of list.children) {
        node.setAttribute('aria-selected', String(node.dataset.value === value));
      }
    }

    /**
     * @param {Array<{value: string, label: string, chip?: string, disabled?: boolean}>} next
     * @param {string} [selected] - defaults to the current value
     */
    function setOptions(next, selected) {
      entries = next.slice();
      list.textContent = '';

      for (const entry of entries) {
        const option = document.createElement('button');
        option.type = 'button';
        option.className = 'picker-opt';
        option.dataset.value = entry.value;
        option.setAttribute('role', 'option');
        if (entry.disabled) option.setAttribute('aria-disabled', 'true');

        const name = document.createElement('span');
        name.textContent = entry.label;
        option.appendChild(name);

        if (entry.chip) {
          const chip = document.createElement('span');
          chip.className = 'chip';
          chip.textContent = entry.chip;
          option.appendChild(chip);
        }

        option.addEventListener('click', () => {
          if (entry.disabled) return;
          setValue(entry.value, true);
          close(true);
        });
        list.appendChild(option);
      }

      // A value that has just become unselectable, typically because a licence
      // was removed, must not stay showing as the choice.
      const wanted = selected === undefined ? value : selected;
      const usable = entries.find((entry) => entry.value === wanted && !entry.disabled);
      value = usable ? wanted : null;
      paintSelection();
    }

    /** @param {boolean} [notify] - fire onPick; false when restoring state */
    function setValue(next, notify) {
      const entry = entries.find((item) => item.value === next);
      if (!entry || entry.disabled) return false;
      value = next;
      paintSelection();
      if (notify && options.onPick) options.onPick(next);
      return true;
    }

    button.addEventListener('click', () => (isOpen() ? close(false) : open()));

    list.addEventListener('keydown', (event) => {
      const nodes = [...list.children];
      const at = nodes.indexOf(document.activeElement);
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const step = event.key === 'ArrowDown' ? 1 : -1;
        const next = nodes[at + step] || nodes[step === 1 ? 0 : nodes.length - 1];
        next.focus();
      } else if (event.key === 'Escape') {
        close(true);
      } else if (event.key === 'Tab') {
        close(false);
      }
    });

    button.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
        if (!isOpen()) {
          event.preventDefault();
          open();
        }
      }
    });

    document.addEventListener('click', (event) => {
      if (isOpen() && !host.contains(event.target)) close(false);
    });
    // Resizing or scrolling under an open list leaves it in the wrong place,
    // and in the popup the window resizes whenever the export state changes.
    window.addEventListener('resize', () => { if (isOpen()) place(); });

    return {
      host,
      button,
      list,
      setOptions,
      setValue,
      get value() { return value; },
      get disabled() { return disabled; },
      set disabled(next) {
        disabled = !!next;
        button.disabled = disabled;
        if (disabled) close(false);
      },
      close: () => close(false),
    };
  }

  AISE.listbox = { create };
})(typeof globalThis !== 'undefined' ? globalThis : self);

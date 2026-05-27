/* c8 ignore start -- main entry point for the background service worker */

import type {Menus, Tabs as BrowserTabs} from "webextension-polyfill";
import browser from "webextension-polyfill";

import {copyIf} from "./model/index.js";
import type {ShowWhatOpt, StashWhatOpt} from "./model/options.js";
import type {Tab} from "./model/tabs.js";
import service_model from "./service-model.js";
import type * as M from "./model/index.js";
import {asyncEvent} from "./util/index.js";

const GC_ALARM = "tab-stash-gc";
const DAY_IN_MINUTES = 24 * 60;

let model_promise: Promise<M.Model> | undefined;
const side_panel_open_windows = new Set<number>();

browser.runtime.onInstalled.addListener(
  asyncEvent(async details => {
    create_context_menus();
    await ensure_alarms();
    await configure_side_panel();

    const model = await get_model();
    if (details.reason === "install" || needs_setup(model)) {
      show_setup_page(model);
    }
  }),
);

browser.runtime.onStartup.addListener(
  asyncEvent(async () => {
    await ensure_alarms();
    await configure_side_panel();
    await get_model();
  }),
);

let cached_browser_action_show: ShowWhatOpt | undefined;
let cached_open_stash_in: ShowWhatOpt | undefined;
browser.storage.sync
  .get("options")
  .then(res => {
    if (res.options?.state?.browser_action_show) {
      cached_browser_action_show = res.options.state.browser_action_show;
    }
    if (res.options?.state?.open_stash_in) {
      cached_open_stash_in = res.options.state.open_stash_in;
    }
  })
  .catch(() => {});

browser.action.onClicked.addListener(
  asyncEvent(async tab => {
    const is_side_panel = cached_browser_action_show === "side_panel";
    if (is_side_panel) {
      toggle_side_panel(tab).catch(console.error);
    }

    const model = await get_model();
    const opts = model.options.sync.state;

    // Special case so the user doesn't think Tab Stash is broken.
    if (needs_toolbar_setup(model)) {
      show_setup_page(model);
      return;
    }

    const t = tab.id ? model.tabs.tab(tab.id) : undefined;
    if (opts.browser_action_show !== "side_panel") {
      show_something(model, opts.browser_action_show, t, tab);
    }
    await stash_something(model, {
      what: opts.browser_action_stash,
      tab: t,
    });
  }),
);

browser.commands.onCommand.addListener(
  asyncEvent(async (command, tab) => {
    if (command === "show_side_panel") {
      toggle_side_panel(tab).catch(console.error);
    }
  }),
);

browser.contextMenus.onClicked.addListener(
  asyncEvent(async (info, tab) => {
    const cmd = String(info.menuItemId).replace(/^[^:]*:/, "");
    if (cmd === "show_side_panel") {
      toggle_side_panel(tab).catch(console.error);
      return;
    }
    if (
      cached_open_stash_in === "side_panel" &&
      [
        "stash_all",
        "stash_one",
        "stash_one_newgroup",
        "copy_all",
        "copy_one",
      ].includes(cmd)
    ) {
      open_side_panel(tab).catch(console.error);
    }
    const model = await get_model();
    const t = tab?.id ? model.tabs.tab(tab.id) : undefined;
    const command = commands(model)[cmd];
    console.assert(!!command);
    if (command) await command(t, tab);
  }),
);

browser.bookmarks.onChanged.addListener(
  asyncEvent(async () => {
    await get_model();
  }),
);
browser.bookmarks.onMoved.addListener(
  asyncEvent(async () => {
    await get_model();
  }),
);
browser.bookmarks.onRemoved.addListener(
  asyncEvent(async () => {
    await get_model();
  }),
);

browser.alarms.onAlarm.addListener(
  asyncEvent(async alarm => {
    if (alarm.name !== GC_ALARM) return;
    const model = await get_model();
    await gc(model);
  }),
);

browser.storage.onChanged.addListener(
  asyncEvent(async (changes, area) => {
    if (area !== "sync") return;
    if (!("options" in changes)) return;

    const model = await get_model();
    await configure_action(model);
  }),
);

void ensure_alarms();
void configure_side_panel();
void track_side_panel_state();
void get_model();

async function get_model(): Promise<M.Model> {
  model_promise ??= service_model()
    .then(async model => {
      (<any>globalThis).model = model;

      // Delete old DBs that are in the wrong format.
      indexedDB.deleteDatabase("cache:favicons");
      indexedDB.deleteDatabase("cache:bookmarks");

      await migrate_options(model);
      await configure_action(model);

      cached_browser_action_show = model.options.sync.state.browser_action_show;
      cached_open_stash_in = model.options.sync.state.open_stash_in;

      model.options.sync.onChanged.addListener(() => {
        cached_browser_action_show =
          model.options.sync.state.browser_action_show;
        cached_open_stash_in = model.options.sync.state.open_stash_in;
        model.attempt(() => configure_action(model));
      });

      if (model.options.local.state.last_notified_version === undefined) {
        model.attempt(async () =>
          model.options.local.set({
            last_notified_version: (await browser.management.getSelf()).version,
          }),
        );
      }

      return model;
    })
    .catch(e => {
      model_promise = undefined;
      throw e;
    });

  return model_promise;
}

async function migrate_options(model: M.Model) {
  const sync = model.options.sync.state;

  const sync_updates: {
    open_stash_in?: ShowWhatOpt;
    browser_action_show?: ShowWhatOpt;
  } = {};
  if (sync.open_stash_in === "side_panel")
    sync_updates.open_stash_in = "side_panel";
  if (sync.browser_action_show === "side_panel")
    sync_updates.browser_action_show = "side_panel";
  if (Object.keys(sync_updates).length > 0) {
    await model.options.sync.set(sync_updates);
  }

  await model.options.local.set({after_stashing_tab: "close"});
}

async function configure_action(model: M.Model) {
  await configure_action_popup(model);
  await configure_action_title(model);
}

async function configure_action_popup(model: M.Model) {
  if (model.options.sync.state.browser_action_show === "popup") {
    await browser.action.setPopup({popup: "stash-list.html?view=popup"});
  } else {
    await browser.action.setPopup({popup: ""});
  }
}

async function configure_action_title(model: M.Model) {
  function get_title(stash?: StashWhatOpt): string {
    switch (stash) {
      case "all":
        return "Stash all (or selected) tabs";
      case "single":
        return "Stash this tab";
      case "none":
        return "Show stashed tabs";
      default:
        return "Set up Tab Stash";
    }
  }

  await browser.action.setTitle({
    title: get_title(model.options.sync.state.browser_action_stash),
  });
}

async function configure_side_panel() {
  const side_panel = chrome_side_panel();
  if (!side_panel?.setPanelBehavior) return;

  await side_panel.setPanelBehavior({openPanelOnActionClick: false});
}

async function ensure_alarms() {
  await browser.alarms.create(GC_ALARM, {
    periodInMinutes: DAY_IN_MINUTES,
  });
}

function needs_setup(model: M.Model): boolean {
  const opts = model.options.sync.state;
  return (
    !opts.browser_action_show ||
    !opts.browser_action_stash ||
    !opts.open_stash_in
  );
}

function needs_toolbar_setup(model: M.Model): boolean {
  const opts = model.options.sync.state;
  return !opts.browser_action_show || !opts.browser_action_stash;
}

function create_context_menus() {
  browser.contextMenus.removeAll().then(() => {
    menu(
      "main:",
      ["page", "frame", "selection", "link", "editable", "image", "video"],
      [
        ["show_popup", "Open Popup"],
        ["show_tab", "Show Stashed Tabs in a Tab"],
        ["show_side_panel", "Toggle Tab Stash in Side Panel"],
        ["", ""],
        ["stash_all", "Stash Tabs"],
        ["stash_one", "Stash This Tab"],
        ["stash_one_newgroup", "Stash This Tab to a New Group"],
        ["", ""],
        ["copy_all", "Copy Tabs to Stash"],
        ["copy_one", "Copy This Tab to Stash"],
        ["", ""],
        ["setup", "Set Up Tab Stash..."],
        ["options", "Options..."],
      ],
    );

    menu(
      "action:",
      ["action"],
      [
        ["show_popup", "Open Popup"],
        ["show_tab", "Show Stashed Tabs in a Tab"],
        ["show_side_panel", "Toggle Tab Stash in Side Panel"],
        ["", ""],
        ["stash_all", "Stash Tabs"],
        ["copy_all", "Copy Tabs to Stash"],
        ["", ""],
        ["setup", "Set Up Tab Stash..."],
        ["options", "Options..."],
      ],
    );
  });
}

function menu(
  idprefix: string,
  contexts: Menus.ContextType[],
  def: string[][],
) {
  const allowed_ctxs = Object.values(
    (<any>browser.contextMenus).ContextType || [
      "action",
      "page",
      "frame",
      "selection",
      "link",
      "editable",
      "image",
      "video",
    ],
  );
  contexts = contexts.filter(x => allowed_ctxs.includes(x));

  for (let i = 0; i < def.length; i++) {
    const [id, title] = def[i];
    if (id) {
      browser.contextMenus.create({contexts, title, id: idprefix + id});
    } else {
      browser.contextMenus.create({
        contexts,
        type: "separator",
        id: idprefix + "separator_" + i,
        enabled: false,
      });
    }
  }
}

function commands(model: M.Model): {
  [key: string]: (t?: Tab, bt?: BrowserTabs.Tab) => Promise<void>;
} {
  return {
    show_side_panel: async (_t?: Tab, bt?: BrowserTabs.Tab) => {
      await toggle_side_panel(bt);
    },

    async show_popup() {
      await browser.action.setPopup({popup: "stash-list.html?view=popup"});
      const open_popup = (<any>browser.action).openPopup;
      if (typeof open_popup === "function") {
        await open_popup.call(browser.action);
      } else {
        await commands(model).show_tab();
      }
    },

    async show_tab() {
      await model.restoreTabs(
        [
          {
            title: "Tab Stash",
            url: browser.runtime.getURL("stash-list.html"),
          },
        ],
        {},
      );
    },

    async stash_all(tab?: Tab) {
      show_something(model, model.options.sync.state.open_stash_in, tab);
      await stash_something(model, {what: "all", copy: false, tab});
    },

    async stash_one(tab?: Tab) {
      show_something(model, model.options.sync.state.open_stash_in, tab);
      await stash_something(model, {what: "single", copy: false, tab});
    },

    async stash_one_newgroup(tab?: Tab) {
      show_something(model, model.options.sync.state.open_stash_in, tab);
      if (!tab) return;
      await model.putItemsInFolder({
        items: [tab],
        toFolder: await model.createStashFolder(),
      });
    },

    async copy_all(tab?: Tab) {
      show_something(model, model.options.sync.state.open_stash_in, tab);
      await stash_something(model, {what: "all", copy: true, tab});
    },

    async copy_one(tab?: Tab) {
      show_something(model, model.options.sync.state.open_stash_in, tab);
      await stash_something(model, {what: "single", copy: true, tab});
    },

    async options() {
      show_options_page(model);
    },

    async setup() {
      show_setup_page(model);
    },
  };
}

function show_something(
  model: M.Model,
  show_what?: ShowWhatOpt,
  tab?: Tab,
  browser_tab?: BrowserTabs.Tab,
) {
  switch (show_what) {
    case "none":
      break;

    case "tab":
      model.attempt(commands(model).show_tab);
      break;

    case "popup":
      model.attempt(commands(model).show_popup);
      break;

    case "side_panel":
      // Handled synchronously by event listeners to preserve user gesture
      break;

    default:
      show_setup_page(model);
      break;
  }
}

async function stash_something(
  model: M.Model,
  options: {
    what?: StashWhatOpt;
    copy?: boolean;
    tab?: Tab;
  },
) {
  if (!options.tab || options.tab.position === undefined) return;

  switch (options.what) {
    case "all":
      await model.stashAllTabsInWindow(options.tab.position.parent, {
        copy: !!options.copy,
      });
      break;

    case "single":
      await model.putItemsInFolder({
        items: copyIf(!!options.copy, [options.tab]),
        toFolder: await model.ensureDefaultStashDestFolder(),
      });
      break;

    case "none":
    default:
      break;
  }
}

function show_setup_page(model: M.Model) {
  model.attempt(() =>
    model.restoreTabs(
      [
        {
          title: "Tab Stash - Setup",
          url: browser.runtime.getURL("setup.html"),
        },
      ],
      {},
    ),
  );
}

function show_options_page(model: M.Model) {
  model.attempt(() =>
    model.restoreTabs(
      [
        {
          title: "Tab Stash - Options",
          url: browser.runtime.getURL("options.html"),
        },
      ],
      {},
    ),
  );
}

async function gc(model: M.Model) {
  await model.attempt(async () => {
    await model.gc();
  });
}

function open_side_panel(tab?: BrowserTabs.Tab): Promise<void> {
  const side_panel = chrome_side_panel();
  if (!side_panel?.open) {
    return Promise.reject(new Error("Chrome side panel API is not available"));
  }

  const context = side_panel_context(tab);
  if (!context) {
    return Promise.reject(new Error("Cannot determine side panel context"));
  }

  const opened = side_panel.open(context);
  if (context.windowId !== undefined) {
    set_side_panel_open(context.windowId, true);
  }
  return opened;
}

function toggle_side_panel(tab?: BrowserTabs.Tab): Promise<void> {
  const side_panel = chrome_side_panel();
  if (!side_panel?.open) {
    return Promise.reject(new Error("Chrome side panel API is not available"));
  }

  const context = side_panel_context(tab);
  if (!context) {
    return Promise.reject(new Error("Cannot determine side panel context"));
  }

  const windowId = context.windowId;
  if (
    windowId !== undefined &&
    side_panel_open_windows.has(windowId) &&
    side_panel.close
  ) {
    const closed = side_panel.close(context);
    set_side_panel_open(windowId, false);
    return closed;
  }

  const opened = side_panel.open(context);
  if (windowId !== undefined) set_side_panel_open(windowId, true);
  return opened;
}

function track_side_panel_state() {
  const side_panel = chrome_side_panel();
  side_panel?.onOpened?.addListener(info => {
    set_side_panel_open(info.windowId, true);
  });
  side_panel?.onClosed?.addListener(info => {
    set_side_panel_open(info.windowId, false);
  });
}

function side_panel_context(
  tab?: BrowserTabs.Tab,
): SidePanelContext | undefined {
  if (tab?.windowId !== undefined) return {windowId: tab.windowId};
  if (tab?.id !== undefined) return {tabId: tab.id};

  const windowId = chrome_current_window_id();
  return windowId === undefined ? undefined : {windowId};
}

function set_side_panel_open(windowId: number, open: boolean) {
  if (open) side_panel_open_windows.add(windowId);
  else side_panel_open_windows.delete(windowId);
}

function chrome_side_panel(): SidePanelAPI | undefined {
  return (<any>globalThis).chrome?.sidePanel;
}

function chrome_current_window_id(): number | undefined {
  const windowId = (<any>globalThis).chrome?.windows?.WINDOW_ID_CURRENT;
  return typeof windowId === "number" ? windowId : undefined;
}

type SidePanelAPI = {
  open(options: SidePanelContext): Promise<void>;
  close?(options: SidePanelContext): Promise<void>;
  setPanelBehavior?(options: {openPanelOnActionClick: boolean}): Promise<void>;
  onOpened?: SidePanelEvent;
  onClosed?: SidePanelEvent;
};

type SidePanelContext = {windowId?: number; tabId?: number};
type SidePanelEvent = {
  addListener(
    callback: (info: {windowId: number; tabId?: number}) => void,
  ): void;
};

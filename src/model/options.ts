// The default tab stash options.  Sync defaults are stored in
// browser.storage.sync, and local defaults are stored in browser.storage.local.
//
// For a variety of reasons, names should be unique across both sync and local
// storage.  (For one thing, this makes migration easier later on if we decide
// to change where an option is stored.  For another, options.vue expects this
// and will break if it's not true.)

import {computed, ref} from "vue";
import stored_object, {
  aBoolean,
  anEnum,
  aNumber,
  maybeUndef,
  type StoredObject,
  type StorableType,
} from "../datastore/stored-object.js";
import {resolveNamed} from "../util/index.js";
import {errorLog, UserError} from "../util/oops.js";

export const SHOW_WHAT_OPT: StorableType<
  "side_panel" | "tab" | "popup" | "none"
> = (value, fallback) => {
  if (value === "sidebar") return "side_panel";
  return anEnum("side_panel", "tab", "popup", "none")(value, fallback);
};
export const STASH_WHAT_OPT = anEnum("all", "single", "none");
export const AFTER_STASHING_TAB_OPT: StorableType<"close"> = (
  value,
  fallback,
) => {
  if (value === "hide" || value === "hide_discard") return "close";
  return anEnum("close")(value, fallback);
};
export type ShowWhatOpt = ReturnType<typeof SHOW_WHAT_OPT>;
export type StashWhatOpt = ReturnType<typeof STASH_WHAT_OPT>;
export type Capability = "available" | "disabled" | "not-supported";

export type SyncModel = StoredObject<typeof SYNC_DEF>;
export type SyncState = SyncModel["state"];
export const SYNC_DEF = {
  // Should we show advanced settings to the user?
  meta_show_advanced: {default: false, is: aBoolean},

  // When the user stashes from the context menu, do we show the "side_panel",
  // "tab", or "none"?
  open_stash_in: {
    default: undefined,
    is: maybeUndef(SHOW_WHAT_OPT),
  },

  // When the user clicks the browser toolbar button, what tabs do we stash?
  browser_action_stash: {
    default: undefined,
    is: maybeUndef(STASH_WHAT_OPT),
  },

  // When the user clicks the browser toolbar button, what UI do we show?
  browser_action_show: {
    default: undefined,
    is: maybeUndef(SHOW_WHAT_OPT),
  },

  // In the stash list, show all open tabs at the top instead of just the
  // unstashed tabs.
  show_open_tabs: {
    default: "unstashed",
    is: anEnum("unstashed", "all"),
  },

  // How are new folders of tabs shown, expanded or collapsed?
  show_new_folders: {
    default: "expanded",
    is: anEnum("expanded", "collapsed"),
  },

  // How big should the spacing/fonts be?
  ui_metrics: {
    default: "normal",
    is: anEnum("normal", "compact"),
  },

  // What color scheme should the UI use?
  ui_theme: {
    default: "system",
    is: anEnum("system", "light", "dark"),
  },

  // If we're stashing to a "recent" unnamed folder, how recent is "recent"?
  // If the most recent unnamed folder is older than <X> minutes ago, we will
  // create a new folder instead of appending to the existing one.
  new_folder_timeout_min: {default: 5, is: aNumber},

  // How long should we keep deleted items for?
  deleted_items_expiration_days: {default: 180, is: aNumber},
} as const;

export type LocalModel = StoredObject<typeof LOCAL_DEF>;
export type LocalState = LocalModel["state"];
export const LOCAL_DEF = {
  // What should we do with a tab once it's been stashed?
  after_stashing_tab: {
    default: "close",
    is: AFTER_STASHING_TAB_OPT,
  },

  /** Whether or not to load restored tabs immediately or wait for the user to
   * click on them.  (That is, should newly-opened tabs be discarded or not?) */
  load_tabs_on_restore: {
    default: "immediately",
    is: anEnum("immediately", "lazily"),
  },

  /** Confirm whether to close lots of open tabs or not. */
  confirm_close_open_tabs: {default: true, is: aBoolean},

  /** Disable crash reports for a certain amount of time. */
  hide_crash_reports_until: {default: undefined, is: maybeUndef(aNumber)},

  /** The last export format chosen by the user.  There's no options UI for this,
   * because it's selected only from the export dialog itself. */
  last_export_format: {
    default: "html-links",
    is: anEnum("html-links", "url-list", "markdown", "one-tab"),
  },

  // Migration flags are intentionally left here so stale local options can be
  // dropped by the StoredObject schema as Chromium-only defaults evolve.
} as const;

/** The name of a supported export format. */
export type ExportFormat = LocalState["last_export_format"];

export type Source = {
  readonly sync: StoredObject<typeof SYNC_DEF>;
  readonly local: StoredObject<typeof LOCAL_DEF>;
};

export class Model {
  readonly sync: StoredObject<typeof SYNC_DEF>;
  readonly local: StoredObject<typeof LOCAL_DEF>;

  static async live(): Promise<Model> {
    return new Model(
      await resolveNamed({
        sync: stored_object("sync", "options", SYNC_DEF),
        local: stored_object("local", "options", LOCAL_DEF),
      }),
    );
  }

  constructor(src: Source) {
    this.sync = src.sync;
    this.local = src.local;
  }

  /** Do we need to show a crash-report notification to the user? */
  readonly showCrashReport = computed(() => {
    const until = this.local.state.hide_crash_reports_until || 0;
    if (this._now.value < until) {
      setTimeout(
        () => {
          this._now.value = Date.now();
        },
        until - this._now.value + 1,
      );
      return false;
    }
    return (
      errorLog.length > 0 &&
      !!errorLog.find(e => !(e.error instanceof UserError))
    );
  });

  /** Is the Chrome side panel supported? */
  hasSidePanel(): boolean {
    return true;
  }

  /** Based on the current settings, what can the toolbar stash? */
  canBrowserActionStash(what: StashWhatOpt): boolean {
    const browserActionShow = this.sync.state.browser_action_show;

    switch (what) {
      case "none":
        return browserActionShow !== "none";
      default:
        return browserActionShow !== "popup";
    }
  }

  /** Based on the current settings, what UIs can the browser show? */
  canBrowserActionShow(what: ShowWhatOpt): boolean {
    const browserActionStash = this.sync.state.browser_action_stash;

    switch (what) {
      case "none":
        return browserActionStash !== "none";
      case "popup":
        return browserActionStash === "none";
      default:
        return true;
    }
  }

  private _now = ref(Date.now());
}

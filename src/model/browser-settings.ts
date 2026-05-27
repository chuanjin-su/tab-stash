/** Browser settings relevant to Tab Stash.
 *
 * Chromium does not expose home/new-tab URLs through WebExtensions, so the
 * model uses a fixed list of known blank/start pages.
 */
export class Model {
  static async live(): Promise<Model> {
    return new Model();
  }

  async reload(): Promise<void> {}

  /** Determine if the URL provided is a new-tab URL or homepage URL (i.e.
   * something the user would consider as "empty"). */
  isNewTabURL(url: string): boolean {
    switch (url) {
      case "about:blank":
      case "about:newtab":
      case "chrome://newtab/":
      case "edge://newtab/":
        return true;
      default:
        // Vivaldi is especially difficult...
        if (url.startsWith("chrome://vivaldi-webui/startpage")) return true;
        return false;
    }
  }
}

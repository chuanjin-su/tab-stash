export type Container = {
  name: string;
  icon?: string;
  iconUrl?: string;
  color?: string;
  colorCode?: string;
  cookieStoreId: string;
};

export class Model {
  readonly enabled = false;

  static async from_browser(): Promise<Model> {
    return new Model();
  }

  async reload(): Promise<void> {}

  container(_key: string): Container | undefined {
    return undefined;
  }
}

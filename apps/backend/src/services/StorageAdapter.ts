export class StorageAdapter {
  static getSupportedVolumes(appType: string, strategy: string): string[] {
    switch (appType) {
      case 'odoo':
        return strategy === 'helm' ? ['db', 'web'] : ['db'];
      case 'wordpress':
        return strategy === 'helm' ? ['db', 'web'] : ['db'];
      case 'nextcloud':
        return strategy === 'helm' ? ['db', 'web'] : ['db'];
      case 'audiobookshelf':
        return ['library', 'metadata', 'config'];
      case 'prometheus':
        return strategy === 'helm' ? ['server'] : [];
      case 'palworld':
        return ['data'];
      case 'jellyfin':
        return ['config', 'cache', 'media'];
      case 'plex':
        return ['config', 'media'];
      case 'navidrome':
        return ['data', 'music'];
      case 'kavita':
        return ['config', 'manga'];
      case 'immich':
        return ['library'];
      case 'papra':
        return ['data', 'media'];
      case 'homeassistant':
        return ['config'];
      default:
        return [];
    }
  }

  static getStorageEnv(appType: string, strategy: string, storage: any = {}): Record<string, string> {
    const env: Record<string, string> = {};
    const supported = this.getSupportedVolumes(appType, strategy);
    
    for (const key of supported) {
      const val = storage[key];
      if (val) {
        env[`STORAGE_${key.toUpperCase()}`] = val;
      }
    }
    return env;
  }
}

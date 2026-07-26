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
        // Single volume holding the whole /palworld tree — world saves, config and the SteamCMD
        // game install all live there.
        return ['data'];
      default:
        // NOTE: openwebui and gitapp fall through here while main.ts reads STORAGE_DB /
        // STORAGE_WEB for them — so their PVC sizes are silently unconfigurable. Pre-existing;
        // fixing it means adding their cases here.
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

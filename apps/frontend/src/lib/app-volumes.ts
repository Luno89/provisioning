export function getSupportedVolumes(appType: string, strategy: string): string[] {
  switch (appType) {
    case 'odoo':
    case 'wordpress':
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

export function getFallbackSize(volume: string): string {
  switch (volume) {
    case 'library':
      return '5Gi';
    case 'metadata':
      return '2Gi';
    case 'config':
      return '1Gi';
    case 'db':
      return '2Gi';
    case 'web':
      return '5Gi';
    case 'server':
      return '10Gi';
    default:
      return '2Gi';
  }
}

export function getVolumeDescription(volume: string): string {
  switch (volume) {
    case 'db':
      return 'Persistent storage for database engines (PostgreSQL, MariaDB, MySQL).';
    case 'web':
      return 'Persistent storage for web assets and public uploads.';
    case 'library':
      return 'Primary media and audiobook library storage, mounted at /audiobooks.';
    case 'metadata':
      return 'Application metadata and cache database storage, mounted at /metadata.';
    case 'config':
      return 'Configuration files and server settings, mounted at /config.';
    case 'server':
      return 'Prometheus metric storage and TSDB records.';
    default:
      return 'Persistent storage volume.';
  }
}

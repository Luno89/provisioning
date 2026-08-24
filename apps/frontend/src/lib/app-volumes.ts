/**
 * Which persistent volumes an app type has, how big they are by default, and what each is for.
 *
 * ── WHY THESE ARE HERE ──
 * Three `switch` statements over app types, living inside `App.tsx`'s component as closures — so
 * the storage tab's whole behaviour, including which volumes a Helm deployment has that a native
 * one does not, could only be exercised by rendering a 2,858-line component and clicking to a tab.
 *
 * ── DUPLICATED, KNOWINGLY ──
 * The volume names mirror what the CDKTF constructs actually create in
 * `packages/cdktf-infra/constructs/`. If they disagree the construct wins — it is what runs — and
 * the storage tab will be offering to resize a PVC that does not exist.
 */
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
      // Must match StorageAdapter.getSupportedVolumes on the backend — that's what actually
      // emits STORAGE_DATA for the construct.
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

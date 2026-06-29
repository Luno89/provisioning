"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.StorageAdapter = void 0;
class StorageAdapter {
    static getSupportedVolumes(appType, strategy) {
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
            default:
                return [];
        }
    }
    static getStorageEnv(appType, strategy, storage = {}) {
        const env = {};
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
exports.StorageAdapter = StorageAdapter;
//# sourceMappingURL=StorageAdapter.js.map
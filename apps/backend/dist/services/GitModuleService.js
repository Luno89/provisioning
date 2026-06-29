"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.GitModuleService = void 0;
const BaseService_js_1 = require("./BaseService.js");
const promises_1 = __importDefault(require("fs/promises"));
const path_1 = __importDefault(require("path"));
const url_1 = require("url");
const __filename = (0, url_1.fileURLToPath)(import.meta.url);
const __dirname = path_1.default.dirname(__filename);
const PROJECT_ROOT = path_1.default.resolve(__dirname, '../../../../');
const MOCK_MODULES = {
    odoo: [
        { id: 'sale_delivery_split_date', name: 'Sales Order Delivery Split Date', summary: 'Allows splitting delivery dates on sales order lines.', author: 'Odoo Professional Services', version: '18.0.1.0.0', depends: ['sale'] },
        { id: 'partner_credit_limit', name: 'Partner Credit Limit Enforcer', summary: 'Restricts sales orders if partner exceeds credit limit.', author: 'Odoo Finance Core', version: '18.0.2.1.0', depends: ['account'] }
    ],
    wordpress: [
        { id: 'wp_super_cache', name: 'WP Super Cache Optimizer', summary: 'High-performance static caching plugin for WordPress.', author: 'WordPress Performance Team', version: '6.7.1' },
        { id: 'seo_optimizer', name: 'Rank SEO Optimizer', summary: 'Search Engine Optimization and XML Sitemap Generator.', author: 'SEO Plugins Inc', version: '2.4.5' }
    ],
    nextcloud: [
        { id: 'calendar', name: 'Nextcloud Calendar', summary: 'Personal and shared calendars for Nextcloud.', author: 'Nextcloud Community', version: '30.0.1' },
        { id: 'deck', name: 'Nextcloud Deck', summary: 'Kanban-style project organization tool.', author: 'Nextcloud Team', version: '1.12.0' }
    ],
    audiobookshelf: [
        { id: 'audible_scraper', name: 'Audible Metadata Scraper', summary: 'Scrapes metadata and chapters directly from Audible.', author: 'Audiobookshelf Plugins', version: '1.2.0' },
        { id: 'librivox_scraper', name: 'LibriVox Scraper', summary: 'Fetches metadata and audiobooks from LibriVox.', author: 'Free Audio Project', version: '1.0.1' }
    ],
    prometheus: [
        { id: 'node_exporter', name: 'Node Exporter Plugin', summary: 'Host level metrics exporter for Linux systems.', author: 'Prometheus Community', version: '1.8.1' },
        { id: 'alertmanager_discord', name: 'Discord Alerts Dispatcher', summary: 'Forwards Prometheus alerts to Discord webhooks.', author: 'CloudOps Tools', version: '1.3.0' }
    ],
    traefik: [
        { id: 'oauth2_forwarder', name: 'OAuth2 Forward Auth', summary: 'Secures routes behind Google or GitHub OAuth.', author: 'Traefik Middleware', version: '2.1.0' },
        { id: 'compression_gzip', name: 'Gzip Compression', summary: 'Enables gzip content encoding dynamically.', author: 'Core Traefik Team', version: '1.0.0' }
    ]
};
class GitModuleService extends BaseService_js_1.BaseService {
    getRepoPath(appType) {
        const folderName = appType === 'odoo' ? 'odoo-custom-modules' : `${appType}-custom-plugins`;
        return path_1.default.join(PROJECT_ROOT, '..', folderName);
    }
    async listAvailableModules(appType = 'odoo') {
        const sanitizedAppType = appType ? appType.toLowerCase() : 'odoo';
        const repoPath = this.getRepoPath(sanitizedAppType);
        try {
            // 1. Try reading the actual directory if it exists
            await promises_1.default.access(repoPath);
            const items = await promises_1.default.readdir(repoPath, { withFileTypes: true });
            const modules = [];
            for (const item of items) {
                if (item.isDirectory() && !item.name.startsWith('.')) {
                    // If Odoo, parse standard manifest
                    if (sanitizedAppType === 'odoo') {
                        const manifestPath = path_1.default.join(repoPath, item.name, '__manifest__.py');
                        try {
                            const content = await promises_1.default.readFile(manifestPath, 'utf-8');
                            modules.push({
                                id: item.name,
                                name: this.extractManifestValue(content, 'name') || item.name,
                                summary: this.extractManifestValue(content, 'summary') || '',
                                description: this.extractManifestValue(content, 'description') || '',
                                author: this.extractManifestValue(content, 'author') || 'Unknown',
                                version: this.extractManifestValue(content, 'version') || '1.0',
                                depends: this.extractManifestList(content, 'depends') || []
                            });
                        }
                        catch {
                            // Ignore invalid module folders
                        }
                    }
                    else {
                        // For other apps, check for a simple manifest or metadata file, or default metadata
                        const metaPath = path_1.default.join(repoPath, item.name, 'manifest.json');
                        try {
                            const content = await promises_1.default.readFile(metaPath, 'utf-8');
                            const data = JSON.parse(content);
                            modules.push({
                                id: item.name,
                                name: data.name || item.name,
                                summary: data.summary || '',
                                description: data.description || '',
                                author: data.author || 'Unknown',
                                version: data.version || '1.0'
                            });
                        }
                        catch {
                            // Fallback: use directory name and look up mock defaults
                            const matchedMock = MOCK_MODULES[sanitizedAppType]?.find(m => m.id === item.name);
                            modules.push(matchedMock || {
                                id: item.name,
                                name: item.name,
                                summary: 'Custom Extension',
                                description: 'Custom Extension plugin found in local repository.',
                                author: 'Developer',
                                version: '1.0'
                            });
                        }
                    }
                }
            }
            if (modules.length > 0)
                return modules;
            return MOCK_MODULES[sanitizedAppType] || [];
        }
        catch (err) {
            // 2. Directory missing or unreadable - fall back to mock data
            return MOCK_MODULES[sanitizedAppType] || [];
        }
    }
    extractManifestValue(content, key) {
        const regex = new RegExp(`['"]${key}['"]\\s*:\\s*['"]([^'"]+)['"]`, 'i');
        const match = content.match(regex);
        return match ? match[1] : null;
    }
    extractManifestList(content, key) {
        const regex = new RegExp(`['"]${key}['"]\\s*:\\s*\\[([^\\]]+)\\]`, 'i');
        const match = content.match(regex);
        if (!match)
            return null;
        return match[1].split(',').map(s => s.trim().replace(/['"]/g, '')).filter(s => s);
    }
}
exports.GitModuleService = GitModuleService;
//# sourceMappingURL=GitModuleService.js.map
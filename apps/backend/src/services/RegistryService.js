"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.RegistryService = void 0;
const BaseService_js_1 = require("./BaseService.js");
const axios_1 = __importDefault(require("axios"));
class RegistryService extends BaseService_js_1.BaseService {
    constructor(db) {
        super(db);
    }
    FALLBACK_TAGS = {
        'bitnami/odoo': ['18.0.20250805-debian-12-r8', '17.0.20240805-debian-12-r0', '16.0.20240805-debian-12-r0'],
        'bitnamilegacy/odoo': ['18.0.20250805-debian-12-r8', '17.0.20240805-debian-12-r0', '16.0.20240805-debian-12-r0'],
        'bitnami/postgresql': ['17.5.0-debian-12-r20', '16.4.0-debian-12-r0', '15.8.0-debian-12-r0'],
        'bitnamilegacy/postgresql': ['17.5.0-debian-12-r20', '16.4.0-debian-12-r0', '15.8.0-debian-12-r0'],
        'bitnami/nginx': ['1.27.1-debian-12-r2', '1.26.2-debian-12-r0']
    };
    async search(query) {
        const response = await axios_1.default.get(`https://hub.docker.com/v2/search/repositories/?query=${query}&page_size=10`);
        return response.data.results;
    }
    async getTags(repo) {
        try {
            if (repo.startsWith('bitnami/')) {
                const repoName = repo.split('/')[1];
                const response = await axios_1.default.get(`https://api.gallery.ecr.aws/v1/repository/public/tags?repositoryName=${repoName}&registryAlias=bitnami`);
                const tags = response.data.tags
                    .map((t) => t.tagName)
                    .filter((tag) => !tag.includes('sha256') && !tag.includes('latest'));
                if (tags.length > 0)
                    return tags.slice(0, 30);
            }
            const response = await axios_1.default.get(`https://hub.docker.com/v2/repositories/${repo}/tags?page_size=100`);
            const tags = response.data.results
                .map((t) => t.name)
                .filter((tag) => !tag.includes('sha256') && !tag.includes('metadata') && !tag.includes('sig') && tag !== 'latest');
            return tags.length > 0 ? tags : (this.FALLBACK_TAGS[repo] || []);
        }
        catch (err) {
            this.logger.warn(`Failed to fetch tags for ${repo}: ${err.message}`);
            return this.FALLBACK_TAGS[repo] || [];
        }
    }
}
exports.RegistryService = RegistryService;
//# sourceMappingURL=RegistryService.js.map
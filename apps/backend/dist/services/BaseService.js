"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.BaseService = void 0;
const pino_1 = __importDefault(require("pino"));
const pino_pretty_1 = __importDefault(require("pino-pretty"));
class BaseService {
    logger = (0, pino_1.default)((0, pino_pretty_1.default)());
    db;
    constructor(db) {
        this.db = db;
    }
}
exports.BaseService = BaseService;
//# sourceMappingURL=BaseService.js.map
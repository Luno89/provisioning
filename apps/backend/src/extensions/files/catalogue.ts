import type { ToolDefinition } from '@koala/agent-engine';

export const LIST_FILES = 'list_files';
export const READ_STORED_FILE = 'read_stored_file';
export const STORE_FILE = 'store_file';
export const REMOVE_STORED_FILE = 'remove_stored_file';

const PROJECT = { type: 'string', description: 'The project, by name or id. Leave it out to use the project this run or chat is for; with no project at all it is the person\'s own files.' };

export const FILES_TOOLS: ToolDefinition[] = [
  {
    name: LIST_FILES,
    summary: 'List the files a project keeps on the person\'s MinIO, outside its repository: documents, images, spreadsheets, uploads',
    guidance: 'Use this when the person mentions a file they uploaded or attached, or a document that is not code. A project\'s files are separate from its repository: code is in the repository, everything else is here. List a folder to see what is in it; stories keep theirs under stories/<story id>/, chats under attachments/.',
    binding: 'platform',
    effect: 'read',
    idempotent: true,
    openWorld: false,
    returns: 'each file and folder in the folder, with its size and when it changed, folders first',
    failures: [
      { when: 'the project has no file server yet', says: 'so, and that one is set in the project\'s Settings' },
      { when: 'no project of the person has that name or id', says: 'the projects they have' },
    ],
    parameters: { type: 'object', properties: { project: PROJECT, folder: { type: 'string', description: 'The folder to list, from the top of the project\'s files. Leave it out for the top.' } } },
  },
  {
    name: READ_STORED_FILE,
    summary: 'Read a file from a project\'s file server: its text, or for an image, a PDF or another binary file, what it is and its size',
    guidance: 'Use this to read a document the person uploaded. Text files (and Markdown, CSV, JSON, YAML, XML, HTML) come back whole up to 100,000 characters. A binary file is described, not read.',
    binding: 'platform',
    effect: 'read',
    idempotent: true,
    openWorld: false,
    returns: 'the file\'s text, or what kind of file it is and how big',
    failures: [{ when: 'there is no such file', says: 'so; list_files shows what is there' }],
    parameters: { type: 'object', properties: { project: PROJECT, path: { type: 'string', description: 'The file\'s path in the project\'s files, as list_files gives it.' } }, required: ['path'] },
  },
  {
    name: STORE_FILE,
    summary: 'Write a text file to a project\'s file server, replacing one at the same path',
    guidance: 'Use this for documents that are not code: notes, reports, exports, data the person asked for. Code goes in the repository, never here.',
    binding: 'platform',
    effect: 'write',
    destructive: true,
    idempotent: true,
    openWorld: false,
    returns: 'where it was stored',
    failures: [{ when: 'the project has no file server yet', says: 'so, and that one is set in the project\'s Settings' }],
    parameters: { type: 'object', properties: { project: PROJECT, path: { type: 'string', description: 'Where to store it in the project\'s files.' }, content: { type: 'string', description: 'The text to store.' } }, required: ['path', 'content'] },
  },
  {
    name: REMOVE_STORED_FILE,
    summary: 'Remove a file, or a folder and everything in it, from a project\'s file server',
    guidance: 'Only when the person asks for it to go. It cannot be undone.',
    binding: 'platform',
    effect: 'write',
    destructive: true,
    idempotent: true,
    openWorld: false,
    returns: 'what was removed',
    failures: [{ when: 'the project has no file server yet', says: 'so' }],
    parameters: { type: 'object', properties: { project: PROJECT, path: { type: 'string', description: 'The file or folder to remove.' } }, required: ['path'] },
  },
];

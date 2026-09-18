import type { ToolDefinition } from '@koala/agent-engine';

const NO_MACHINE = { when: 'the persona has no machine', says: 'this agent has no machine, so it cannot do that' };

export const WORKSPACE_TOOLS: ToolDefinition[] = [
  {
    name: 'run_command',
    summary: 'Run a shell command in the workspace and get back stdout, stderr and whether it succeeded',
    guidance: 'Use this for anything the workspace can do that no other tool covers — installing, '
      + 'building, running a test suite, inspecting git. It is the general case, so prefer a tool '
      + 'that names what you want when one exists. A non-zero exit is reported as a failure with '
      + 'the output, not as an error to retry blindly.',
    binding: 'environment',
    effect: 'write',
    status: 'draft',
    requires: { terminal: true },
    returns: 'stdout and stderr together, or "exited <code>" when the command printed nothing. The '
      + 'call is marked failed when the exit code is not zero.',
    failures: [
      NO_MACHINE,
      { when: 'the command argument is missing', says: 'this call needs a "command"' },
      { when: 'the command exits non-zero', says: 'the output, with the call marked failed' },
    ],
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The shell command to run' },
        cwd: { type: 'string', description: 'Directory to run it in, defaulting to the workspace root' },
      },
      required: ['command'],
    },
  },
  {
    name: 'read_file',
    summary: 'Read a file from the workspace',
    guidance: 'Use this to see what a file currently contains before changing it, or to check what '
      + 'something produced. Reading a directory is list_dir, not this.',
    binding: 'environment',
    effect: 'read',
    status: 'draft',
    requires: { filesystem: true },
    returns: 'The contents of the file as text.',
    failures: [
      NO_MACHINE,
      { when: 'the path argument is missing', says: 'this call needs a "path"' },
      { when: 'no file is at that path', says: 'what the workspace said, rather than an empty result' },
    ],
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file, relative to the workspace root' },
      },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    summary: 'Write a file in the workspace, creating parent directories',
    guidance: 'Use this to create or replace a file whole. It overwrites rather than appending, so '
      + 'read first when you mean to change part of something.',
    binding: 'environment',
    effect: 'write',
    status: 'draft',
    requires: { filesystem: true },
    returns: 'Confirmation of how many bytes went to which path.',
    failures: [
      NO_MACHINE,
      { when: 'the path argument is missing', says: 'this call needs a "path"' },
      { when: 'content is left out', says: 'nothing — it writes an empty file' },
    ],
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to write, relative to the workspace root' },
        content: { type: 'string', description: 'The full contents to write' },
      },
      required: ['path'],
    },
  },
  {
    name: 'list_dir',
    summary: 'List a directory in the workspace',
    guidance: 'Use this to find out what is there before guessing at a path. Defaults to the '
      + 'workspace root when given nothing.',
    binding: 'environment',
    effect: 'read',
    status: 'draft',
    requires: { filesystem: true },
    returns: 'One entry per line, each marked d for a directory or - for a file.',
    failures: [
      NO_MACHINE,
      { when: 'no directory is at that path', says: 'what the workspace said' },
    ],
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory to list, defaulting to the workspace root' },
      },
    },
  },
  {
    name: 'delete_file',
    summary: 'Delete a path in the workspace',
    guidance: 'Use this only for something you created that should not be there. Deleting is not '
      + 'how you change a file — write_file replaces one.',
    binding: 'environment',
    effect: 'write',
    status: 'draft',
    requires: { filesystem: true },
    returns: 'Confirmation naming what was deleted.',
    failures: [
      NO_MACHINE,
      { when: 'the path argument is missing', says: 'this call needs a "path"' },
      { when: 'nothing is at that path', says: 'what the workspace said' },
    ],
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to delete, relative to the workspace root' },
      },
      required: ['path'],
    },
  },
  {
    name: 'search_web',
    summary: 'Search the live web and get back ranked results with snippets',
    guidance: 'Use this to find pages worth reading, then fetch_web_page to read one. Results are '
      + 'not reproducible — the same query can come back differently later — so quote what you '
      + 'used rather than relying on a result still being there.',
    binding: 'network',
    effect: 'read',
    status: 'draft',
    replaces: ['web_search'],
    returns: 'Numbered results, each with a title, a URL and a snippet.',
    failures: [
      { when: 'the query argument is missing', says: 'this call needs a "query"' },
      { when: 'nothing matches', says: 'nothing came back for "<query>"' },
      { when: 'no search backend answers', says: 'that search is unavailable and rephrasing will not help' },
    ],
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to search for' },
      },
      required: ['query'],
    },
  },
  {
    name: 'fetch_web_page',
    summary: 'Fetch a URL and get its readable text, without the markup',
    guidance: 'Use this to read a page you already have a URL for. To find one first, search_web. '
      + 'It reads the page as it is now, so quote what you relied on.',
    binding: 'network',
    effect: 'read',
    status: 'draft',
    returns: 'The page as clean text, with navigation and markup stripped.',
    failures: [
      { when: 'the url argument is missing', says: 'this call needs a "url"' },
      { when: 'the page cannot be fetched', says: 'what the fetch said, rather than an empty page' },
    ],
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The full URL to fetch' },
      },
      required: ['url'],
    },
  },
];

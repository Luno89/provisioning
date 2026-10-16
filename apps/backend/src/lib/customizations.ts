export interface ExportFile {
  path: string;
  content: string;
}

export interface ExportResult {
  module: string;
  files: ExportFile[];
  refused: { key: string; why: string }[];
}

export const ADOPT_FILE = 'adopt.json';

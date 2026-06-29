export interface Runtime {
  exec(command: string): Promise<string>;
}

export interface StreamResult {
  ready: boolean;
  stdout: string;
  stderr: string;
}

import { closeSync, openSync, readSync, watch } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';

export function showGrowing(file: string, show: (text: string) => void): { stop: () => void } {
  const fd = openSync(file, 'r');
  const chunk = Buffer.alloc(64 * 1024);
  const text = new StringDecoder('utf8');
  let stopped = false;
  const showNew = () => {
    if (stopped) return;
    for (let read = readSync(fd, chunk); read > 0; read = readSync(fd, chunk)) show(text.write(chunk.subarray(0, read)));
  };
  const watcher = watch(file, showNew);
  showNew();
  return {
    stop: () => {
      showNew();
      stopped = true;
      watcher.close();
      closeSync(fd);
    },
  };
}

import { Panel } from './Panel';

export function Board() {
  return <Panel onDone={(name) => name.toUpperCase()} />;
}

import { Commits } from './Commits';

function Leaf(props: { onDrop: (dir: string) => void }) {
  return <button onClick={() => props.onDrop('a')}>drop</button>;
}

export function Tree() {
  return <Commits>{(onDrop) => <Leaf onDrop={onDrop} />}</Commits>;
}

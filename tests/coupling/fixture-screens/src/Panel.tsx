export function Panel(props: { onDone: (name: string) => void }) {
  const done = () => props.onDone('shop');
  return <button onClick={done}>done</button>;
}

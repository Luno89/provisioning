export function Opener(props: { onOpen?: ((path: string) => void) | undefined }) {
  return <button onClick={() => props.onOpen?.('a')}>open</button>;
}

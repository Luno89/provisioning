import { Opener } from './Opener';

export function Middle({ onOpen }: { onOpen?: ((path: string) => void) | undefined }) {
  return <Opener onOpen={onOpen} />;
}

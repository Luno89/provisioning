import Wizard from './Wizard';
import { useApps, useDelete } from './hooks';

type Loader = typeof useApps;

export function Section(props: { load?: Loader }) {
  useApps();
  useDelete('shop');
  return <section>{props.load ? <Wizard /> : null}</section>;
}

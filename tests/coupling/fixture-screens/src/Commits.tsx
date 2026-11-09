export function Commits(props: { children: (commit: (dir: string) => void) => JSX.Element }) {
  const commit = (dir: string) => { console.log(dir); };
  return props.children(commit);
}

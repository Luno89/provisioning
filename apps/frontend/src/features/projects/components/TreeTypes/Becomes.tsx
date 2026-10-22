import { useQuery } from '@tanstack/react-query';
import { getTreeTypeDescription, groveKeys } from '../../api/grove.js';
import { errorMessage } from '../../../../api/client.js';

export function Becomes({ typeId }: { typeId: string }) {
  const described = useQuery({ queryKey: groveKeys.treeTypeDescription(typeId), queryFn: () => getTreeTypeDescription(typeId) });
  if (described.isLoading) return <p className="text-xs text-slate-500">Putting it together…</p>;
  if (described.isError) return <p className="text-xs text-rose-400">{errorMessage(described.error)}</p>;
  return <pre className="whitespace-pre-wrap break-words font-sans text-[12px] leading-relaxed text-slate-300">{described.data}</pre>;
}

export default Becomes;

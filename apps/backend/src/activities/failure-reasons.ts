export const messageOf = (failure: unknown): string => (failure instanceof Error ? failure.message : String(failure));

export function waitingOn(what: string): (failure: unknown) => void {
  let last: string | undefined;
  return (failure) => {
    const reason = messageOf(failure);
    if (reason === last) return;
    last = reason;
    console.warn(`[waiting] ${what} could not be asked, asking again: ${reason}`);
  };
}

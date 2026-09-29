/**
 * What a child run is handed: the inputs its parent's node wrote, and nothing added.
 *
 * A child is told about them by its own conversation node — `openingWith` labels every named input the opening does
 * not already say, and says them on their own when the opening is empty — so a host that synthesises an opening of
 * its own only duplicates what the child renders anyway, and loses the sentence the procedure wrote. Both hosts go
 * through here so a procedure written against one behaves the same on the other.
 */
export const childInputs = (inputs: Record<string, unknown>): Record<string, unknown> => ({
  ...inputs,
  message: typeof inputs.message === 'string' ? inputs.message : '',
});

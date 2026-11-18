export function madeActivities(prefix: string) {
  return {
    Made: async (name: string): Promise<string> => `${prefix} ${name}`,
  };
}

export const { Made } = madeActivities('made');

export async function Greet(name: string): Promise<string> {
  return `hello ${name}`;
}

export const Count = async (): Promise<number> => 1;

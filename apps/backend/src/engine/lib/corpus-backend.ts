export const VECTOR_SIZE = 384;

export function pointId(chunkId: string): string {
  let h1 = 0x9e3779b9, h2 = 0x85ebca6b;
  for (let i = 0; i < chunkId.length; i++) {
    h1 = Math.imul(h1 ^ chunkId.charCodeAt(i), 0x85ebca6b) >>> 0;
    h2 = Math.imul(h2 ^ chunkId.charCodeAt(i), 0xc2b2ae35) >>> 0;
  }
  const hex = (n: number) => (n >>> 0).toString(16).padStart(8, '0');
  const raw = `${hex(h1)}${hex(h2)}${hex(h1 ^ 0x5bf03635)}${hex(h2 ^ 0x27d4eb2f)}`;
  return `${raw.slice(0, 8)}-${raw.slice(8, 12)}-4${raw.slice(13, 16)}-a${raw.slice(17, 20)}-${raw.slice(20, 32)}`;
}

export function collectionConfig(): unknown {
  return {
    vectors: { size: VECTOR_SIZE, distance: 'Cosine', on_disk: true },
    quantization_config: { scalar: { type: 'int8', always_ram: true } },
  };
}

export interface WireField { number: number; start: number; end: number; value?: Buffer | undefined }

function varint(buffer: Buffer, at: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  for (let index = at; index < buffer.length; index += 1) {
    const byte = buffer[index]!;
    value += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) return { value, next: index + 1 };
    shift += 7;
    if (shift > 63) break;
  }
  throw new Error('a protobuf varint ran past the message');
}

export const encodeVarint = (value: number): Buffer => {
  const bytes: number[] = [];
  let rest = value;
  while (rest >= 0x80) { bytes.push((rest % 0x80) | 0x80); rest = Math.floor(rest / 0x80); }
  bytes.push(rest);
  return Buffer.from(bytes);
};

export function wireFields(message: Buffer): WireField[] {
  const fields: WireField[] = [];
  let at = 0;
  while (at < message.length) {
    const start = at;
    const key = varint(message, at);
    const number = Math.floor(key.value / 8);
    const type = key.value % 8;
    at = key.next;
    if (type === 0) at = varint(message, at).next;
    else if (type === 1) at += 8;
    else if (type === 5) at += 4;
    else if (type === 2) {
      const length = varint(message, at);
      const value = message.subarray(length.next, length.next + length.value);
      if (value.length !== length.value) throw new Error('a protobuf field ran past the message');
      at = length.next + length.value;
      fields.push({ number, start, end: at, value });
      continue;
    } else throw new Error(`a protobuf field of wire type ${type} cannot be read here`);
    if (at > message.length) throw new Error('a protobuf field ran past the message');
    fields.push({ number, start, end: at });
  }
  return fields;
}

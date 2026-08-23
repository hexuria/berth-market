export function newId(prefix: string): string {
  const uuid = crypto.randomUUID().replaceAll("-", "");
  return `${prefix}_${uuid.slice(0, 20)}`;
}

export function newAddress(seed?: string): string {
  const bytes = new Uint8Array(20);
  if (seed) {
    const encoded = new TextEncoder().encode(seed);
    for (let i = 0; i < 20; i += 1) {
      bytes[i] = (encoded[i % encoded.length] ?? 0) ^ (i * 17);
    }
  } else {
    crypto.getRandomValues(bytes);
  }
  return `0x${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export function newTxHash(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `0x${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

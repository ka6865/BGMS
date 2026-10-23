const ZERO = BigInt(0);
const MASK64 = BigInt("0xffffffffffffffff");
const MASK32 = BigInt("0xffffffff");
const P1 = BigInt("0x9e3779b185ebca87");
const P2 = BigInt("0xc2b2ae3d27d4eb4f");
const P3 = BigInt("0x165667b19e3779f9");
const P4 = BigInt("0x85ebca77c2b2ae63");
const P5 = BigInt("0x27d4eb2f165667c5");
const SECRET = Uint8Array.from((
  "b8fe6c3923a44bbe7c01812cf721ad1cded46de9839097db7240a4a4b7b3671f"
  + "cb79e64eccc0e578825ad07dccff7221b8084674f743248ee03590e6813a264c"
  + "3c2852bb91c300cb88d0658b1b532ea371644897a20df94e3819ef46a9deacd8"
  + "a8fa763fe39c343ff9dcbbc7c70b4f1d8a51e04bcdb45931c89f7ec9d9787364"
  + "eac5ac8334d3ebc3c581a0fffa1363eb170ddd51b7f0da49d316552629d4689e"
  + "2b16be587d47a1fc8ff8b8d17ad031ce45cb3a8f95160428afd7fbcabb4b407e"
).match(/../g)!.map(byte => parseInt(byte, 16)));

function read(bytes: Uint8Array, offset: number, size = 8): bigint {
  let value = ZERO;
  for (let index = size - 1; index >= 0; index--) value = (value << BigInt(8)) | BigInt(bytes[offset + index]);
  return value;
}

function rotate(value: bigint, bits: number): bigint {
  return ((value << BigInt(bits)) | (value >> BigInt(64 - bits))) & MASK64;
}

function fold(left: bigint, right: bigint): bigint {
  const product = left * right;
  return (product & MASK64) ^ (product >> BigInt(64));
}

function avalanche(value: bigint): bigint {
  value = ((value ^ (value >> BigInt(37))) * BigInt("0x165667919e3779f9")) & MASK64;
  return value ^ (value >> BigInt(32));
}

function avalanche64(value: bigint): bigint {
  value = ((value ^ (value >> BigInt(33))) * P2) & MASK64;
  value = ((value ^ (value >> BigInt(29))) * P3) & MASK64;
  return value ^ (value >> BigInt(32));
}

// xxh3_64의 seed=0 경로만 구현하며 모든 연산은 부호 없는 64비트로 제한한다.
export function xxh3_64(input: string): bigint {
  const bytes = new TextEncoder().encode(input);
  const length = bytes.length;
  const len = BigInt(length);
  const mix = (offset: number, secretOffset: number) => fold(
    read(bytes, offset) ^ read(SECRET, secretOffset), read(bytes, offset + 8) ^ read(SECRET, secretOffset + 8),
  );
  if (length <= 16) {
    if (length > 8) {
      const low = read(bytes, 0) ^ read(SECRET, 24) ^ read(SECRET, 32);
      const high = read(bytes, length - 8) ^ read(SECRET, 40) ^ read(SECRET, 48);
      let swapped = ZERO;
      for (let index = 0; index < 8; index++) swapped = (swapped << BigInt(8)) | ((low >> BigInt(index * 8)) & BigInt(255));
      return avalanche((len + swapped + high + fold(low, high)) & MASK64);
    }
    if (length >= 4) {
      let value = (read(bytes, 0, 4) << BigInt(32)) | read(bytes, length - 4, 4);
      value ^= read(SECRET, 8) ^ read(SECRET, 16);
      value ^= rotate(value, 49) ^ rotate(value, 24);
      value = (value * BigInt("0x9fb21c651e98df25")) & MASK64;
      value ^= (value >> BigInt(35)) + len;
      value = (value * BigInt("0x9fb21c651e98df25")) & MASK64;
      return value ^ (value >> BigInt(28));
    }
    if (length) {
      const combined = BigInt(bytes[0] * 65536 + bytes[length >> 1] * 16777216 + bytes[length - 1] + length * 256);
      return avalanche64(combined ^ read(SECRET, 0, 4) ^ read(SECRET, 4, 4));
    }
    return avalanche64(read(SECRET, 56) ^ read(SECRET, 64));
  }
  let accumulator = (len * P1) & MASK64;
  if (length <= 128) {
    for (let index = 0; index < Math.ceil(length / 32); index++) {
      accumulator += mix(index * 16, index * 32) + mix(length - (index + 1) * 16, index * 32 + 16);
    }
    return avalanche(accumulator & MASK64);
  }
  if (length <= 240) {
    const rounds = Math.floor(length / 16);
    for (let index = 0; index < 8; index++) accumulator += mix(index * 16, index * 16);
    accumulator = avalanche(accumulator & MASK64);
    for (let index = 8; index < rounds; index++) accumulator += mix(index * 16, (index - 8) * 16 + 3);
    return avalanche((accumulator + mix(length - 16, 119)) & MASK64);
  }
  const lanes = [BigInt("0xc2b2ae3d"), P1, P2, P3, P4, BigInt("0x85ebca77"), P5, BigInt("0x9e3779b1")];
  const stripe = (offset: number, secretOffset: number) => {
    for (let index = 0; index < 8; index++) {
      const data = read(bytes, offset + index * 8);
      const keyed = data ^ read(SECRET, secretOffset + index * 8);
      lanes[index ^ 1] = (lanes[index ^ 1] + data) & MASK64;
      lanes[index] = (lanes[index] + (keyed & MASK32) * (keyed >> BigInt(32))) & MASK64;
    }
  };
  const blocks = Math.floor((length - 1) / 1024);
  for (let block = 0; block < blocks; block++) {
    for (let index = 0; index < 16; index++) stripe(block * 1024 + index * 64, index * 8);
    for (let index = 0; index < 8; index++) {
      lanes[index] = ((lanes[index] ^ (lanes[index] >> BigInt(47)) ^ read(SECRET, 128 + index * 8)) * BigInt("0x9e3779b1")) & MASK64;
    }
  }
  const remaining = Math.floor((length - 1 - blocks * 1024) / 64);
  for (let index = 0; index < remaining; index++) stripe(blocks * 1024 + index * 64, index * 8);
  stripe(length - 64, 121);
  for (let index = 0; index < 4; index++) {
    accumulator += fold(lanes[index * 2] ^ read(SECRET, 11 + index * 16), lanes[index * 2 + 1] ^ read(SECRET, 19 + index * 16));
  }
  return avalanche(accumulator & MASK64);
}

export function stringTableHash(key: string): string {
  return `{${(xxh3_64(key.toLowerCase()) & BigInt("0x3fffffffff")).toString(16).padStart(10, "0")}}`;
}

export type StringTable = Readonly<Record<string, string>>;

export function parseStringTable(input: unknown): StringTable {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("문자열 테이블 형식이 잘못되었습니다.");
  const entries = "entries" in input ? input.entries : input;
  if (!entries || typeof entries !== "object" || Array.isArray(entries)) throw new Error("문자열 entries가 없습니다.");
  for (const value of Object.values(entries)) {
    if (typeof value !== "string") throw new Error("문자열 테이블에 문자열이 아닌 값이 있습니다.");
  }
  return entries as StringTable;
}

export function lookupString(table: StringTable, key: string): string | null {
  const lower = key.toLowerCase();
  if (Object.hasOwn(table, lower)) return table[lower];
  const hashed = stringTableHash(lower);
  return Object.hasOwn(table, hashed) ? table[hashed] : null;
}

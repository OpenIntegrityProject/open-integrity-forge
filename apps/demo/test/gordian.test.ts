import { parseLabel } from "passkey-cloudflare";
import {
  assertion,
  BIP39_WORDS,
  BytewordsError,
  bytewordsIdentifier,
  crc32,
  decodeBip39,
  decodeBytewords,
  encodeArray,
  encodeBip39,
  encodeBytes,
  encodeBytewords,
  encodeMap,
  encodeTag,
  encodeText,
  encodeUint,
  envelopeCbor,
  leaf,
  node,
  recoverySecretFromTyped,
  seedBip39,
  seedEnvelope,
  seedSecretFromTyped,
  seedUr,
  seedWords,
  taggedSeed,
  type BytewordsStyle,
  type Envelope,
} from "passkey-cloudflare/gordian";
import { describe, expect, it } from "vitest";
import bip39 from "./fixtures/bip39-test-vectors.json";
import vectors from "./fixtures/gordian-test-vectors.json";

// The fixture is generated outside this repository by the Blockchain Commons
// reference implementations (ADR 0005); see its "about" and "references".
// Every case in it must have a builder here, so a new case cannot pass by
// being skipped.

const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
const bytes = (h: string) => Uint8Array.from(h.match(/../g) ?? [], (p) => parseInt(p, 16));

const code = vectors.recoveryCode.inputs;
const secret = bytes(code.secretHex);
const withMetadata = code.seedWithMetadata;

const text = encodeText;
const uint = encodeUint;
const tag = encodeTag;
// The dCBOR vector nests tags 200, 201 and 221 in an older Envelope layout.
const tag200 = (content: Uint8Array) => tag(200, content);

const DCBOR: Record<string, () => Uint8Array> = {
  "bytes-4": () => encodeBytes(bytes("00112233")),
  "bytes-3": () => encodeBytes(bytes("112233")),
  "bytes-32": () => encodeBytes(bytes("c0a7da14e5847c526244f7e083d26fe33f86d2313ad2b77164233444423a50a7")),
  "text-hello": () => text("Hello"),
  "tag-1-text": () => tag(1, text("Hello")),
  "tag-40300-seed": () =>
    tag(
      40300,
      encodeMap([
        [uint(1), encodeBytes(bytes("c7098580125e2ab0981253468b2dbc52"))],
        [uint(2), tag(1, uint(18394))],
      ]),
    ),
  "nested-tags-200-201": () =>
    tag200(
      encodeArray([
        tag200(tag(201, text("Alice"))),
        tag200(
          tag(221, encodeArray([tag200(tag(201, text("knows"))), tag200(tag(201, text("Bob")))])),
        ),
      ]),
    ),
  "secret-bytes": () => encodeBytes(secret),
  "code-seed": () => taggedSeed(secret),
  "seed-with-metadata": () =>
    tag(
      40300,
      encodeMap([
        // Given out of order: the map sorts its keys.
        [uint(4), text(withMetadata.note)],
        [uint(1), encodeBytes(bytes(withMetadata.dataHex))],
        [uint(3), text(withMetadata.name)],
        [uint(2), tag(1, uint(withMetadata.dateEpochSeconds))],
      ]),
    ),
};

const knowsBob = async () => assertion(await leaf(text("knows")), await leaf(text("Bob")));

const ENVELOPES: Record<string, () => Promise<Envelope>> = {
  "leaf-text": () => leaf(text("Hello.")),
  "leaf-int": () => leaf(uint(42)),
  "assertion-only": knowsBob,
  "subject-with-one-assertion": async () => node(await leaf(text("Alice")), [await knowsBob()]),
  "code-seed-envelope": () => seedEnvelope(secret),
  "seed-envelope-with-metadata": () =>
    seedEnvelope(bytes(withMetadata.dataHex), {
      date: new Date(`${withMetadata.date}T00:00:00Z`),
      name: withMetadata.name,
      note: withMetadata.note,
    }),
};

const STYLES: BytewordsStyle[] = ["standard", "uri", "minimal"];

describe("dCBOR", () => {
  for (const c of [...vectors.dcbor, ...vectors.recoveryCode.dcbor]) {
    it(`encodes ${c.id}: ${c.diagnostic}`, () => {
      const build = DCBOR[c.id];
      expect(build, `no builder for ${c.id}`).toBeDefined();
      expect(hex(build!())).toBe(c.hex);
    });
  }

  it("refuses a map with a repeated key", () => {
    expect(() => encodeMap([[uint(1), uint(2)], [uint(1), uint(3)]])).toThrow();
  });
});

describe("Bytewords", () => {
  for (const c of [...vectors.bytewords, ...vectors.recoveryCode.bytewords]) {
    const payload = bytes(c.payloadHex);

    it(`computes the CRC32 of ${c.id}`, () => {
      expect(crc32(payload).toString(16).padStart(8, "0")).toBe(c.crc32Hex);
    });

    for (const style of STYLES) {
      it(`encodes and decodes ${c.id} in ${style} style`, () => {
        expect(encodeBytewords(payload, style)).toBe(c[style]);
        expect(hex(decodeBytewords(c[style], style))).toBe(c.payloadHex);
      });
    }
  }

  for (const c of vectors.bytewordsDecodeErrors) {
    it(`refuses ${c.id} as ${c.error}`, () => {
      let error: unknown;
      try {
        decodeBytewords(c.input, c.style as BytewordsStyle);
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(BytewordsError);
      expect((error as BytewordsError).kind).toBe(c.error);
    });
  }
});

describe("Envelope", () => {
  for (const c of [...vectors.envelope, ...vectors.recoveryCode.envelope]) {
    it(`builds ${c.id}`, async () => {
      const build = ENVELOPES[c.id];
      expect(build, `no builder for ${c.id}`).toBeDefined();
      const envelope = await build!();
      expect(hex(envelopeCbor(envelope))).toBe(c.hex);
      expect(hex(envelope.digest)).toBe(c.digest);
    });
  }

  it("gives an assertion's parts their own digests", async () => {
    const parts = vectors.envelope.find((c) => c.id === "assertion-only")!.partDigests!;
    expect(hex((await leaf(text("knows"))).digest)).toBe(parts.predicate);
    expect(hex((await leaf(text("Bob"))).digest)).toBe(parts.object);
  });
});

describe("recovery code text", () => {
  const input = (id: string) => vectors.recoveryCode.inputAccepted.find((c) => c.id === id)!.input;

  it("is the seed's UR", () => {
    expect(seedUr(secret)).toBe(input("ur"));
  });

  it("reads aloud as the UR body in standard Bytewords", () => {
    expect(seedWords(input("ur"))).toBe(input("ur-body-standard"));
  });

  for (const c of vectors.recoveryCode.inputAccepted) {
    it(`accepts ${c.id}`, () => {
      expect(hex(seedSecretFromTyped(c.input) ?? new Uint8Array())).toBe(c.secretHex);
    });
  }

  for (const c of vectors.recoveryCode.inputRejected) {
    it(`refuses ${c.id}`, () => {
      expect(seedSecretFromTyped(c.input)).toBeNull();
    });
  }
});

describe("BIP39 words", () => {
  it("use the published English wordlist", async () => {
    const file = new TextEncoder().encode(BIP39_WORDS.join("\n") + "\n");
    expect(BIP39_WORDS).toHaveLength(2048);
    expect(hex(new Uint8Array(await crypto.subtle.digest("SHA-256", file)))).toBe(bip39.wordlist.sha256);
  });

  for (const c of bip39.cases) {
    it(`spell ${c.entropyHex} and read it back`, async () => {
      expect(await encodeBip39(bytes(c.entropyHex))).toBe(c.mnemonic);
      expect(hex((await decodeBip39(c.mnemonic)) ?? new Uint8Array())).toBe(c.entropyHex);
    });
  }

  it("read any case, any whitespace, and a word's first four letters", async () => {
    const c = bip39.cases[1]!;
    const short = c.mnemonic.split(" ").map((w) => w.slice(0, 4)).join(" ");
    for (const typed of [c.mnemonic.toUpperCase(), `  ${c.mnemonic.replaceAll(" ", "\n\t")} `, short]) {
      expect(hex((await decodeBip39(typed)) ?? new Uint8Array())).toBe(c.entropyHex);
    }
  });

  it("refuse a failed checksum, a wrong count, an unknown word and a three-letter prefix", async () => {
    const words = bip39.cases[0]!.mnemonic.split(" ");
    for (const typed of [
      Array(12).fill("abandon").join(" "),
      words.slice(0, 11).join(" "),
      [...words, "about"].join(" "),
      [...words.slice(0, 11), "zzzz"].join(" "),
      [...words.slice(0, 11), "abo"].join(" "),
    ]) {
      expect(await decodeBip39(typed)).toBeNull();
    }
  });

  it("refuse entropy that is not 16 bytes", async () => {
    await expect(encodeBip39(new Uint8Array(32))).rejects.toThrow();
  });

  it("spell a recovery code's secret, and name that code", async () => {
    const ur = vectors.recoveryCode.inputAccepted.find((c) => c.id === "ur")!.input;
    const words = await seedBip39(ur);
    expect(words).toBe(await encodeBip39(secret));
    expect(hex((await recoverySecretFromTyped(words)) ?? new Uint8Array())).toBe(code.secretHex);
    expect(hex((await recoverySecretFromTyped(ur)) ?? new Uint8Array())).toBe(code.secretHex);
  });
});

describe("passkey labels", () => {
  for (const c of vectors.labels.cases) {
    it(`spells ${c.bytesHex} as ${c.label}`, () => {
      expect(bytewordsIdentifier(bytes(c.bytesHex), "-")).toBe(c.label);
    });
  }

  for (const c of vectors.labels.inputs) {
    it(`reads ${c.id}`, () => {
      expect(parseLabel(c.input)).toBe(c.label);
    });
  }
});

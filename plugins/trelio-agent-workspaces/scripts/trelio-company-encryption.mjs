/**
 * Browser-compatible primitives for encrypted Trelio companies.
 *
 * The bridge deliberately keeps this module dependency-free.  Node.js 22
 * already provides the P-256, HKDF and AES-GCM primitives required by RFC
 * 9180, while a small local implementation prevents the installed plugin from
 * depending on a mutable global npm tree.  Secret phrases and private JWKs
 * must never be logged, passed through argv or written into a Workspace.
 */
import {
  createHash,
  createHmac,
  randomBytes,
  scrypt as scryptCallback,
  webcrypto,
} from "node:crypto";
import { open as openFile, stat } from "node:fs/promises";
import { promisify } from "node:util";

export const COMPANY_ENCRYPTION_SUITE = "trelio-e2ee-v1";
export const COMPANY_ENCRYPTION_FILE_CHUNK_BYTES = 4 * 1024 * 1024;
export const COMPANY_ENCRYPTED_FILE_MAGIC = Buffer.from("TRELIOE1", "ascii");

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });
const scrypt = promisify(scryptCallback);

const KEM_ID = 0x0010; // DHKEM(P-256, HKDF-SHA256)
const KDF_ID = 0x0001; // HKDF-SHA256
const AEAD_ID = 0x0002; // AES-256-GCM
const HPKE_VERSION_LABEL = Buffer.from("HPKE-v1", "ascii");
const HPKE_INFO = null;

const toBytes = (value) => {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  throw new TypeError("Expected binary data.");
};

const ownedArrayBuffer = (value) => {
  const bytes = toBytes(value);
  return Uint8Array.from(bytes).buffer;
};

const normalizeCanonicalValue = (value, valuePath = "$") => {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;

  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`Non-finite number at ${valuePath}.`);
    return Object.is(value, -0) ? 0 : value;
  }

  if (Array.isArray(value)) {
    return value.map((item, index) => normalizeCanonicalValue(item, `${valuePath}[${index}]`));
  }

  if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => {
      if (typeof value[key] === "undefined") {
        throw new TypeError(`Undefined value at ${valuePath}.${key}.`);
      }
      return [key, normalizeCanonicalValue(value[key], `${valuePath}.${key}`)];
    }));
  }

  throw new TypeError(`Unsupported canonical JSON value at ${valuePath}.`);
};

export const canonicalJson = (value) => JSON.stringify(normalizeCanonicalValue(value));
export const canonicalBytes = (value) => Buffer.from(canonicalJson(value), "utf8");

export const encodeBase64Url = (value) => toBytes(value).toString("base64url");

export const decodeBase64Url = (value, fieldName = "binary value") => {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]*$/u.test(value)) {
    throw new Error(`${fieldName} is not unpadded base64url data.`);
  }
  return Buffer.from(value, "base64url");
};

const normalizePublicP256Jwk = (jwk, usage) => {
  if (
    !jwk
    || typeof jwk !== "object"
    || jwk.kty !== "EC"
    || jwk.crv !== "P-256"
    || typeof jwk.x !== "string"
    || typeof jwk.y !== "string"
    || "d" in jwk
  ) {
    throw new Error(`Expected a public P-256 ${usage} JWK.`);
  }

  // `key_ops`, `alg`, `use` and runtime-specific export details are not key
  // material. Excluding them keeps fingerprints and signed records identical
  // to the browser/backend protocol on every supported Web Crypto runtime.
  return {
    kty: "EC",
    crv: "P-256",
    x: jwk.x,
    y: jwk.y,
    ext: true,
  };
};

const normalizePrivateP256Jwk = (jwk, usage) => {
  if (
    !jwk
    || typeof jwk !== "object"
    || jwk.kty !== "EC"
    || jwk.crv !== "P-256"
    || typeof jwk.x !== "string"
    || typeof jwk.y !== "string"
    || typeof jwk.d !== "string"
  ) {
    throw new Error(`Expected a private P-256 ${usage} JWK.`);
  }

  return {
    kty: "EC",
    crv: "P-256",
    x: jwk.x,
    y: jwk.y,
    d: jwk.d,
    ...(usage === "signing" ? { key_ops: ["sign"] } : { key_ops: ["deriveBits"] }),
    ext: true,
  };
};

const publicJwkFromPrivate = (jwk, usage) => normalizePublicP256Jwk({
  kty: jwk.kty,
  crv: jwk.crv,
  x: jwk.x,
  y: jwk.y,
}, usage);

export const calculateKeyFingerprint = ({ publicEncryptionJwk, publicSigningJwk }) => (
  createHash("sha256")
    .update(canonicalBytes({
      suite: COMPANY_ENCRYPTION_SUITE,
      publicEncryptionJwk: normalizePublicP256Jwk(publicEncryptionJwk, "encryption"),
      publicSigningJwk: normalizePublicP256Jwk(publicSigningJwk, "signing"),
    }))
    .digest("base64url")
);

export const buildAgentDeviceRegistrationRecord = (input) => ({
  suite: COMPANY_ENCRYPTION_SUITE,
  purpose: "agent-device-registration",
  companyId: String(input.companyId),
  userId: String(input.userId),
  fingerprint: String(input.fingerprint),
  publicEncryptionJwk: normalizePublicP256Jwk(input.publicEncryptionJwk, "encryption"),
  publicSigningJwk: normalizePublicP256Jwk(input.publicSigningJwk, "signing"),
});

/** Exact transport manifest verified by the Trelio backend before CAS. */
export const buildEncryptedAgentWorkspaceRevisionRecord = (input) => ({
  suite: COMPANY_ENCRYPTION_SUITE,
  purpose: "agent-workspace-revision",
  companyId: String(input.companyId),
  workspaceId: String(input.workspaceId),
  runId: String(input.runId),
  revisionKind: String(input.revisionKind),
  baseHead: String(input.baseHead),
  workspaceHead: String(input.workspaceHead),
  scopeId: String(input.scopeId),
  scopeEpoch: Number(input.scopeEpoch),
  writerDeviceId: String(input.writerDeviceId),
  ciphertextSha256: String(input.ciphertextSha256),
  ciphertextSizeBytes: Number(input.ciphertextSizeBytes),
  fencingToken: Number(input.fencingToken),
  ...(input.browserProjectionId
    ? { browserProjectionId: String(input.browserProjectionId) }
    : {}),
});

/** Exact transport manifest for the browser-addressable encrypted file pack. */
export const buildEncryptedAgentWorkspaceBrowserProjectionRecord = (input) => ({
  suite: COMPANY_ENCRYPTION_SUITE,
  purpose: "agent-workspace-browser-projection",
  companyId: String(input.companyId),
  workspaceId: String(input.workspaceId),
  runId: String(input.runId),
  baseHead: String(input.baseHead),
  workspaceHead: String(input.workspaceHead),
  projectionId: String(input.projectionId),
  scopeId: String(input.scopeId),
  scopeEpoch: Number(input.scopeEpoch),
  writerDeviceId: String(input.writerDeviceId),
  ciphertextSha256: String(input.ciphertextSha256),
  ciphertextSizeBytes: Number(input.ciphertextSizeBytes),
  indexSha256: String(input.indexSha256),
  fileCount: Number(input.fileCount),
  fencingToken: Number(input.fencingToken),
});

/**
 * A migration is signed independently from a Run: it can attach only to the
 * exact accepted head that the authorized bridge downloaded and opened.
 */
export const buildEncryptedAgentWorkspaceBrowserProjectionMigrationRecord = (input) => ({
  suite: COMPANY_ENCRYPTION_SUITE,
  purpose: "agent-workspace-browser-projection-migration",
  companyId: String(input.companyId),
  workspaceId: String(input.workspaceId),
  workspaceHead: String(input.workspaceHead),
  encryptedRevisionId: String(input.encryptedRevisionId),
  projectionId: String(input.projectionId),
  scopeId: String(input.scopeId),
  scopeEpoch: Number(input.scopeEpoch),
  writerDeviceId: String(input.writerDeviceId),
  ciphertextSha256: String(input.ciphertextSha256),
  ciphertextSizeBytes: Number(input.ciphertextSizeBytes),
  indexSha256: String(input.indexSha256),
  fileCount: Number(input.fileCount),
});

export const signCompanyEncryptionRecord = async (signingPrivateKey, record) => {
  const signature = await webcrypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    signingPrivateKey,
    ownedArrayBuffer(canonicalBytes(record)),
  );
  return encodeBase64Url(signature);
};

export const verifyCompanyEncryptionRecord = async (publicSigningJwk, record, signature) => {
  const key = await webcrypto.subtle.importKey(
    "jwk",
    normalizePublicP256Jwk(publicSigningJwk, "signing"),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  return webcrypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    ownedArrayBuffer(decodeBase64Url(signature, "signature")),
    ownedArrayBuffer(canonicalBytes(record)),
  );
};

const importPrivateKeys = async (privateBundle) => {
  if (
    privateBundle?.suite !== COMPANY_ENCRYPTION_SUITE
    || privateBundle?.version !== 1
  ) {
    throw new Error("Agent encryption device has an unsupported private bundle.");
  }

  const [encryptionPrivateKey, signingPrivateKey] = await Promise.all([
    webcrypto.subtle.importKey(
      "jwk",
      normalizePrivateP256Jwk(privateBundle.encryptionPrivateJwk, "encryption"),
      { name: "ECDH", namedCurve: "P-256" },
      false,
      ["deriveBits"],
    ),
    webcrypto.subtle.importKey(
      "jwk",
      normalizePrivateP256Jwk(privateBundle.signingPrivateJwk, "signing"),
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign"],
    ),
  ]);
  return { encryptionPrivateKey, signingPrivateKey };
};

export const createAgentEncryptionDevice = async () => {
  const [encryptionKeyPair, signingKeyPair] = await Promise.all([
    webcrypto.subtle.generateKey(
      { name: "ECDH", namedCurve: "P-256" },
      true,
      ["deriveBits"],
    ),
    webcrypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign", "verify"],
    ),
  ]);
  const [publicEncryptionJwk, publicSigningJwk, encryptionPrivateJwk, signingPrivateJwk] = await Promise.all([
    webcrypto.subtle.exportKey("jwk", encryptionKeyPair.publicKey),
    webcrypto.subtle.exportKey("jwk", signingKeyPair.publicKey),
    webcrypto.subtle.exportKey("jwk", encryptionKeyPair.privateKey),
    webcrypto.subtle.exportKey("jwk", signingKeyPair.privateKey),
  ]);
  const normalizedPublicEncryptionJwk = normalizePublicP256Jwk(publicEncryptionJwk, "encryption");
  const normalizedPublicSigningJwk = normalizePublicP256Jwk(publicSigningJwk, "signing");

  return {
    suite: COMPANY_ENCRYPTION_SUITE,
    publicEncryptionJwk: normalizedPublicEncryptionJwk,
    publicSigningJwk: normalizedPublicSigningJwk,
    fingerprint: calculateKeyFingerprint({
      publicEncryptionJwk: normalizedPublicEncryptionJwk,
      publicSigningJwk: normalizedPublicSigningJwk,
    }),
    privateBundle: {
      suite: COMPANY_ENCRYPTION_SUITE,
      version: 1,
      encryptionPrivateJwk: normalizePrivateP256Jwk(encryptionPrivateJwk, "encryption"),
      signingPrivateJwk: normalizePrivateP256Jwk(signingPrivateJwk, "signing"),
    },
    privateKeys: {
      encryptionPrivateKey: encryptionKeyPair.privateKey,
      signingPrivateKey: signingKeyPair.privateKey,
    },
  };
};

const deriveLocalWrappingKey = async (encryptionSecret, salt, parameters) => {
  if (typeof encryptionSecret !== "string" || encryptionSecret.length < 12) {
    throw new Error("Ключ шифрования должен содержать не меньше 12 символов.");
  }

  const expected = { name: "scrypt", version: 1, N: 32768, r: 8, p: 1, keyLength: 32 };
  const actual = parameters ?? expected;

  if (Object.entries(expected).some(([key, value]) => actual[key] !== value)) {
    throw new Error("Agent encryption device uses unsupported local KDF parameters.");
  }

  return Buffer.from(await scrypt(encryptionSecret, salt, expected.keyLength, {
    N: expected.N,
    r: expected.r,
    p: expected.p,
    maxmem: 128 * 1024 * 1024,
  }));
};

/**
 * Protect a newly generated device key with the user-entered encryption key.
 * The returned `trustedUnlockKey` is the derived key, not the phrase.  The
 * caller stores it in the bridge's existing owner-only private config and can
 * therefore unlock this trusted device without prompting on every Run.
 */
export const wrapAndRememberAgentEncryptionDevice = async ({
  device,
  encryptionSecret,
  companyId,
}) => {
  const kdf = { name: "scrypt", version: 1, N: 32768, r: 8, p: 1, keyLength: 32 };
  const salt = randomBytes(16);
  const nonce = randomBytes(12);
  const wrappingKeyBytes = await deriveLocalWrappingKey(encryptionSecret, salt, kdf);
  const wrappingKey = await webcrypto.subtle.importKey(
    "raw",
    ownedArrayBuffer(wrappingKeyBytes),
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"],
  );
  const aad = {
    suite: COMPANY_ENCRYPTION_SUITE,
    purpose: "agent-device-private-bundle",
    companyId: String(companyId),
    fingerprint: device.fingerprint,
    version: 1,
    kdf,
  };
  const plaintext = canonicalBytes(device.privateBundle);

  try {
    const ciphertext = await webcrypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv: ownedArrayBuffer(nonce),
        additionalData: ownedArrayBuffer(canonicalBytes(aad)),
        tagLength: 128,
      },
      wrappingKey,
      ownedArrayBuffer(plaintext),
    );
    return {
      record: {
        format: "trelio-agent-encryption-device",
        version: 1,
        suite: COMPANY_ENCRYPTION_SUITE,
        companyId: String(companyId),
        fingerprint: device.fingerprint,
        publicEncryptionJwk: device.publicEncryptionJwk,
        publicSigningJwk: device.publicSigningJwk,
        wrappedPrivateBundle: {
          ciphertext: encodeBase64Url(ciphertext),
          nonce: encodeBase64Url(nonce),
          kdf: { ...kdf, salt: encodeBase64Url(salt) },
        },
        createdAt: new Date().toISOString(),
      },
      trustedUnlockKey: encodeBase64Url(wrappingKeyBytes),
    };
  } finally {
    plaintext.fill(0);
    wrappingKeyBytes.fill(0);
  }
};

export const unlockRememberedAgentEncryptionDevice = async ({ record, trustedUnlockKey }) => {
  if (
    record?.format !== "trelio-agent-encryption-device"
    || record?.version !== 1
    || record?.suite !== COMPANY_ENCRYPTION_SUITE
  ) {
    throw new Error("Saved agent encryption device has an unsupported format.");
  }

  const keyBytes = decodeBase64Url(trustedUnlockKey, "trusted device unlock key");

  if (keyBytes.byteLength !== 32) {
    throw new Error("Saved agent encryption device unlock key is invalid.");
  }

  const kdfWithSalt = record.wrappedPrivateBundle?.kdf ?? {};
  const { salt: _salt, ...kdf } = kdfWithSalt;
  const aad = {
    suite: COMPANY_ENCRYPTION_SUITE,
    purpose: "agent-device-private-bundle",
    companyId: String(record.companyId),
    fingerprint: String(record.fingerprint),
    version: 1,
    kdf,
  };
  const key = await webcrypto.subtle.importKey(
    "raw",
    ownedArrayBuffer(keyBytes),
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"],
  );
  let plaintext;

  try {
    plaintext = Buffer.from(await webcrypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: ownedArrayBuffer(decodeBase64Url(record.wrappedPrivateBundle?.nonce ?? "", "device nonce")),
        additionalData: ownedArrayBuffer(canonicalBytes(aad)),
        tagLength: 128,
      },
      key,
      ownedArrayBuffer(decodeBase64Url(
        record.wrappedPrivateBundle?.ciphertext ?? "",
        "encrypted device private bundle",
      )),
    ));
    const privateBundle = JSON.parse(textDecoder.decode(plaintext));
    const publicEncryptionJwk = publicJwkFromPrivate(
      privateBundle.encryptionPrivateJwk,
      "encryption",
    );
    const publicSigningJwk = publicJwkFromPrivate(
      privateBundle.signingPrivateJwk,
      "signing",
    );

    // Plugin 1.14.2 included JWK `key_ops` in its fingerprint while the
    // browser and backend protocol deliberately exclude export metadata.
    // Keep the persisted fingerprint only for authenticating the legacy AAD
    // above, then rebuild the live identity from the decrypted private keys so
    // an existing device can register without replacing its key pair.
    return {
      ...record,
      publicEncryptionJwk,
      publicSigningJwk,
      fingerprint: calculateKeyFingerprint({ publicEncryptionJwk, publicSigningJwk }),
      privateBundle,
      privateKeys: await importPrivateKeys(privateBundle),
    };
  } catch (error) {
    throw new Error("Не удалось открыть локальный ключ агента.", { cause: error });
  } finally {
    keyBytes.fill(0);
    plaintext?.fill(0);
  }
};

const uint16 = (value) => {
  const bytes = Buffer.alloc(2);
  bytes.writeUInt16BE(value, 0);
  return bytes;
};

const hpkeSuiteId = Buffer.concat([
  Buffer.from("HPKE", "ascii"),
  uint16(KEM_ID),
  uint16(KDF_ID),
  uint16(AEAD_ID),
]);
const kemSuiteId = Buffer.concat([Buffer.from("KEM", "ascii"), uint16(KEM_ID)]);

const hkdfExtract = (salt, inputKeyMaterial) => createHmac(
  "sha256",
  salt.byteLength > 0 ? salt : Buffer.alloc(32),
).update(inputKeyMaterial).digest();

const hkdfExpand = (pseudorandomKey, info, length) => {
  if (!Number.isSafeInteger(length) || length < 0 || length > 255 * 32) {
    throw new Error("HKDF output length is invalid.");
  }

  const blocks = [];
  let previous = Buffer.alloc(0);

  for (let blockIndex = 1; Buffer.concat(blocks).byteLength < length; blockIndex += 1) {
    previous = createHmac("sha256", pseudorandomKey)
      .update(previous)
      .update(info)
      .update(Buffer.from([blockIndex]))
      .digest();
    blocks.push(previous);
  }

  return Buffer.concat(blocks).subarray(0, length);
};

const labeledExtract = async (salt, label, inputKeyMaterial, suiteId) => hkdfExtract(
  toBytes(salt),
  Buffer.concat([
    HPKE_VERSION_LABEL,
    suiteId,
    Buffer.from(label, "ascii"),
    toBytes(inputKeyMaterial),
  ]),
);

const labeledExpand = (pseudorandomKey, label, info, length, suiteId) => hkdfExpand(
  pseudorandomKey,
  Buffer.concat([
    uint16(length),
    HPKE_VERSION_LABEL,
    suiteId,
    Buffer.from(label, "ascii"),
    toBytes(info),
  ]),
  length,
);

const serializePublicP256Jwk = (jwk) => Buffer.concat([
  Buffer.from([0x04]),
  decodeBase64Url(jwk.x, "P-256 x coordinate"),
  decodeBase64Url(jwk.y, "P-256 y coordinate"),
]);

const deriveKemSharedSecret = async ({ privateKey, recipientPublicJwk, encapsulatedPublicKey }) => {
  const publicKey = await webcrypto.subtle.importKey(
    "raw",
    ownedArrayBuffer(encapsulatedPublicKey),
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const diffieHellman = Buffer.from(await webcrypto.subtle.deriveBits(
    { name: "ECDH", public: publicKey },
    privateKey,
    256,
  ));
  const kemContext = Buffer.concat([
    encapsulatedPublicKey,
    serializePublicP256Jwk(recipientPublicJwk),
  ]);
  const extractAndExpandKey = await labeledExtract(
    Buffer.alloc(0),
    "eae_prk",
    diffieHellman,
    kemSuiteId,
  );

  try {
    return labeledExpand(extractAndExpandKey, "shared_secret", kemContext, 32, kemSuiteId);
  } finally {
    diffieHellman.fill(0);
    extractAndExpandKey.fill(0);
  }
};

const deriveHpkeAeadContext = async (sharedSecret, info = HPKE_INFO ?? canonicalBytes({
  suite: COMPANY_ENCRYPTION_SUITE,
  purpose: "hpke-envelope",
})) => {
  const [pskIdHash, infoHash] = await Promise.all([
    labeledExtract(Buffer.alloc(0), "psk_id_hash", Buffer.alloc(0), hpkeSuiteId),
    labeledExtract(Buffer.alloc(0), "info_hash", info, hpkeSuiteId),
  ]);
  const keyScheduleContext = Buffer.concat([Buffer.from([0x00]), pskIdHash, infoHash]);
  const secret = await labeledExtract(sharedSecret, "secret", Buffer.alloc(0), hpkeSuiteId);

  try {
    return {
      key: labeledExpand(secret, "key", keyScheduleContext, 32, hpkeSuiteId),
      baseNonce: labeledExpand(secret, "base_nonce", keyScheduleContext, 12, hpkeSuiteId),
    };
  } finally {
    pskIdHash.fill(0);
    infoHash.fill(0);
    keyScheduleContext.fill(0);
    secret.fill(0);
  }
};

export const hpkeSeal = async ({ recipientPublicEncryptionJwk, plaintext, aad }) => {
  const recipientJwk = normalizePublicP256Jwk(recipientPublicEncryptionJwk, "encryption");
  const recipientPublicKey = await webcrypto.subtle.importKey(
    "jwk",
    recipientJwk,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const ephemeral = await webcrypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  );
  const encapsulatedPublicKey = Buffer.from(await webcrypto.subtle.exportKey("raw", ephemeral.publicKey));
  const senderDh = Buffer.from(await webcrypto.subtle.deriveBits(
    { name: "ECDH", public: recipientPublicKey },
    ephemeral.privateKey,
    256,
  ));
  const kemContext = Buffer.concat([encapsulatedPublicKey, serializePublicP256Jwk(recipientJwk)]);
  const senderExtract = await labeledExtract(Buffer.alloc(0), "eae_prk", senderDh, kemSuiteId);
  const senderSharedSecret = labeledExpand(senderExtract, "shared_secret", kemContext, 32, kemSuiteId);
  const context = await deriveHpkeAeadContext(senderSharedSecret);
  const key = await webcrypto.subtle.importKey(
    "raw",
    ownedArrayBuffer(context.key),
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"],
  );

  try {
    const ciphertext = await webcrypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv: ownedArrayBuffer(context.baseNonce),
        additionalData: aad ? ownedArrayBuffer(canonicalBytes(aad)) : new ArrayBuffer(0),
        tagLength: 128,
      },
      key,
      ownedArrayBuffer(plaintext),
    );
    return { enc: encodeBase64Url(encapsulatedPublicKey), ciphertext: encodeBase64Url(ciphertext) };
  } finally {
    senderDh.fill(0);
    senderExtract.fill(0);
    senderSharedSecret.fill(0);
    context.key.fill(0);
    context.baseNonce.fill(0);
  }
};

export const hpkeOpen = async ({ recipientPrivateKey, recipientPrivateJwk, envelope, aad }) => {
  const encapsulatedPublicKey = decodeBase64Url(envelope?.enc ?? "", "HPKE encapsulated key");

  if (encapsulatedPublicKey.byteLength !== 65 || encapsulatedPublicKey[0] !== 0x04) {
    throw new Error("HPKE encapsulated P-256 key is invalid.");
  }

  const privateJwk = normalizePrivateP256Jwk(recipientPrivateJwk, "encryption");
  const sharedSecret = await deriveKemSharedSecret({
    privateKey: recipientPrivateKey,
    recipientPublicJwk: publicJwkFromPrivate(privateJwk, "encryption"),
    encapsulatedPublicKey,
  });
  const context = await deriveHpkeAeadContext(sharedSecret);
  const key = await webcrypto.subtle.importKey(
    "raw",
    ownedArrayBuffer(context.key),
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"],
  );

  try {
    return Buffer.from(await webcrypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: ownedArrayBuffer(context.baseNonce),
        additionalData: aad ? ownedArrayBuffer(canonicalBytes(aad)) : new ArrayBuffer(0),
        tagLength: 128,
      },
      key,
      ownedArrayBuffer(decodeBase64Url(envelope?.ciphertext ?? "", "HPKE ciphertext")),
    ));
  } finally {
    sharedSecret.fill(0);
    context.key.fill(0);
    context.baseNonce.fill(0);
  }
};

export const openScopePrivateKey = async ({ device, envelope }) => {
  const plaintext = await hpkeOpen({
    recipientPrivateKey: device.privateKeys.encryptionPrivateKey,
    recipientPrivateJwk: device.privateBundle.encryptionPrivateJwk,
    envelope: { enc: envelope.hpkeEnc, ciphertext: envelope.ciphertext },
    aad: envelope.aad,
  });

  try {
    const parsed = JSON.parse(textDecoder.decode(plaintext));
    if (
      parsed?.suite !== COMPANY_ENCRYPTION_SUITE
      || parsed?.version !== 1
      || !parsed.scopePrivateEncryptionJwk
    ) {
      throw new Error("Company scope envelope has an unsupported format.");
    }
    const privateJwk = normalizePrivateP256Jwk(parsed.scopePrivateEncryptionJwk, "encryption");
    return {
      privateJwk,
      privateKey: await webcrypto.subtle.importKey(
        "jwk",
        privateJwk,
        { name: "ECDH", namedCurve: "P-256" },
        false,
        ["deriveBits"],
      ),
    };
  } finally {
    plaintext.fill(0);
  }
};

export const buildCompanyEncryptionAad = (input) => {
  const positiveInteger = (value, fieldName) => {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${fieldName} must be positive.`);
    return value;
  };
  const protocolString = (value, fieldName) => {
    if (typeof value !== "string" || value.length === 0 || value.length > 255) {
      throw new Error(`${fieldName} must be a protocol string.`);
    }
    return value;
  };
  return {
    suite: COMPANY_ENCRYPTION_SUITE,
    companyId: protocolString(input.companyId, "companyId"),
    scopeId: protocolString(input.scopeId, "scopeId"),
    scopeEpoch: positiveInteger(input.scopeEpoch, "scopeEpoch"),
    entityType: protocolString(input.entityType, "entityType"),
    entityId: protocolString(input.entityId, "entityId"),
    entityRevision: positiveInteger(input.entityRevision, "entityRevision"),
    schemaVersion: positiveInteger(input.schemaVersion ?? 1, "schemaVersion"),
    purpose: protocolString(input.purpose, "purpose"),
  };
};

export const encryptCompanyPayload = async ({
  payload,
  scopePublicEncryptionJwk,
  aad: rawAad,
}) => {
  const aad = buildCompanyEncryptionAad(rawAad);
  const dataKeyBytes = randomBytes(32);
  const nonce = randomBytes(12);
  const dataKey = await webcrypto.subtle.importKey(
    "raw",
    ownedArrayBuffer(dataKeyBytes),
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"],
  );
  const plaintext = canonicalBytes(payload);
  try {
    const [ciphertext, wrappedDataKey] = await Promise.all([
      webcrypto.subtle.encrypt(
        {
          name: "AES-GCM",
          iv: ownedArrayBuffer(nonce),
          additionalData: ownedArrayBuffer(canonicalBytes(aad)),
          tagLength: 128,
        },
        dataKey,
        ownedArrayBuffer(plaintext),
      ),
      hpkeSeal({
        recipientPublicEncryptionJwk: scopePublicEncryptionJwk,
        plaintext: dataKeyBytes,
        aad: { ...aad, purpose: "payload-data-key" },
      }),
    ]);
    return {
      suite: COMPANY_ENCRYPTION_SUITE,
      schemaVersion: 1,
      aad,
      nonce: encodeBase64Url(nonce),
      ciphertext: encodeBase64Url(ciphertext),
      wrappedDataKey,
      ciphertextSha256: createHash("sha256").update(toBytes(ciphertext)).digest("hex"),
    };
  } finally {
    dataKeyBytes.fill(0);
    plaintext.fill(0);
  }
};

export const decryptCompanyPayload = async ({
  encryptedPayload,
  scopePrivateKey,
  scopePrivateJwk,
}) => {
  if (
    encryptedPayload?.suite !== COMPANY_ENCRYPTION_SUITE
    || encryptedPayload?.schemaVersion !== 1
  ) {
    throw new Error("Encrypted payload uses an unsupported protocol version.");
  }
  const aad = buildCompanyEncryptionAad(encryptedPayload.aad ?? {});
  const ciphertext = decodeBase64Url(encryptedPayload.ciphertext ?? "", "payload ciphertext");
  if (createHash("sha256").update(ciphertext).digest("hex") !== encryptedPayload.ciphertextSha256) {
    throw new Error("Encrypted payload digest does not match its manifest.");
  }
  const dataKeyBytes = await hpkeOpen({
    recipientPrivateKey: scopePrivateKey,
    recipientPrivateJwk: scopePrivateJwk,
    envelope: encryptedPayload.wrappedDataKey,
    aad: { ...aad, purpose: "payload-data-key" },
  });
  if (dataKeyBytes.byteLength !== 32) {
    dataKeyBytes.fill(0);
    throw new Error("Encrypted payload contains an invalid data key.");
  }
  const dataKey = await webcrypto.subtle.importKey(
    "raw",
    ownedArrayBuffer(dataKeyBytes),
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"],
  );
  let plaintext;
  try {
    plaintext = Buffer.from(await webcrypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: ownedArrayBuffer(decodeBase64Url(encryptedPayload.nonce ?? "", "payload nonce")),
        additionalData: ownedArrayBuffer(canonicalBytes(aad)),
        tagLength: 128,
      },
      dataKey,
      ownedArrayBuffer(ciphertext),
    ));
    return JSON.parse(textDecoder.decode(plaintext));
  } finally {
    dataKeyBytes.fill(0);
    plaintext?.fill(0);
  }
};

export const buildCompanyEncryptedTextMarker = (entityId, field) => {
  if (!/^[0-9a-f-]{36}$/u.test(entityId) || !/^[a-z][a-z0-9_]{0,63}$/u.test(field)) {
    throw new Error("Encrypted content marker is invalid.");
  }
  return `~e1:${entityId}:${field}~`;
};

export const buildCompanyEncryptedJsonMarker = (entityId, field, shape = "object") => {
  if (!/^[0-9a-f-]{36}$/u.test(entityId) || !/^[a-z][a-z0-9_]{0,63}$/u.test(field)) {
    throw new Error("Encrypted content marker is invalid.");
  }
  const marker = { $trelioE2ee: { v: 1, id: entityId, field } };
  return shape === "array" ? [marker] : marker;
};

const fileChunkNonce = (noncePrefix, chunkIndex) => {
  const nonce = Buffer.alloc(12);
  toBytes(noncePrefix).copy(nonce, 0);
  nonce.writeUInt32BE(chunkIndex, 8);
  return nonce;
};

const buildEncryptedFileHeaderSignatureRecord = (header) => ({
  suite: header.suite,
  version: header.version,
  kind: header.kind,
  aad: header.aad,
  chunkSizeBytes: header.chunkSizeBytes,
  chunkCount: header.chunkCount,
  plaintextSizeBytes: header.plaintextSizeBytes,
  noncePrefix: header.noncePrefix,
  wrappedDataKey: header.wrappedDataKey,
  metadataNonce: header.metadataNonce,
  metadataCiphertext: header.metadataCiphertext,
  writerIdentityId: header.writerIdentityId,
});

const writeAndHash = async (handle, hash, bytes, position) => {
  const buffer = toBytes(bytes);
  await handle.write(buffer, 0, buffer.byteLength, position);
  hash.update(buffer);
  return position + buffer.byteLength;
};

/** Encrypt a file in constant memory into the browser-compatible TRELIOE1 format. */
export const encryptFileToCompanyContainer = async ({
  sourcePath,
  destinationPath,
  scopePublicEncryptionJwk,
  aad: rawAad,
  originalName,
  mimeType,
  writerDeviceId = null,
  signingPrivateKey = null,
}) => {
  const sourceStat = await stat(sourcePath);
  if (!sourceStat.isFile()) throw new Error("Encrypted source must be a regular file.");
  const aad = buildCompanyEncryptionAad({ ...rawAad, purpose: "file" });
  const dataKeyBytes = randomBytes(32);
  const noncePrefix = randomBytes(8);
  const metadataNonce = randomBytes(12);
  const dataKey = await webcrypto.subtle.importKey(
    "raw",
    ownedArrayBuffer(dataKeyBytes),
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"],
  );
  const wrappedDataKey = await hpkeSeal({
    recipientPublicEncryptionJwk: scopePublicEncryptionJwk,
    plaintext: dataKeyBytes,
    aad: { ...aad, purpose: "file-data-key" },
  });
  const metadataPlaintext = canonicalBytes({
    originalName: String(originalName || "file").slice(0, 1024),
    mimeType: String(mimeType || "application/octet-stream").slice(0, 255),
  });
  const metadataCiphertext = await webcrypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: ownedArrayBuffer(metadataNonce),
      additionalData: ownedArrayBuffer(canonicalBytes({ ...aad, purpose: "file-metadata" })),
      tagLength: 128,
    },
    dataKey,
    ownedArrayBuffer(metadataPlaintext),
  );
  metadataPlaintext.fill(0);
  const chunkCount = Math.max(1, Math.ceil(sourceStat.size / COMPANY_ENCRYPTION_FILE_CHUNK_BYTES));
  const unsignedHeader = {
    suite: COMPANY_ENCRYPTION_SUITE,
    version: 1,
    kind: "chunked-file",
    aad,
    chunkSizeBytes: COMPANY_ENCRYPTION_FILE_CHUNK_BYTES,
    chunkCount,
    plaintextSizeBytes: sourceStat.size,
    noncePrefix: encodeBase64Url(noncePrefix),
    wrappedDataKey,
    metadataNonce: encodeBase64Url(metadataNonce),
    metadataCiphertext: encodeBase64Url(metadataCiphertext),
    writerIdentityId: writerDeviceId,
  };
  const signature = signingPrivateKey
    ? await signCompanyEncryptionRecord(signingPrivateKey, buildEncryptedFileHeaderSignatureRecord(unsignedHeader))
    : null;
  const header = { ...unsignedHeader, signature };
  const headerBytes = canonicalBytes(header);
  const headerLength = Buffer.alloc(4);
  headerLength.writeUInt32BE(headerBytes.byteLength, 0);
  const source = await openFile(sourcePath, "r");
  const destination = await openFile(destinationPath, "wx", 0o600);
  const digest = createHash("sha256");
  let outputOffset = 0;

  try {
    outputOffset = await writeAndHash(destination, digest, COMPANY_ENCRYPTED_FILE_MAGIC, outputOffset);
    outputOffset = await writeAndHash(destination, digest, headerLength, outputOffset);
    outputOffset = await writeAndHash(destination, digest, headerBytes, outputOffset);

    for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
      const plaintextLength = Math.max(0, Math.min(
        COMPANY_ENCRYPTION_FILE_CHUNK_BYTES,
        sourceStat.size - chunkIndex * COMPANY_ENCRYPTION_FILE_CHUNK_BYTES,
      ));
      const plaintext = Buffer.alloc(plaintextLength);
      if (plaintextLength > 0) {
        const read = await source.read(
          plaintext,
          0,
          plaintextLength,
          chunkIndex * COMPANY_ENCRYPTION_FILE_CHUNK_BYTES,
        );
        if (read.bytesRead !== plaintextLength) throw new Error("Encrypted source was truncated during reading.");
      }
      try {
        const ciphertext = await webcrypto.subtle.encrypt(
          {
            name: "AES-GCM",
            iv: ownedArrayBuffer(fileChunkNonce(noncePrefix, chunkIndex)),
            additionalData: ownedArrayBuffer(canonicalBytes({ ...aad, chunkIndex })),
            tagLength: 128,
          },
          dataKey,
          ownedArrayBuffer(plaintext),
        );
        outputOffset = await writeAndHash(destination, digest, ciphertext, outputOffset);
      } finally {
        plaintext.fill(0);
      }
    }
    await destination.sync();
    return {
      header,
      ciphertextSha256: digest.digest("hex"),
      ciphertextSizeBytes: outputOffset,
    };
  } finally {
    dataKeyBytes.fill(0);
    await Promise.allSettled([source.close(), destination.close()]);
  }
};

const readExact = async (handle, length, position) => {
  const bytes = Buffer.alloc(length);
  const result = await handle.read(bytes, 0, length, position);
  if (result.bytesRead !== length) throw new Error("Encrypted file is truncated.");
  return bytes;
};

/** Decrypt a TRELIOE1 file in constant memory and verify its exact framing. */
export const decryptFileFromCompanyContainer = async ({
  sourcePath,
  destinationPath,
  scopePrivateKey,
  scopePrivateJwk,
  expectedCiphertextSha256 = null,
}) => {
  const sourceStat = await stat(sourcePath);
  const source = await openFile(sourcePath, "r");
  const destination = await openFile(destinationPath, "wx", 0o600);
  let dataKeyBytes;

  try {
    const prefix = await readExact(source, COMPANY_ENCRYPTED_FILE_MAGIC.byteLength + 4, 0);
    if (!prefix.subarray(0, COMPANY_ENCRYPTED_FILE_MAGIC.byteLength).equals(COMPANY_ENCRYPTED_FILE_MAGIC)) {
      throw new Error("File is not a TRELIOE1 encrypted container.");
    }
    const headerLength = prefix.readUInt32BE(COMPANY_ENCRYPTED_FILE_MAGIC.byteLength);
    if (headerLength < 2 || headerLength > 1024 * 1024) throw new Error("Encrypted file header is invalid.");
    const payloadOffset = COMPANY_ENCRYPTED_FILE_MAGIC.byteLength + 4 + headerLength;
    if (payloadOffset > sourceStat.size) throw new Error("Encrypted file header is truncated.");
    const header = JSON.parse(textDecoder.decode(await readExact(
      source,
      headerLength,
      COMPANY_ENCRYPTED_FILE_MAGIC.byteLength + 4,
    )));
    if (
      header?.suite !== COMPANY_ENCRYPTION_SUITE
      || header?.version !== 1
      || header?.kind !== "chunked-file"
      || header.chunkSizeBytes !== COMPANY_ENCRYPTION_FILE_CHUNK_BYTES
      || !Number.isSafeInteger(header.chunkCount)
      || header.chunkCount <= 0
      || !Number.isSafeInteger(header.plaintextSizeBytes)
      || header.plaintextSizeBytes < 0
    ) {
      throw new Error("Encrypted file format is unsupported.");
    }
    const aad = buildCompanyEncryptionAad(header.aad);
    dataKeyBytes = await hpkeOpen({
      recipientPrivateKey: scopePrivateKey,
      recipientPrivateJwk: scopePrivateJwk,
      envelope: header.wrappedDataKey,
      aad: { ...aad, purpose: "file-data-key" },
    });
    if (dataKeyBytes.byteLength !== 32) throw new Error("Encrypted file data key is invalid.");
    const dataKey = await webcrypto.subtle.importKey(
      "raw",
      ownedArrayBuffer(dataKeyBytes),
      { name: "AES-GCM", length: 256 },
      false,
      ["decrypt"],
    );
    const metadataPlaintext = Buffer.from(await webcrypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: ownedArrayBuffer(decodeBase64Url(header.metadataNonce, "metadata nonce")),
        additionalData: ownedArrayBuffer(canonicalBytes({ ...aad, purpose: "file-metadata" })),
        tagLength: 128,
      },
      dataKey,
      ownedArrayBuffer(decodeBase64Url(header.metadataCiphertext, "metadata ciphertext")),
    ));
    let metadata;
    try {
      metadata = JSON.parse(textDecoder.decode(metadataPlaintext));
    } finally {
      metadataPlaintext.fill(0);
    }
    let encryptedOffset = payloadOffset;
    let outputOffset = 0;

    for (let chunkIndex = 0; chunkIndex < header.chunkCount; chunkIndex += 1) {
      const plaintextLength = Math.max(0, Math.min(
        header.chunkSizeBytes,
        header.plaintextSizeBytes - chunkIndex * header.chunkSizeBytes,
      ));
      const ciphertextLength = plaintextLength + 16;
      const ciphertext = await readExact(source, ciphertextLength, encryptedOffset);
      const plaintext = Buffer.from(await webcrypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: ownedArrayBuffer(fileChunkNonce(decodeBase64Url(header.noncePrefix), chunkIndex)),
          additionalData: ownedArrayBuffer(canonicalBytes({ ...aad, chunkIndex })),
          tagLength: 128,
        },
        dataKey,
        ownedArrayBuffer(ciphertext),
      ));
      try {
        await destination.write(plaintext, 0, plaintext.byteLength, outputOffset);
        outputOffset += plaintext.byteLength;
      } finally {
        plaintext.fill(0);
      }
      encryptedOffset += ciphertextLength;
    }

    if (encryptedOffset !== sourceStat.size || outputOffset !== header.plaintextSizeBytes) {
      throw new Error("Encrypted file has trailing or missing bytes.");
    }
    await destination.sync();

    if (expectedCiphertextSha256) {
      const digest = createHash("sha256");
      let offset = 0;
      while (offset < sourceStat.size) {
        const length = Math.min(COMPANY_ENCRYPTION_FILE_CHUNK_BYTES, sourceStat.size - offset);
        const bytes = await readExact(source, length, offset);
        digest.update(bytes);
        offset += length;
      }
      if (digest.digest("hex") !== expectedCiphertextSha256) {
        throw new Error("Encrypted file digest does not match the signed revision metadata.");
      }
    }

    return {
      header,
      originalName: String(metadata.originalName || "file"),
      mimeType: String(metadata.mimeType || "application/octet-stream"),
      plaintextSizeBytes: outputOffset,
    };
  } finally {
    dataKeyBytes?.fill(0);
    await Promise.allSettled([source.close(), destination.close()]);
  }
};

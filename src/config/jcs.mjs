/**
 * Strict JSON parsing and RFC 8785 (JCS) canonical serialization.
 *
 * The coordination contract in the v1.1 architecture is content-addressed:
 * manifest, capability profile, inventory and release-descriptor digests must be
 * reproducible byte-for-byte and must not be defeated by duplicate keys,
 * whitespace, key order or non-finite numbers. `JSON.parse` is not sufficient
 * because it silently keeps the last duplicate key, so this module ships a small
 * JSON parser that rejects duplicate keys, lone surrogates, invalid UTF-8 and
 * trailing content, plus a canonicalizer used for every digest in the release
 * protocol.
 *
 * No I/O happens here: callers pass text or bytes.
 *
 * @module config/jcs
 */
import { createHash } from 'node:crypto';

/** Machine-readable codes for strict-parse failures. */
export const STRICT_JSON_CODE = Object.freeze({
  INVALID: 'STRICT_JSON_INVALID',
  DUPLICATE_KEY: 'STRICT_JSON_DUPLICATE_KEY',
  OVERSIZE: 'STRICT_JSON_OVERSIZE',
  INVALID_UTF8: 'STRICT_JSON_INVALID_UTF8',
  NON_CANONICAL: 'STRICT_JSON_NOT_CANONICALIZABLE',
});

/** Parsing/canonicalization failure with a stable code and no secret payload. */
export class StrictJsonError extends Error {
  /**
   * @param {string} message
   * @param {{ code?: string, label?: string, offset?: number }} [options]
   */
  constructor(message, options = {}) {
    super(message);
    this.name = 'StrictJsonError';
    this.code = options.code ?? STRICT_JSON_CODE.INVALID;
    this.label = options.label ?? 'json';
    this.offset = options.offset ?? null;
  }
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
export function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Decode bytes as strict UTF-8. `TextDecoder({fatal:true})` rejects malformed
 * sequences, which is what "invalid UTF-8 fails" means in the contract.
 *
 * @param {Buffer | Uint8Array} bytes
 * @param {string} label
 * @returns {string}
 */
export function decodeUtf8Strict(bytes, label = 'json') {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new StrictJsonError(`${label}: input is not valid UTF-8`, {
      code: STRICT_JSON_CODE.INVALID_UTF8,
      label,
    });
  }
}

/**
 * Parse JSON bytes with a size ceiling applied *before* parsing, then parse the
 * decoded text strictly.
 *
 * @param {Buffer | Uint8Array} bytes
 * @param {{ label?: string, maxBytes?: number, maxDepth?: number }} [options]
 * @returns {unknown}
 */
export function parseStrictJsonBytes(bytes, options = {}) {
  const label = options.label ?? 'json';
  const maxBytes = options.maxBytes ?? 1024 * 1024;
  if (!(bytes instanceof Uint8Array)) {
    throw new StrictJsonError(`${label}: expected bytes`, { label });
  }
  if (bytes.byteLength > maxBytes) {
    throw new StrictJsonError(`${label}: ${bytes.byteLength} bytes exceeds the ${maxBytes}-byte limit`, {
      code: STRICT_JSON_CODE.OVERSIZE,
      label,
    });
  }
  return parseStrictJson(decodeUtf8Strict(bytes, label), options);
}

/**
 * Parse JSON text strictly.
 *
 * @param {string} text
 * @param {{ label?: string, maxBytes?: number, maxDepth?: number }} [options]
 * @returns {unknown}
 */
export function parseStrictJson(text, options = {}) {
  const label = options.label ?? 'json';
  const maxDepth = options.maxDepth ?? 64;
  if (typeof text !== 'string') {
    throw new StrictJsonError(`${label}: expected a string`, { label });
  }
  if (options.maxBytes !== undefined && Buffer.byteLength(text, 'utf8') > options.maxBytes) {
    throw new StrictJsonError(`${label}: input exceeds the ${options.maxBytes}-byte limit`, {
      code: STRICT_JSON_CODE.OVERSIZE,
      label,
    });
  }
  if (text.charCodeAt(0) === 0xfeff) {
    throw new StrictJsonError(`${label}: a byte-order mark is not valid JSON`, { label });
  }
  return new StrictJsonParser(text, label, maxDepth).parse();
}

class StrictJsonParser {
  /**
   * @param {string} text
   * @param {string} label
   * @param {number} maxDepth
   */
  constructor(text, label, maxDepth) {
    this.text = text;
    this.label = label;
    this.maxDepth = maxDepth;
    this.index = 0;
    this.depth = 0;
  }

  /** @param {string} message @param {string} [code] */
  fail(message, code = STRICT_JSON_CODE.INVALID) {
    throw new StrictJsonError(`${this.label}: ${message} at offset ${this.index}`, {
      code,
      label: this.label,
      offset: this.index,
    });
  }

  parse() {
    this.skipWhitespace();
    const value = this.parseValue();
    this.skipWhitespace();
    if (this.index !== this.text.length) this.fail('unexpected trailing content');
    return value;
  }

  skipWhitespace() {
    while (this.index < this.text.length) {
      const ch = this.text[this.index];
      if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') this.index += 1;
      else break;
    }
  }

  /** @returns {unknown} */
  parseValue() {
    if (this.depth > this.maxDepth) this.fail(`nesting deeper than ${this.maxDepth} levels`);
    const ch = this.text[this.index];
    if (ch === '{') return this.parseObject();
    if (ch === '[') return this.parseArray();
    if (ch === '"') return this.parseString();
    if (ch === 't') return this.parseLiteral('true', true);
    if (ch === 'f') return this.parseLiteral('false', false);
    if (ch === 'n') return this.parseLiteral('null', null);
    if (ch === '-' || (ch >= '0' && ch <= '9')) return this.parseNumber();
    this.fail(ch === undefined ? 'unexpected end of input' : `unexpected character ${JSON.stringify(ch)}`);
    return null;
  }

  /** @returns {boolean | null} */
  parseLiteral(word, value) {
    if (this.text.slice(this.index, this.index + word.length) !== word) this.fail(`invalid literal`);
    this.index += word.length;
    return value;
  }

  /** @returns {number} */
  parseNumber() {
    const start = this.index;
    if (this.text[this.index] === '-') this.index += 1;
    if (this.text[this.index] === '0') {
      this.index += 1;
    } else if (this.text[this.index] >= '1' && this.text[this.index] <= '9') {
      this.index += 1;
      while (isDigit(this.text[this.index])) this.index += 1;
    } else {
      this.fail('invalid number');
    }
    if (this.text[this.index] === '.') {
      this.index += 1;
      if (!isDigit(this.text[this.index])) this.fail('invalid number fraction');
      while (isDigit(this.text[this.index])) this.index += 1;
    }
    if (this.text[this.index] === 'e' || this.text[this.index] === 'E') {
      this.index += 1;
      if (this.text[this.index] === '+' || this.text[this.index] === '-') this.index += 1;
      if (!isDigit(this.text[this.index])) this.fail('invalid number exponent');
      while (isDigit(this.text[this.index])) this.index += 1;
    }
    const raw = this.text.slice(start, this.index);
    const value = Number(raw);
    if (!Number.isFinite(value)) this.fail('number is not finite');
    return value;
  }

  /** @returns {string} */
  parseString() {
    if (this.text[this.index] !== '"') this.fail('expected a string');
    this.index += 1;
    let out = '';
    for (;;) {
      if (this.index >= this.text.length) this.fail('unterminated string');
      const ch = this.text[this.index];
      if (ch === '"') {
        this.index += 1;
        return out;
      }
      if (ch === '\\') {
        this.index += 1;
        const esc = this.text[this.index];
        if (esc === undefined) this.fail('unterminated escape');
        if (esc === '"' || esc === '\\' || esc === '/') {
          out += esc;
          this.index += 1;
        } else if (esc === 'b') {
          out += '\b';
          this.index += 1;
        } else if (esc === 'f') {
          out += '\f';
          this.index += 1;
        } else if (esc === 'n') {
          out += '\n';
          this.index += 1;
        } else if (esc === 'r') {
          out += '\r';
          this.index += 1;
        } else if (esc === 't') {
          out += '\t';
          this.index += 1;
        } else if (esc === 'u') {
          const hex = this.text.slice(this.index + 1, this.index + 5);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) this.fail('invalid unicode escape');
          const unit = Number.parseInt(hex, 16);
          this.index += 5;
          if (unit >= 0xd800 && unit <= 0xdbff) {
            // High surrogate: a low surrogate must follow immediately.
            if (this.text[this.index] !== '\\' || this.text[this.index + 1] !== 'u') {
              this.fail('lone high surrogate is not valid UTF-8');
            }
            const lowHex = this.text.slice(this.index + 2, this.index + 6);
            if (!/^[0-9a-fA-F]{4}$/.test(lowHex)) this.fail('invalid unicode escape');
            const low = Number.parseInt(lowHex, 16);
            if (low < 0xdc00 || low > 0xdfff) this.fail('lone high surrogate is not valid UTF-8');
            this.index += 6;
            out += String.fromCodePoint(0x10000 + ((unit - 0xd800) << 10) + (low - 0xdc00));
          } else if (unit >= 0xdc00 && unit <= 0xdfff) {
            this.fail('lone low surrogate is not valid UTF-8');
          } else {
            out += String.fromCharCode(unit);
          }
        } else {
          this.fail(`invalid escape sequence \\${esc}`);
        }
        continue;
      }
      const code = ch.charCodeAt(0);
      if (code < 0x20) this.fail('unescaped control character in string');
      out += ch;
      this.index += 1;
    }
  }

  /** @returns {unknown[]} */
  parseArray() {
    this.index += 1;
    this.depth += 1;
    const out = [];
    this.skipWhitespace();
    if (this.text[this.index] === ']') {
      this.index += 1;
      this.depth -= 1;
      return out;
    }
    for (;;) {
      this.skipWhitespace();
      out.push(this.parseValue());
      this.skipWhitespace();
      const ch = this.text[this.index];
      if (ch === ',') {
        this.index += 1;
        continue;
      }
      if (ch === ']') {
        this.index += 1;
        this.depth -= 1;
        return out;
      }
      this.fail('expected "," or "]" in array');
    }
  }

  /** @returns {Record<string, unknown>} */
  parseObject() {
    this.index += 1;
    this.depth += 1;
    /** @type {Record<string, unknown>} */
    const out = Object.create(null);
    const seen = new Set();
    this.skipWhitespace();
    if (this.text[this.index] === '}') {
      this.index += 1;
      this.depth -= 1;
      return out;
    }
    for (;;) {
      this.skipWhitespace();
      const key = this.parseString();
      if (seen.has(key)) {
        this.fail(`duplicate key ${JSON.stringify(key)}`, STRICT_JSON_CODE.DUPLICATE_KEY);
      }
      seen.add(key);
      this.skipWhitespace();
      if (this.text[this.index] !== ':') this.fail('expected ":" after object key');
      this.index += 1;
      this.skipWhitespace();
      out[key] = this.parseValue();
      this.skipWhitespace();
      const ch = this.text[this.index];
      if (ch === ',') {
        this.index += 1;
        continue;
      }
      if (ch === '}') {
        this.index += 1;
        this.depth -= 1;
        return out;
      }
      this.fail('expected "," or "}" in object');
    }
  }
}

/** @param {string} ch */
function isDigit(ch) {
  return ch !== undefined && ch >= '0' && ch <= '9';
}

/**
 * Canonicalize a JSON value per RFC 8785 (JCS).
 *
 * Rejects values that have no canonical JSON form: non-finite numbers,
 * undefined, bigint, functions, class instances, lone surrogates and cycles.
 *
 * @param {unknown} value
 * @param {{ label?: string, maxDepth?: number }} [options]
 * @returns {string}
 */
export function canonicalizeJson(value, options = {}) {
  const label = options.label ?? 'value';
  return serializeCanonical(value, label, 0, options.maxDepth ?? 64, new Set());
}

/**
 * @param {unknown} value
 * @param {string} label
 * @param {number} depth
 * @param {number} maxDepth
 * @param {Set<object>} ancestors
 * @returns {string}
 */
function serializeCanonical(value, label, depth, maxDepth, ancestors) {
  if (depth > maxDepth) {
    throw new StrictJsonError(`${label}: nesting deeper than ${maxDepth} levels`, {
      code: STRICT_JSON_CODE.NON_CANONICAL,
      label,
    });
  }
  if (value === null) return 'null';
  const type = typeof value;
  if (type === 'boolean') return value ? 'true' : 'false';
  if (type === 'number') {
    const n = /** @type {number} */ (value);
    if (!Number.isFinite(n)) {
      throw new StrictJsonError(`${label}: non-finite numbers have no canonical form`, {
        code: STRICT_JSON_CODE.NON_CANONICAL,
        label,
      });
    }
    if (Object.is(n, -0)) return '0';
    return JSON.stringify(n);
  }
  if (type === 'string') return serializeCanonicalString(/** @type {string} */ (value), label);
  if (Array.isArray(value)) {
    if (ancestors.has(value)) {
      throw new StrictJsonError(`${label}: circular reference`, { code: STRICT_JSON_CODE.NON_CANONICAL, label });
    }
    ancestors.add(value);
    const items = value.map((item, index) => serializeCanonical(item, `${label}[${index}]`, depth + 1, maxDepth, ancestors));
    ancestors.delete(value);
    return `[${items.join(',')}]`;
  }
  if (type === 'object') {
    if (!isPlainObject(value)) {
      throw new StrictJsonError(`${label}: only plain objects are canonicalizable`, {
        code: STRICT_JSON_CODE.NON_CANONICAL,
        label,
      });
    }
    const record = /** @type {Record<string, unknown>} */ (value);
    if (ancestors.has(record)) {
      throw new StrictJsonError(`${label}: circular reference`, { code: STRICT_JSON_CODE.NON_CANONICAL, label });
    }
    ancestors.add(record);
    const keys = Object.keys(record).sort();
    const members = keys.map((key) => {
      const serializedKey = serializeCanonicalString(key, label);
      if (record[key] === undefined) {
        throw new StrictJsonError(`${label}.${key}: undefined has no canonical form`, {
          code: STRICT_JSON_CODE.NON_CANONICAL,
          label,
        });
      }
      return `${serializedKey}:${serializeCanonical(record[key], `${label}.${key}`, depth + 1, maxDepth, ancestors)}`;
    });
    ancestors.delete(record);
    return `{${members.join(',')}}`;
  }
  throw new StrictJsonError(`${label}: ${type} has no canonical JSON form`, {
    code: STRICT_JSON_CODE.NON_CANONICAL,
    label,
  });
}

/**
 * JCS string escaping: quote, backslash and the five short escapes, everything
 * else below U+0020 as lowercase `\u00xx`; non-ASCII stays raw UTF-8.
 *
 * @param {string} value
 * @param {string} label
 * @returns {string}
 */
function serializeCanonicalString(value, label) {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new StrictJsonError(`${label}: lone surrogate is not valid UTF-8`, {
          code: STRICT_JSON_CODE.NON_CANONICAL,
          label,
        });
      }
      i += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new StrictJsonError(`${label}: lone surrogate is not valid UTF-8`, {
        code: STRICT_JSON_CODE.NON_CANONICAL,
        label,
      });
    }
  }
  let out = '"';
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    const code = value.charCodeAt(i);
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (code === 0x08) out += '\\b';
    else if (code === 0x09) out += '\\t';
    else if (code === 0x0a) out += '\\n';
    else if (code === 0x0c) out += '\\f';
    else if (code === 0x0d) out += '\\r';
    else if (code < 0x20) out += `\\u${code.toString(16).padStart(4, '0')}`;
    else out += ch;
  }
  return `${out}"`;
}

/**
 * @param {string | Buffer | Uint8Array} input
 * @returns {string} lowercase 64-character hex
 */
export function sha256Hex(input) {
  return createHash('sha256').update(input).digest('hex');
}

/**
 * Digest of a value's canonical JCS bytes.
 *
 * @param {unknown} value
 * @param {{ label?: string }} [options]
 * @returns {string}
 */
export function digestJson(value, options = {}) {
  return sha256Hex(canonicalizeJson(value, options));
}

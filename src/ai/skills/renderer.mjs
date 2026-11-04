/**
 * Declarative prompt rendering (architecture v1.1 §4.3).
 *
 * Rendering is deliberately boring: the verified `instructions.md` is the whole
 * system message, and the user message is a concatenation of
 * `label + "\n" + JSON.stringify(value)` blocks resolved through literal RFC6901
 * pointers. There is no template language, no interpolation inside Markdown, no
 * conditional, no expression and no evaluation, so untrusted data can never
 * become an instruction.
 *
 * A pointer that is missing from schema-valid input is an authoring fault in the
 * package layout, which is structural (`SKILL_RENDER_INVALID`).
 *
 * @module ai/skills/renderer
 */
import { structuralError } from '../../errors/skill-error.mjs';

/**
 * Resolve one RFC6901 pointer against a validated input value.
 *
 * @param {unknown} root
 * @param {string} pointer
 * @returns {{ found: boolean, value?: unknown }}
 */
export function resolveJsonPointer(root, pointer) {
  if (pointer === '') return { found: true, value: root };
  if (typeof pointer !== 'string' || !pointer.startsWith('/')) return { found: false };
  let current = root;
  for (const rawSegment of pointer.slice(1).split('/')) {
    const segment = rawSegment.replace(/~1/g, '/').replace(/~0/g, '~');
    if (Array.isArray(current)) {
      if (!/^(0|[1-9][0-9]*)$/.test(segment)) return { found: false };
      const index = Number(segment);
      if (index >= current.length) return { found: false };
      current = current[index];
      continue;
    }
    if (current === null || typeof current !== 'object') return { found: false };
    if (!Object.prototype.hasOwnProperty.call(current, segment)) return { found: false };
    current = /** @type {Record<string, unknown>} */ (current)[segment];
  }
  return { found: true, value: current };
}

/**
 * Render the two model messages for one validated input.
 *
 * @param {{
 *   instructions: string,
 *   layout: Readonly<{ schemaVersion: 1, userParts: ReadonlyArray<{ label: string, valuePointer: string }> }>,
 *   input: unknown,
 * }} request
 * @returns {Readonly<{ system: string, user: string }>}
 */
export function renderSkillMessages(request) {
  const parts = request.layout.userParts.map((part) => {
    const resolved = resolveJsonPointer(request.input, part.valuePointer);
    if (!resolved.found) {
      throw structuralError(
        'SKILL_RENDER_INVALID',
        `prompt-layout pointer ${JSON.stringify(part.valuePointer)} is missing from a schema-valid input`,
        { field: 'prompt-layout.json' },
      );
    }
    let serialized;
    try {
      serialized = JSON.stringify(resolved.value);
    } catch {
      throw structuralError('SKILL_RENDER_INVALID', 'a layout value is not JSON-serializable', { field: 'prompt-layout.json' });
    }
    if (serialized === undefined) {
      throw structuralError('SKILL_RENDER_INVALID', 'a layout value is undefined', { field: 'prompt-layout.json' });
    }
    return `${part.label}\n${serialized}`;
  });
  return Object.freeze({
    system: request.instructions,
    user: parts.join('\n\n'),
  });
}

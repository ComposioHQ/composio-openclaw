import { schemaType, type JsonSchema } from "../../views/config-form.shared.ts";

/**
 * Walk a form value tree alongside its JSON Schema and coerce string values
 * to their schema-defined types (number, boolean).
 *
 * HTML `<input>` elements always produce string `.value` properties.  Even
 * though the form rendering code converts values correctly for most paths,
 * some interactions (map-field repopulation, re-renders, paste, etc.) can
 * leak raw strings into the config form state.  This utility acts as a
 * safety net before serialization so that `config.set` always receives
 * correctly typed JSON.
 */
export function coerceFormValues(value: unknown, schema: JsonSchema): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  const type = schemaType(schema);

  // Handle anyOf/oneOf — try to match the value against a variant
  if (schema.anyOf || schema.oneOf) {
    const variants = (schema.anyOf ?? schema.oneOf ?? []).filter(
      (v) => !(v.type === "null" || (Array.isArray(v.type) && v.type.includes("null"))),
    );

    if (variants.length === 1) {
      return coerceFormValues(value, variants[0]);
    }

    // Try number/boolean coercion for string values
    if (typeof value === "string") {
      for (const variant of variants) {
        const variantType = schemaType(variant);
        if (variantType === "number" || variantType === "integer") {
          const trimmed = value.trim();
          if (trimmed === "") {
            return undefined;
          }
          const parsed = Number(trimmed);
          if (!Number.isNaN(parsed)) {
            if (variantType === "integer" && !Number.isInteger(parsed)) {
              continue;
            }
            return parsed;
          }
        }
        if (variantType === "boolean") {
          if (value === "true") {
            return true;
          }
          if (value === "false") {
            return false;
          }
        }
      }
    }

    // For non-string values (objects, arrays), try to recurse into matching variant
    for (const variant of variants) {
      const variantType = schemaType(variant);
      if (variantType === "object" && typeof value === "object" && !Array.isArray(value)) {
        return coerceFormValues(value, variant);
      }
      if (variantType === "array" && Array.isArray(value)) {
        return coerceFormValues(value, variant);
      }
    }

    return value;
  }

  if (type === "number" || type === "integer") {
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed === "") {
        return undefined;
      }
      const parsed = Number(trimmed);
      if (!Number.isNaN(parsed)) {
        if (type === "integer" && !Number.isInteger(parsed)) {
          return value;
        }
        return parsed;
      }
    }
    return value;
  }

  if (type === "boolean") {
    if (typeof value === "string") {
      if (value === "true") {
        return true;
      }
      if (value === "false") {
        return false;
      }
    }
    return value;
  }

  if (type === "object") {
    if (typeof value !== "object" || Array.isArray(value)) {
      return value;
    }
    const obj = value as Record<string, unknown>;
    const props = schema.properties ?? {};
    const additional =
      schema.additionalProperties && typeof schema.additionalProperties === "object"
        ? schema.additionalProperties
        : null;
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(obj)) {
      const propSchema = props[key] ?? additional;
      const coerced = propSchema ? coerceFormValues(val, propSchema) : val;
      // Omit undefined — "clear field = unset" for optional properties
      if (coerced !== undefined) {
        result[key] = coerced;
      }
    }
    return result;
  }

  if (type === "array") {
    if (!Array.isArray(value)) {
      return value;
    }
    if (Array.isArray(schema.items)) {
      // Tuple form: each index has its own schema
      const tuple = schema.items;
      return value
        .map((item, i) => {
          const s = i < tuple.length ? tuple[i] : undefined;
          return s ? coerceFormValues(item, s) : item;
        })
        .filter((v) => v !== undefined);
    }
    const itemsSchema = schema.items;
    if (!itemsSchema) {
      return value;
    }
    return value.map((item) => coerceFormValues(item, itemsSchema)).filter((v) => v !== undefined);
  }

  return value;
}

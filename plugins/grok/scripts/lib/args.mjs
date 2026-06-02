// Schema-driven argument parser for the Grok companion.
//
// Unlike the previous ad-hoc parser, this knows which flags take a value, so a
// value that happens to start with "--" (or the literal "--" separator inside a
// value) is handled correctly. Everything after a bare "--" is positional.
//
// Usage:
//   parseArgs(argv, {
//     valueOptions: ["model", "base"],   // consume the next token as the value
//     booleanOptions: ["json", "wait"],  // presence-only
//     repeatable: ["file"],              // collect into an array (implies value)
//     aliasMap: { m: "model" },
//   })
//
// Returns { options, positionals }. Repeatable options are always arrays.

export function parseArgs(argv, config = {}) {
  const valueOptions = new Set(config.valueOptions ?? []);
  const booleanOptions = new Set(config.booleanOptions ?? []);
  const repeatable = new Set(config.repeatable ?? []);
  const aliasMap = config.aliasMap ?? {};
  for (const key of repeatable) {
    valueOptions.add(key);
  }

  const options = {};
  const positionals = [];

  const resolveKey = (raw) => aliasMap[raw] ?? raw;
  const assign = (key, value) => {
    if (repeatable.has(key)) {
      (options[key] ??= []).push(value);
    } else {
      options[key] = value;
    }
  };

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];

    if (token === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }

    if (token.startsWith("--") && token.length > 2) {
      const body = token.slice(2);
      const eq = body.indexOf("=");
      if (eq !== -1) {
        assign(resolveKey(body.slice(0, eq)), body.slice(eq + 1));
        continue;
      }
      const key = resolveKey(body);
      if (valueOptions.has(key)) {
        const next = argv[i + 1];
        if (next === undefined) {
          throw new Error(`Flag --${key} expects a value.`);
        }
        assign(key, next);
        i++;
      } else {
        options[key] = true;
      }
      continue;
    }

    if (token.startsWith("-") && token.length > 1 && !/^-\d/.test(token)) {
      const key = resolveKey(token.slice(1));
      if (valueOptions.has(key)) {
        const next = argv[i + 1];
        if (next === undefined) {
          throw new Error(`Flag -${token.slice(1)} expects a value.`);
        }
        assign(key, next);
        i++;
      } else {
        options[key] = true;
      }
      continue;
    }

    positionals.push(token);
  }

  return { options, positionals };
}

// When a slash command forwards "$ARGUMENTS" as a single quoted blob, split it
// into argv-style tokens while respecting quotes and a trailing "-- free text"
// section (which is kept verbatim as one positional token).
export function splitRawArgumentString(raw) {
  if (raw == null) return [];
  const text = String(raw);
  const tokens = [];
  let i = 0;
  const n = text.length;

  while (i < n) {
    while (i < n && /\s/.test(text[i])) i++;
    if (i >= n) break;

    // Everything after a standalone "--" is one verbatim positional blob.
    if (text.startsWith("--", i) && (i + 2 === n || /\s/.test(text[i + 2]))) {
      tokens.push("--");
      const rest = text.slice(i + 2).replace(/^\s+/, "");
      if (rest) tokens.push(rest);
      return tokens;
    }

    let token = "";
    let quote = null;
    let escaped = false;
    while (i < n) {
      const ch = text[i];
      if (escaped) {
        token += ch;
        escaped = false;
        i++;
        continue;
      }
      if (ch === "\\" && quote !== "'") {
        escaped = true;
        i++;
        continue;
      }
      if (quote) {
        if (ch === quote) quote = null;
        else token += ch;
        i++;
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
        i++;
        continue;
      }
      if (/\s/.test(ch)) break;
      token += ch;
      i++;
    }
    tokens.push(token);
  }

  return tokens;
}

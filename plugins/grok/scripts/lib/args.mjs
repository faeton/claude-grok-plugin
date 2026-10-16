// Schema-driven argument parser for the Grok companion.
//
// Unlike the previous ad-hoc parser, this knows which flags take a value, so a
// value that happens to start with "--" (or the literal "--" separator inside a
// value) is handled correctly. Everything after a bare "--" is positional.
//
// Usage:
//   parseArgs(argv, {
//     valueOptions: ["model", "base"],   // consume the next token as the value
//     booleanOptions: ["json", "wait"],  // presence-only; --x=true / --x=false
//     repeatable: ["file"],              // collect into an array (implies value)
//     aliasMap: { m: "model" },
//   })
//
// Returns { options, positionals }. Repeatable options are always arrays.
//
// Strict on purpose. An unknown flag is an error rather than a silent `true`
// (a typo like --scpoe used to be ignored), `--background=false` means false
// rather than the truthy string "false", and a value flag never swallows the
// next flag as its value (`--file --model x` attached a file named --model).
// A value that really starts with "-" can still be passed as --flag=-value.

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
  const takeValue = (flag, key, i) => {
    const next = argv[i + 1];
    if (next === undefined || (next.startsWith("-") && next.length > 1 && !/^-\d/.test(next))) {
      throw new Error(`Flag ${flag} expects a value.`);
    }
    assign(key, next);
  };

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];

    if (token === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }

    const long = token.startsWith("--") && token.length > 2;
    const short = !long && token.startsWith("-") && token.length > 1 && !/^-\d/.test(token);
    if (!long && !short) {
      positionals.push(token);
      continue;
    }

    const body = token.slice(long ? 2 : 1);
    const eq = long ? body.indexOf("=") : -1;
    const key = resolveKey(eq === -1 ? body : body.slice(0, eq));
    const flag = `${long ? "--" : "-"}${eq === -1 ? body : body.slice(0, eq)}`;

    if (valueOptions.has(key)) {
      if (eq !== -1) assign(key, body.slice(eq + 1));
      else {
        takeValue(flag, key, i);
        i++;
      }
    } else if (booleanOptions.has(key)) {
      if (eq === -1) options[key] = true;
      else {
        const raw = body.slice(eq + 1).toLowerCase();
        if (raw !== "true" && raw !== "false") {
          throw new Error(`Flag ${flag} is a switch; use ${flag}, ${flag}=true or ${flag}=false.`);
        }
        options[key] = raw === "true";
      }
    } else {
      throw new Error(`Unknown flag ${flag}.`);
    }
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

/** Locate syntax failure when V8 omits an offset from its JSON.parse message. @internal */
export function jsonErrorPosition(text: string): number {
  let offset = 0;
  const invalid = new Error('invalid JSON');
  const fail = (): never => {
    throw invalid;
  };
  const space = (): void => {
    while (/[\t\n\r ]/u.test(text[offset] ?? 'x')) offset++;
  };
  const string = (): void => {
    if (text[offset] !== '"') fail();
    offset++;
    while (offset < text.length) {
      const char = text[offset];
      if (char === '"') {
        offset++;
        return;
      }
      if ((char?.charCodeAt(0) ?? 0) < 32) fail();
      if (char === '\\') {
        offset++;
        if (text[offset] === 'u') {
          for (let count = 0; count < 4; count++) {
            offset++;
            if (!/[\da-f]/iu.test(text[offset] ?? 'x')) fail();
          }
        } else if (!'"\\/bfnrt'.includes(text[offset] ?? 'x')) fail();
      }
      offset++;
    }
    fail();
  };
  const value = (): void => {
    space();
    const char = text[offset];
    if (char === '"') {
      string();
      return;
    }
    if (char === '{' || char === '[') {
      const object = char === '{',
        end = object ? '}' : ']';
      offset++;
      space();
      if (text[offset] === end) {
        offset++;
        return;
      }
      for (;;) {
        if (object) {
          string();
          space();
          if (text[offset] !== ':') fail();
          offset++;
        }
        value();
        space();
        if (text[offset] === end) {
          offset++;
          return;
        }
        if (text[offset] !== ',') fail();
        offset++;
        space();
      }
    }
    const literal = char === 't' ? 'true' : char === 'f' ? 'false' : char === 'n' ? 'null' : null;
    if (literal) {
      for (const expected of literal) {
        if (text[offset] !== expected) fail();
        offset++;
      }
      return;
    }
    const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u.exec(text.slice(offset));
    if (!number) return fail();
    offset += number[0].length;
  };
  try {
    value();
    space();
  } catch (error) {
    if (error !== invalid && !(error instanceof RangeError)) throw error;
  }
  return Math.min(offset, text.length);
}

// C0, DEL/C1, line/paragraph separators, and the finite bidi-control set.
const displayControls = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/gu;

function unicodeEscape(character: string): string {
  return `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`;
}

export function escapeTextDisplay(value: string): string {
  return value.replace(displayControls, unicodeEscape);
}

export function escapeSerializedJson(serialized: string): string {
  // JSON.stringify already escapes C0 within values. Leave its formatting alone;
  // extra legal JSON escapes preserve the original values after JSON.parse.
  return serialized.replace(displayControls, (character) =>
    character.charCodeAt(0) < 0x20 ? character : unicodeEscape(character)
  );
}

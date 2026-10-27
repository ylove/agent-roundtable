// Terminal text keeps visible Unicode and removes formatting controls.
export const clean = (text: string): string => text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u061c\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/g, "");

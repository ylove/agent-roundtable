export interface SecretRef { backend: string; locator: string }

const SHAPE = "Expected secret://env/NAME, secret://keychain/service[/account] or secret://op/vault/item/field.";
const SEGMENT = /^[A-Za-z0-9_~.-]{1,128}$/;

/** Parse without URL normalization: escapes, traversal and empty segments are refused. */
export function parseSecretRef(value: unknown): SecretRef {
  if (typeof value !== "string" || !value.startsWith("secret://")) throw new Error(SHAPE);
  const [backend, ...parts] = value.slice(9).split("/");
  if (!parts.every(p => SEGMENT.test(p) && !p.includes(".."))) throw new Error(SHAPE);
  if (backend === "env" ? parts.length !== 1 || !/^[A-Z_][A-Z0-9_]{0,127}$/.test(parts[0])
    : backend === "keychain" ? parts.length < 1 || parts.length > 2
    : backend === "op" ? parts.length !== 3 : true) throw new Error(SHAPE);
  return { backend, locator: parts.join("/") };
}

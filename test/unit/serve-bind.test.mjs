import { test } from "node:test";
import assert from "node:assert/strict";
import { isTailnetAddress, validateBindAddress, selectBind, hostMatches } from "../../dist/http/bind.js";
import { SecureServer } from "../../dist/http/secure-server.js";

const interfaces = { ts0: [{ address: "100.67.2.3" }, { address: "fd7a:115c:a1e0::1234" }] };
test("serve tailnet address ranges have strict IPv4 and IPv6 boundaries", () => {
  for (const address of ["100.64.0.0", "100.127.255.255", "100.67.2.3", "fd7a:115c:a1e0::1", "FD7A:115C:A1E0:0:0:0:0:1"]) assert.equal(isTailnetAddress(address), true, address);
  for (const address of ["100.63.255.255", "100.128.0.0", "127.0.0.1", "0.0.0.0", "::", "::1", "fd7a:115c:a1e1::1", "fd7a:115c:a1e0", "::ffff:100.64.1.1", "100.64.1.1%lo", "fd7a:115c:a1e0::1%en0", "bad"]) assert.equal(isTailnetAddress(address), false, address);
});

test("serve bind refuses public, wildcard and unassigned tailnet addresses", () => {
  assert.equal(selectBind("loopback", {}), "127.0.0.1");
  assert.equal(selectBind("tailnet", interfaces), "100.67.2.3");
  assert.equal(validateBindAddress("fd7a:115c:a1e0:0:0:0:0:1234", interfaces), "fd7a:115c:a1e0::1234");
  assert.throws(() => selectBind("tailnet", {}), /No tailnet address/);
  for (const value of ["0.0.0.0", "::", "8.8.8.8", "100.64.0.1"]) assert.throws(() => validateBindAddress(value, interfaces), /Bind must/);
  for (const value of ["0.0.0.0", "::", "100.67.2.3", "public"]) assert.throws(() => selectBind(value, interfaces), /loopback or --bind tailnet/);
  assert.throws(() => SecureServer.start({ name: "bad", routes: [], bindAddress: "0.0.0.0" }), /Bind must/);
});

test("serve Host check accepts exactly the bound address and port", () => {
  assert.equal(hostMatches("100.67.2.3:1234", "100.67.2.3", 1234), true);
  for (const host of ["localhost:1234", "127.0.0.1:1234", "100.67.2.3", "100.67.2.3:5678", "100.67.2.3.evil:1234", "100.67.2.3:1234 ", undefined]) assert.equal(hostMatches(host, "100.67.2.3", 1234), false, host);
  assert.equal(hostMatches("[fd7a:115c:a1e0::1]:1234", "fd7a:115c:a1e0::1", 1234), true);
  assert.equal(hostMatches("fd7a:115c:a1e0::1:1234", "fd7a:115c:a1e0::1", 1234), false);
});

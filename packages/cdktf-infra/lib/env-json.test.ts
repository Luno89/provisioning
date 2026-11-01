import { describe, expect, it } from "vitest";
import { bindingsFrom, jsonFrom, renderedAppFrom, settingsFrom } from "./env-json.js";

const rendered = {
  namespace: { metadata: { name: "mongo-1" } },
  pvcs: [{ metadata: { name: "mongo-data-pvc", namespace: "mongo-1" }, spec: { accessModes: ["ReadWriteOnce"] }, waitUntilBound: false }],
  deployment: { metadata: { name: "mongo" }, spec: { template: { metadata: {}, spec: { container: [{ name: "mongo", image: "mongo:7" }] } } } },
  service: { metadata: { name: "mongo" }, spec: { port: [{ port: 27017 }] } },
  health: { port: 27017, path: "/" },
};

describe("what the backend hands the synth as JSON", () => {
  it("says which variable is not JSON", () => {
    expect(() => jsonFrom("APP_SPEC_JSON", "{ nope")).toThrow(/^APP_SPEC_JSON is not valid JSON: /);
  });

  it("takes settings only as text", () => {
    expect(settingsFrom("APP_SETTINGS_JSON", { maxPlayers: "8" })).toEqual({ maxPlayers: "8" });
    expect(() => settingsFrom("APP_SETTINGS_JSON", { maxPlayers: 8 })).toThrow("APP_SETTINGS_JSON.maxPlayers is not text");
    expect(() => settingsFrom("APP_SETTINGS_JSON", ["8"])).toThrow("APP_SETTINGS_JSON is not an object");
  });

  it("reads service bindings as the backend projects them, and names a part that is missing", () => {
    const projected = {
      volumes: [{ name: "binding-db", secret: { secretName: "binding-db" } }],
      volumeMounts: [{ name: "binding-db", mountPath: "/bindings/db", readOnly: true }],
      env: [{ name: "SERVICE_BINDING_ROOT", value: "/bindings" }],
    };
    expect(bindingsFrom(projected)).toEqual(projected);
    expect(() => bindingsFrom({ ...projected, volumes: [{ name: "binding-db" }] })).toThrow("BINDINGS_JSON.volumes[0].secret is not an object");
  });

  it("takes a rendered app whole, and refuses one without what the construct reads", () => {
    expect(renderedAppFrom(rendered)).toBe(rendered);
    expect(() => renderedAppFrom({ ...rendered, service: { metadata: {} } })).toThrow("APP_SPEC_JSON.service.metadata.name is not text");
    expect(() => renderedAppFrom({ ...rendered, deployment: { metadata: {}, spec: {} } })).toThrow("APP_SPEC_JSON.deployment.spec.template is not an object");
    expect(() => renderedAppFrom({ ...rendered, health: { port: "27017", path: "/" } })).toThrow("APP_SPEC_JSON.health.port is not a number");
  });
});

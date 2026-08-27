// @meshtastic/protobufs@2.7.26 publishes its dist without the `mod.d.ts` its own
// package.json points "types" at (only the hashed `mod-toAbfzRb.d.ts` ships).
// This shim re-exports the real declarations under the package's public name so
// `import { Protobuf } from "@meshtastic/core"` type-checks. If a future version
// of @meshtastic/protobufs fixes this, this file can be deleted.
declare module "@meshtastic/protobufs" {
  export * from "@meshtastic/protobufs/dist/mod-toAbfzRb";
}

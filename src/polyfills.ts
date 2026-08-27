// @meshtastic/core bundles tslog's Node.js runtime variant, which reaches for
// Node globals that don't exist in the browser (`process`, `Buffer`) every
// time it logs something — including during the connect/configure handshake,
// so an unhandled ReferenceError here silently aborts the connection.
// This must be the very first import in main.tsx so it runs before any
// module that transitively imports @meshtastic/core.
const globalWithNodeShims = globalThis as unknown as {
  process?: unknown;
  Buffer?: unknown;
};

if (typeof globalWithNodeShims.process === "undefined") {
  globalWithNodeShims.process = { env: {}, version: "", cwd: () => "/" };
}

if (typeof globalWithNodeShims.Buffer === "undefined") {
  // Only tslog's `isBuffer` check is hit in the browser bundle — nothing here
  // is ever a real Node Buffer, so reporting false is correct, not a stub of
  // missing behaviour.
  globalWithNodeShims.Buffer = { isBuffer: () => false };
}

// @meshtastic/transport-web-bluetooth has two problems with how it talks to
// GATT characteristics that show up as "NotSupportedError: GATT operation
// failed for unknown reason" once packets start flowing:
//
// 1. It writes to ToRadio with the deprecated, generic `writeValue()`.
//    Meshtastic's ToRadio characteristic is write-without-response only, and
//    on several browser/OS combinations (notably Chrome on macOS) the legacy
//    writeValue() doesn't fall back to that write type on its own.
//
// 2. It reads FromRadio in a loop (both after every write and on every
//    BLE notification) with zero coordination against outstanding writes to
//    ToRadio. macOS's CoreBluetooth (which Chrome's Web Bluetooth sits on
//    top of) only allows one GATT operation in flight per device at a time —
//    an overlapping read and write on two different characteristics of the
//    same connection is exactly the other common trigger for this same
//    "unknown reason" error.
//
// Fix both by (a) picking the write type the characteristic actually
// advertises, and (b) funnelling every read/write on every characteristic
// through one global queue so operations never overlap, regardless of which
// characteristic or method is used. The app only ever talks to one connected
// device at a time, so a single global queue (rather than one per device) is
// simplest and sufficient.
const characteristicCtor = (
  globalThis as unknown as { BluetoothRemoteGATTCharacteristic?: { prototype: BluetoothRemoteGATTCharacteristic } }
).BluetoothRemoteGATTCharacteristic;
if (characteristicCtor) {
  const proto = characteristicCtor.prototype;

  let gattQueue: Promise<unknown> = Promise.resolve();
  function runSerialized<T>(run: () => Promise<T>): Promise<T> {
    const result = gattQueue.then(run, run);
    gattQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  const originalReadValue = proto.readValue;
  const originalWriteValue = proto.writeValue;
  const originalWriteWithResponse = proto.writeValueWithResponse;
  const originalWriteWithoutResponse = proto.writeValueWithoutResponse;

  proto.readValue = function (this: BluetoothRemoteGATTCharacteristic) {
    return runSerialized(() => originalReadValue.call(this));
  };

  if (originalWriteWithResponse) {
    proto.writeValueWithResponse = function (this: BluetoothRemoteGATTCharacteristic, value: BufferSource) {
      return runSerialized(() => originalWriteWithResponse.call(this, value));
    };
  }
  if (originalWriteWithoutResponse) {
    proto.writeValueWithoutResponse = function (this: BluetoothRemoteGATTCharacteristic, value: BufferSource) {
      return runSerialized(() => originalWriteWithoutResponse.call(this, value));
    };
  }

  proto.writeValue = function (this: BluetoothRemoteGATTCharacteristic, value: BufferSource) {
    return runSerialized(() => {
      if (this.properties?.writeWithoutResponse && !this.properties?.write && originalWriteWithoutResponse) {
        return originalWriteWithoutResponse.call(this, value);
      }
      return originalWriteValue.call(this, value);
    });
  };
}

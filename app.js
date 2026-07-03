// WebShutter — read Canon EOS shutter count over WebUSB.
//
// Re-implements the libgphoto2 `ptp2` "shuttercounter" read (property
// DPC_CANON_EOS_ShutterCounter = 0xD1ac, a UINT32 delivered via a Canon-EOS
// vendor-extended PTP event) using nothing but the browser.
//
// All wire-format offsets/constants come from libgphoto2's camlibs/ptp2
// (ptp.h, ptp.c, ptp-pack.c, config.c). PTP over USB is little-endian.

"use strict";

// --- USB / PTP constants -------------------------------------------------
const CANON_VENDOR_ID = 0x04a9;

const TYPE_CMD  = 0x0001;
const TYPE_DATA = 0x0002;
const TYPE_RESP = 0x0003;

const RC_OK = 0x2001;

// Standard PTP operations
const OP_GetDeviceInfo = 0x1001;
const OP_OpenSession   = 0x1002;
const OP_CloseSession  = 0x1003;

// Canon EOS vendor-extended operations (PTP_VENDOR_CANON = 0x0000000B)
const OP_EOS_SetRemoteMode          = 0x9114;
const OP_EOS_SetEventMode           = 0x9115;
const OP_EOS_GetEvent               = 0x9116;
const OP_EOS_RequestDevicePropValue = 0x9127;

// Canon EOS event codes (delivered in the 0x9116 GetEvent data blob)
const EC_EOS_PropValueChanged = 0xc189;

// Canon EOS device property codes
const DPC_EOS_ShutterCounter = 0xD1ac;

// --- tiny helpers --------------------------------------------------------
function u16le(b, o) { return b[o] | (b[o + 1] << 8); }
function u32le(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }
function concatBytes(arrays) {
  let total = 0;
  for (const a of arrays) total += a.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const a of arrays) { out.set(a, o); o += a.length; }
  return out;
}
function hex(n, w = 4) { return "0x" + n.toString(16).toUpperCase().padStart(w, "0"); }

// --- UI plumbing ---------------------------------------------------------
const $ = (id) => document.getElementById(id);
const elStatus = $("status"), elLog = $("log");
const elResult = $("result"), elModel = $("model"), elSerial = $("serial"), elShutter = $("shutter");

function setStatus(text, cls = "") {
  elStatus.textContent = text;
  elStatus.className = "status" + (cls ? " " + cls : "");
}
function logLine(text, cls = "") {
  const span = document.createElement("span");
  span.className = cls;
  span.textContent = text + "\n";
  elLog.appendChild(span);
  elLog.scrollTop = elLog.scrollHeight;
}
function showResult(model, serial, shutter) {
  elModel.textContent = model ?? "—";
  elSerial.textContent = serial ?? "—";
  elShutter.textContent = shutter != null ? shutter.toLocaleString() : "—";
  elResult.classList.remove("hidden");
}
const ptpErrName = (c) => "0x" + c.toString(16);

// --- WebUSB device state -------------------------------------------------
const state = {
  device: null,
  ifaceNum: null,
  epOut: null,
  epIn: null,
  maxPacket: 512,
  txid: 1,
};

// Find the PTP (USB class 6) interface and its bulk endpoints.
function discoverEndpoints(device) {
  const conf = device.configuration;
  if (!conf) throw new Error("Device has no active configuration.");
  for (const iface of conf.interfaces) {
    for (const alt of iface.alternates) {
      if (alt.interfaceClass !== 6) continue; // 6 = PTP / Still Image
      let epOut = null, epIn = null, pkt = 512;
      for (const ep of alt.endpoints) {
        if (ep.type !== "bulk") continue;
        if (ep.direction === "out") epOut = ep.endpointNumber;
        else if (ep.direction === "in") { epIn = ep.endpointNumber; pkt = ep.packetSize; }
      }
      if (epOut != null && epIn != null) {
        state.ifaceNum = iface.interfaceNumber;
        state.epOut = epOut;
        state.epIn = epIn;
        state.maxPacket = pkt || 512;
        logLine(`PTP interface ${iface.interfaceNumber}: bulk OUT=${epOut} IN=${epIn} (maxPacket=${state.maxPacket})`, "l-dim");
        return;
      }
    }
  }
  throw new Error("No PTP bulk interface found on this device.");
}

// --- PTP container layer -------------------------------------------------

// Pack & send a Command container on the bulk OUT endpoint.
async function sendCommand(code, params = [], txid) {
  const buf = new ArrayBuffer(12 + 4 * params.length);
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);
  dv.setUint32(0, buf.byteLength, true);
  dv.setUint16(4, TYPE_CMD, true);
  dv.setUint16(6, code, true);
  dv.setUint32(8, txid, true);
  for (let i = 0; i < params.length; i++) dv.setUint32(12 + 4 * i, params[i] >>> 0, true);
  const r = await state.device.transferOut(state.epOut, u8);
  if (r.status !== "ok") throw new Error(`transferOut status=${r.status}`);
}

// Read one PTP container (DATA or RESP) from the bulk IN endpoint.
// Accumulates packets until the container's declared length is reached,
// ignoring zero-length packets that appear between data and response phases.
async function readContainer() {
  let bytes = new Uint8Array(0);
  const append = (c) => { bytes = concatBytes([bytes, c]); };
  for (;;) {
    if (bytes.length >= 4) {
      const len = u32le(bytes, 0);
      if (len >= 12 && bytes.length >= len) {
        return parseContainer(bytes.subarray(0, len));
      }
    }
    const res = await state.device.transferIn(state.epIn, Math.max(state.maxPacket, 512));
    const c = new Uint8Array(res.data.buffer, res.data.byteOffset, res.data.byteLength);
    if (c.length === 0) continue; // ZLP between phases
    append(c);
  }
}

function parseContainer(b) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const length = dv.getUint32(0, true);
  const type   = dv.getUint16(4, true);
  const code   = dv.getUint16(6, true);
  const transid = dv.getUint32(8, true);
  const params = [];
  for (let i = 12; i + 4 <= length; i += 4) params.push(dv.getUint32(i, true) >>> 0);
  const payload = (type === TYPE_DATA && length > 12) ? b.subarray(12, length) : null;
  return { length, type, code, transid, params, payload };
}

// Run a full PTP transaction: command [-> data] -> response.
async function ptpTransaction(code, params = [], expectData = false) {
  const txid = state.txid++;
  await sendCommand(code, params, txid);
  let data = null;
  if (expectData) {
    const dc = await readContainer();
    if (dc.type === TYPE_DATA) {
      data = dc.payload;
    } else {
      // No data phase — device answered with a response (usually an error).
      return { code: dc.code, params: dc.params, data: null, ok: dc.code === RC_OK };
    }
  }
  const rc = await readContainer();
  return { code: rc.code, params: rc.params, data, ok: rc.code === RC_OK };
}

// --- PTP dataset parsers -------------------------------------------------

// PTP string: u8 charCount, then charCount * 2 bytes UTF-16LE.
// (libgphoto2 counts the trailing NUL as a char; we trim it.)
function readPTPString(dv, u8, offsetRef) {
  const n = u8[offsetRef.o++];
  if (n === 0) return "";
  const codes = [];
  for (let i = 0; i < n; i++) codes.push(dv.getUint16(offsetRef.o + i * 2, true));
  offsetRef.o += n * 2;
  if (codes[codes.length - 1] === 0) codes.pop(); // drop terminator
  return String.fromCharCode(...codes);
}

// u32 count + count * u16 LE
function readU16Array(dv, u8, offsetRef) {
  const count = dv.getUint32(offsetRef.o, true); offsetRef.o += 4;
  const out = [];
  for (let i = 0; i < count; i++) { out.push(dv.getUint16(offsetRef.o, true)); offsetRef.o += 2; }
  return out;
}

// Parse the standard GetDeviceInfo (0x1001) dataset.
function parseDeviceInfo(payload) {
  const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const u8 = new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength);
  const o = { o: 0 };
  const standardVersion = dv.getUint16(o.o, true); o.o += 2;
  const vendorExtID     = dv.getUint32(o.o, true); o.o += 4;
  const vendorExtVer    = dv.getUint16(o.o, true); o.o += 2;
  const vendorExtDesc   = readPTPString(dv, u8, o);
  const functionalMode  = dv.getUint16(o.o, true); o.o += 2;
  const operations      = readU16Array(dv, u8, o);
  const events          = readU16Array(dv, u8, o);
  const deviceProps     = readU16Array(dv, u8, o);
  const captureFormats  = readU16Array(dv, u8, o);
  const imageFormats    = readU16Array(dv, u8, o);
  const manufacturer    = readPTPString(dv, u8, o);
  const model           = readPTPString(dv, u8, o);
  const deviceVersion   = readPTPString(dv, u8, o);
  const serialNumber    = readPTPString(dv, u8, o);
  return {
    standardVersion, vendorExtID, vendorExtVer, vendorExtDesc, functionalMode,
    operations, events, deviceProps, captureFormats, imageFormats,
    manufacturer, model, deviceVersion, serialNumber,
  };
}

// Parse the EOS GetEvent (0x9116) blob. Returns array of { code, dpc, valueBytes }.
// Layout per record (ptp-pack.c ptp_unpack_EOS_events):
//   u32 size, u32 eventCode, ...event-specific...
// PropValueChanged (0xc189): u32 dpc at +8, value bytes at +0x0c.
function parseEosEvents(blob) {
  const out = [];
  let off = 0;
  while (off + 8 <= blob.length) {
    const size = u32le(blob, off);
    const code = u32le(blob, off + 4);
    if (size < 8) break;
    if (size === 8 && code === 0) break; // terminator
    if (off + size > blob.length) break;
    const rec = { code };
    if (code === EC_EOS_PropValueChanged && size >= 12) {
      rec.dpc = u32le(blob, off + 8);
      rec.valueBytes = blob.subarray(off + 12, off + size);
    }
    out.push(rec);
    off += size;
  }
  return out;
}

// --- the actual shutter-count flow --------------------------------------

async function getShutterCount() {
  const dev = state.device;

  // 1. Standard GetDeviceInfo (works without a session; gives Model/Serial).
  logLine(`→ GetDeviceInfo ${hex(OP_GetDeviceInfo)}`, "l-dim");
  const di = await ptpTransaction(OP_GetDeviceInfo, [], true);
  if (!di.ok) throw new Error(`GetDeviceInfo failed: ${ptpErrName(di.code)}`);
  const info = parseDeviceInfo(di.data);
  logLine(`  model=${info.model || "?"} serial=${info.serialNumber || "?"} vendorExt=${hex(info.vendorExtID, 8)} ops=${info.operations.length} props=${info.deviceProps.length}`, "l-dim");

  // Detection: newer Canon EOS bodies advertise the MTP/Microsoft vendor
  // extension (0x06) rather than Canon's 0x0B. libgphoto2 ignores that field
  // and keys off the USB vendor id (0x04a9, already filtered on) plus the
  // presence of the Canon EOS vendor operations. We do the same: if the
  // camera supports EOS GetEvent (0x9116), it's an EOS body we can talk to.
  const supports = (op) => info.operations.includes(op);
  const isEos = supports(OP_EOS_GetEvent) && supports(OP_EOS_SetRemoteMode) && supports(OP_EOS_SetEventMode);
  if (!isEos) {
    throw new Error(
      `This Canon camera does not expose the EOS vendor operations ` +
      `(need 0x9114/0x9115/0x9116). Operations: ` +
      info.operations.map((o) => hex(o)).join(" ")
    );
  }
  if (info.vendorExtID !== 0x0000000B) {
    logLine(`  (advertised vendorExt=${hex(info.vendorExtID, 8)}; treating as Canon EOS by operation support, like libgphoto2)`, "l-dim");
  }

  // 2. OpenSession.
  logLine(`→ OpenSession ${hex(OP_OpenSession)}`, "l-dim");
  const os = await ptpTransaction(OP_OpenSession, [1], false);
  if (!os.ok) throw new Error(`OpenSession failed: ${ptpErrName(os.code)}`);

  try {
    // 3. EOS init: SetRemoteMode(1), SetEventMode(1). These make the camera
    //    start emitting device-property-change events over the 0x9116 channel.
    logLine(`→ EOS SetRemoteMode(1) ${hex(OP_EOS_SetRemoteMode)}`, "l-dim");
    const rm = await ptpTransaction(OP_EOS_SetRemoteMode, [1], false);
    if (!rm.ok) logLine(`  SetRemoteMode returned ${ptpErrName(rm.code)} (continuing)`, "l-warn");

    logLine(`→ EOS SetEventMode(1) ${hex(OP_EOS_SetEventMode)}`, "l-dim");
    const em = await ptpTransaction(OP_EOS_SetEventMode, [1], false);
    if (!em.ok) logLine(`  SetEventMode returned ${ptpErrName(em.code)} (continuing)`, "l-warn");

    // 4. Best-effort: explicitly ask the camera for the shutter-counter value.
    //    (libgphoto2 only does this for Owner/Artist/Copyright/Serial, but the
    //    opcode is generic. If it errors, we still fall through to polling.)
    logLine(`→ EOS RequestDevicePropValue(${hex(DPC_EOS_ShutterCounter)}) ${hex(OP_EOS_RequestDevicePropValue)}`, "l-dim");
    const req = await ptpTransaction(OP_EOS_RequestDevicePropValue, [DPC_EOS_ShutterCounter], false);
    if (!req.ok) logLine(`  RequestDevicePropValue returned ${ptpErrName(req.code)} (continuing)`, "l-warn");

    // 5. Poll GetEvent until we see a PropValueChanged for 0xD1ac, or give up.
    let shutter = null;
    const MAX_POLLS = 15;
    for (let i = 0; i < MAX_POLLS; i++) {
      logLine(`→ EOS GetEvent ${hex(OP_EOS_GetEvent)} (poll ${i + 1}/${MAX_POLLS})`, "l-dim");
      const ev = await ptpTransaction(OP_EOS_GetEvent, [], true);
      if (!ev.ok) { logLine(`  GetEvent returned ${ptpErrName(ev.code)}`, "l-warn"); break; }
      if (!ev.data || ev.data.length === 0) { logLine("  (empty event blob)", "l-dim"); continue; }

      const events = parseEosEvents(ev.data);
      logLine(`  ${events.length} event(s)`, "l-dim");
      for (const e of events) {
        if (e.code === EC_EOS_PropValueChanged && e.dpc === DPC_EOS_ShutterCounter) {
          // UINT32 little-endian
          shutter = u32le(e.valueBytes, 0);
          logLine(`  ✓ ShutterCounter = ${shutter}`, "l-ok");
        }
      }
      if (shutter != null) break;
    }

    return { model: info.model, serial: info.serialNumber, shutter };
  } finally {
    // Best-effort CloseSession.
    try {
      logLine(`→ CloseSession ${hex(OP_CloseSession)}`, "l-dim");
      await ptpTransaction(OP_CloseSession, [], false);
    } catch (e) { /* ignore */ }
  }
}

// --- button / lifecycle --------------------------------------------------

async function onConnect() {
  $("connect").disabled = true;
  elResult.classList.add("hidden");
  try {
    setStatus("Requesting device…");
    state.device = await navigator.usb.requestDevice({ filters: [{ vendorId: CANON_VENDOR_ID }] });
    logLine(`Selected ${state.device.manufacturerName} ${state.device.productName} (vid=${hex(state.device.vendorId, 4)} pid=${hex(state.device.productId, 4)})`);

    setStatus("Opening USB…");
    await state.device.open();
    if (state.device.configuration === null) await state.device.selectConfiguration(1);
    discoverEndpoints(state.device);
    await state.device.claimInterface(state.ifaceNum);

    setStatus("Talking to camera…");
    const res = await getShutterCount();

    if (res.shutter == null) {
      setStatus("Connected, but shutter count not reported.", "warn");
      logLine("No PropValueChanged(0xD1ac) event was seen.", "l-warn");
      showResult(res.model, res.serial, null);
    } else {
      setStatus("Done.", "ok");
      showResult(res.model, res.serial, res.shutter);
    }
  } catch (err) {
    logLine("ERROR: " + (err?.message || err), "l-err");
    if (err?.name === "NotFoundError") {
      setStatus("No Canon device selected.", "err");
    } else if (err?.name === "SecurityError" || /claim|interface/i.test(err?.message || "")) {
      setStatus("Could not claim the USB interface — PTPCamera likely holds it. See the note above.", "err");
    } else {
      setStatus("Failed: " + (err?.message || err), "err");
    }
  } finally {
    if (state.device && state.device.opened) {
      try { await state.device.close(); } catch (_) {}
    }
    $("connect").disabled = false;
  }
}

$("connect").addEventListener("click", onConnect);

// Hot-plug / disconnect handling.
navigator.usb?.addEventListener("disconnect", () => {
  setStatus("Device disconnected.", "warn");
  elResult.classList.add("hidden");
});

if (!("usb" in navigator)) {
  setStatus("WebUSB not supported in this browser. Use Chrome / Edge.", "err");
  $("connect").disabled = true;
}

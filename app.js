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

// Canon EOS device property codes we care about.
const DPC_EOS_Owner               = 0xD115;
const DPC_EOS_ModelID             = 0xD116;
const DPC_EOS_CameraTime          = 0xD113;
const DPC_EOS_PTPExtensionVersion = 0xD119;
const DPC_EOS_AvailableShots      = 0xD11B;
const DPC_EOS_BatteryPower        = 0xD111;
const DPC_EOS_Nickname            = 0xD125;
const DPC_EOS_TempStatus          = 0xD1ab;
const DPC_EOS_ExtenderType        = 0xD198;
const DPC_EOS_LensStatus          = 0xD1a8;
const DPC_EOS_BatteryInfo         = 0xD1a6; // structured blob — not decoded
const DPC_EOS_ShutterCounter      = 0xD1ac;
const DPC_EOS_SerialNumber        = 0xD1af;
const DPC_EOS_LensName            = 0xD1d8;
const DPC_EOS_LensID              = 0xD1dd;
const DPC_EOS_Artist              = 0xD1d0;
const DPC_EOS_Copyright           = 0xD1d1;

// Metadata for every property we display. type is how the bytes are encoded
// in the PropValueChanged event (per ptp-pack.c's DataType switch).
// fmt/decode turn the raw number into something human-readable.
const BATTERY_LEVEL = { 0: "Low", 1: "50%", 2: "100%", 4: "75%", 5: "25%" };
const PROPS = {
  [DPC_EOS_Owner]:               { name: "Owner",            type: "str" },
  [DPC_EOS_Artist]:              { name: "Artist",           type: "str" },
  [DPC_EOS_Copyright]:           { name: "Copyright",        type: "str" },
  [DPC_EOS_Nickname]:            { name: "Nickname",         type: "str" },
  [DPC_EOS_SerialNumber]:        { name: "Serial number",    type: "str" },
  [DPC_EOS_LensName]:            { name: "Lens",             type: "str" },
  [DPC_EOS_ShutterCounter]:      { name: "Shutter count",    type: "u32" },
  [DPC_EOS_AvailableShots]:      { name: "Available shots",  type: "u32" },
  [DPC_EOS_BatteryPower]:        { name: "Battery",          type: "u16", decode: (v) => BATTERY_LEVEL[v] ?? `level ${v}` },
  [DPC_EOS_ModelID]:             { name: "Model ID",         type: "u32", decode: (v) => MODEL_ID_NAMES[v] ? `${MODEL_ID_NAMES[v]} (${hex(v, 8)})` : hex(v, 8) },
  [DPC_EOS_LensStatus]:          { name: "Lens status",      type: "u32" },
  [DPC_EOS_TempStatus]:          { name: "Temperature",      type: "u32" },
  [DPC_EOS_CameraTime]:          { name: "Camera time",      type: "u32", decode: (v) => v ? new Date(v * 1000).toLocaleString() : "—" },
};

// Properties libgphoto2 explicitly requests via RequestDevicePropValue
// after EOS init (config.c:405-408) — strings that aren't pushed in the
// initial event dump. We add LensName/Nickname too since they're strings.
const REQUEST_PROPS = [
  DPC_EOS_Owner, DPC_EOS_Artist, DPC_EOS_Copyright,
  DPC_EOS_SerialNumber, DPC_EOS_LensName, DPC_EOS_Nickname,
];

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
const elResult = $("result"), elShutter = $("shutter"), elExtra = $("extra");

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
function addRow(label, value) {
  const row = document.createElement("div");
  row.className = "cell";
  const lab = document.createElement("span"); lab.className = "label"; lab.textContent = label;
  const val = document.createElement("span"); val.className = "value"; val.textContent = value ?? "—";
  row.append(lab, val);
  elExtra.appendChild(row);
}
function showResult(model, serial, shutter, extra) {
  elShutter.textContent = shutter != null ? shutter.toLocaleString() : "—";
  elExtra.replaceChildren();
  addRow("Camera model", model);
  addRow("Serial number", serial);
  // extra is an array of {label, value} in display order
  for (const v of extra) addRow(v.label, v.value);
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

// EOS string property values are PLAIN null-terminated ASCII/UTF-8 — not the
// length-prefixed UTF-16LE used by standard PTP DeviceInfo strings.
// (ptp-pack.c PropValueChanged STR case: `strdup((char*)xdata)`, with the
// comment "5D MII and 400D actually store plain ASCII in their string props".)
function decodeEosString(bytes) {
  if (!bytes || bytes.length === 0) return "";
  let end = bytes.length;
  for (let i = 0; i < bytes.length; i++) { if (bytes[i] === 0) { end = i; break; } }
  return new TextDecoder("utf-8").decode(bytes.subarray(0, end));
}

// Canon EOS ModelID -> name (ExifTool CanonModelID table; the PTP
// DPC_CANON_EOS_ModelID uses the same encoding, e.g. 0x80000250 = EOS 7D).
const MODEL_ID_NAMES = {
  0x80000001: "EOS-1D",
  0x80000167: "EOS-1Ds",
  0x80000168: "EOS 10D",
  0x80000169: "EOS-1D Mark III",
  0x80000170: "EOS 300D / Rebel / Kiss Digital",
  0x80000174: "EOS-1D Mark II",
  0x80000175: "EOS 20D",
  0x80000176: "EOS 450D / Rebel XSi / Kiss X2",
  0x80000188: "EOS-1Ds Mark II",
  0x80000189: "EOS 350D / Rebel XT / Kiss Digital N",
  0x80000190: "EOS 40D",
  0x80000213: "EOS 5D",
  0x80000215: "EOS-1Ds Mark III",
  0x80000218: "EOS 5D Mark II",
  0x80000232: "EOS-1D Mark II N",
  0x80000234: "EOS 30D",
  0x80000236: "EOS 400D / Rebel XTi / Kiss Digital X",
  0x80000250: "EOS 7D",
  0x80000252: "EOS 500D / Rebel T1i / Kiss X3",
  0x80000254: "EOS 1000D / Rebel XS / Kiss F",
  0x80000261: "EOS 50D",
  0x80000269: "EOS-1D X",
  0x80000270: "EOS 550D / Rebel T2i / Kiss X4",
  0x80000281: "EOS-1D Mark IV",
  0x80000285: "EOS 5D Mark III",
  0x80000286: "EOS 600D / Rebel T3i / Kiss X5",
  0x80000287: "EOS 60D",
  0x80000288: "EOS 1100D / Rebel T3 / Kiss X50",
  0x80000289: "EOS 7D Mark II",
  0x80000301: "EOS 650D / Rebel T4i / Kiss X6i",
  0x80000302: "EOS 6D",
  0x80000324: "EOS-1D C",
  0x80000325: "EOS 70D",
  0x80000326: "EOS 700D / Rebel T5i / Kiss X7i",
  0x80000327: "EOS 1200D / Rebel T5 / Kiss X70",
  0x80000346: "EOS 100D / Rebel SL1 / Kiss X7",
  0x80000350: "EOS 80D",
};

// Decode a PropValueChanged value payload given property metadata.
function decodeProp(meta, valueBytes) {
  let raw;
  switch (meta.type) {
    case "str":  return decodeEosString(valueBytes);
    case "u16":  raw = u16le(valueBytes, 0); break;
    case "u32":  raw = u32le(valueBytes, 0); break;
    default: return hex(valueBytes[0]);
  }
  if (meta.decode) return meta.decode(raw);
  return raw.toLocaleString();
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

// --- the camera-info flow ----------------------------------------------

async function getCameraInfo() {
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

    // 4. Best-effort: explicitly request the string props that aren't pushed
    //    in the initial event dump (mirrors libgphoto2 config.c:405-408,
    //    plus LensName/Nickname).
    for (const dpc of REQUEST_PROPS) {
      const r = await ptpTransaction(OP_EOS_RequestDevicePropValue, [dpc], false);
      logLine(`→ RequestDevicePropValue(${hex(dpc)}) → ${r.ok ? "ok" : ptpErrName(r.code)}`, r.ok ? "l-dim" : "l-warn");
    }

    // 5. Poll GetEvent, collecting every property we know how to decode.
    //    Stop once we've seen the shutter count, or after MAX_POLLS.
    const collected = new Map(); // dpc -> decoded value
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
        if (e.code !== EC_EOS_PropValueChanged) continue;
        const meta = PROPS[e.dpc];
        if (!meta) continue;
        const decoded = decodeProp(meta, e.valueBytes);
        collected.set(e.dpc, decoded);
        logLine(`  ✓ ${meta.name} (${hex(e.dpc)}) = ${decoded || "(empty)"}`, "l-ok");
        if (e.dpc === DPC_EOS_ShutterCounter) shutter = decoded;
      }
      if (shutter != null) break;
    }

    // 6. Build an ordered extras list (identity first, then diagnostics).
    const serial = collected.get(DPC_EOS_SerialNumber) || info.serialNumber;
    const extra = [];
    const pushIf = (dpc) => { if (collected.has(dpc)) extra.push({ label: PROPS[dpc].name, value: collected.get(dpc) }); };
    // Identity
    pushIf(DPC_EOS_Owner);
    pushIf(DPC_EOS_Artist);
    pushIf(DPC_EOS_Copyright);
    pushIf(DPC_EOS_Nickname);
    pushIf(DPC_EOS_LensName);
    if (info.deviceVersion) extra.push({ label: "Firmware version", value: info.deviceVersion });
    // Diagnostics
    pushIf(DPC_EOS_AvailableShots);
    pushIf(DPC_EOS_BatteryPower);
    pushIf(DPC_EOS_TempStatus);
    pushIf(DPC_EOS_LensStatus);
    pushIf(DPC_EOS_ModelID);
    pushIf(DPC_EOS_CameraTime);

    return { model: info.model, serial, shutter, extra };
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
    const res = await getCameraInfo();

    if (res.shutter == null) {
      setStatus("Connected, but shutter count not reported.", "warn");
      logLine("No PropValueChanged(0xD1ac) event was seen.", "l-warn");
    } else {
      setStatus("Done.", "ok");
    }
    showResult(res.model, res.serial, res.shutter, res.extra);
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
  setStatus("Device disconnected (last reading kept below).", "warn");
});

if (!("usb" in navigator)) {
  setStatus("WebUSB not supported in this browser. Use Chrome / Edge.", "err");
  $("connect").disabled = true;
}

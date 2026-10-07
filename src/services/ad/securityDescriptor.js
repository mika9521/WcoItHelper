// Minimal parser/writer for self-relative Windows security descriptors, used
// for "User cannot change password". AD ignores the PASSWD_CANT_CHANGE bit
// in userAccountControl; ADUC implements the option as deny ACEs for the
// "Change Password" extended right granted to SELF and Everyone.
const { Control } = require('ldapts');

const CHANGE_PASSWORD_GUID = 'ab721a53-1e2f-11d0-9819-00aa0040529b';
const SID_SELF = 'S-1-5-10';
const SID_EVERYONE = 'S-1-1-0';

const ACE_ALLOWED_OBJECT = 0x05;
const ACE_DENIED_OBJECT = 0x06;
const ACE_INHERITED = 0x10;
const ADS_RIGHT_DS_CONTROL_ACCESS = 0x100;
const ACE_OBJECT_TYPE_PRESENT = 0x1;
const ACE_INHERITED_OBJECT_TYPE_PRESENT = 0x2;
const ACL_REVISION_DS = 4;
const SE_DACL_PRESENT = 0x0004;
const SE_SELF_RELATIVE = 0x8000;

// LDAP_SERVER_SD_FLAGS_OID: read/write only the DACL (flags = 4), which the
// service account can do without SeSecurityPrivilege (needed for the SACL).
class SdFlagsControl extends Control {
  constructor(flags = 4) {
    super('1.2.840.113556.1.4.801', { critical: true });
    this.flags = flags;
  }

  writeControl(writer) {
    // BER: SEQUENCE { INTEGER flags }
    writer.writeBuffer(Buffer.from([0x30, 0x03, 0x02, 0x01, this.flags]), 0x04);
  }
}

function guidToBuffer(guid) {
  const hex = guid.replace(/-/g, '');
  const b = Buffer.from(hex, 'hex');
  // First three groups are little-endian in the binary form.
  return Buffer.concat([
    Buffer.from(b.subarray(0, 4)).reverse(),
    Buffer.from(b.subarray(4, 6)).reverse(),
    Buffer.from(b.subarray(6, 8)).reverse(),
    b.subarray(8, 16)
  ]);
}

function sidToBuffer(sid) {
  const parts = sid.split('-').slice(1).map(Number);
  const [revision, authority, ...subs] = parts;
  const buf = Buffer.alloc(8 + subs.length * 4);
  buf.writeUInt8(revision, 0);
  buf.writeUInt8(subs.length, 1);
  buf.writeUIntBE(authority, 2, 6);
  subs.forEach((sub, i) => buf.writeUInt32LE(sub, 8 + i * 4));
  return buf;
}

function sidLength(buf, offset) {
  return 8 + buf.readUInt8(offset + 1) * 4;
}

function readAcl(buf, offset) {
  if (!offset) return null;
  const size = buf.readUInt16LE(offset + 2);
  const count = buf.readUInt16LE(offset + 4);
  const aces = [];
  let pos = offset + 8;
  for (let i = 0; i < count; i += 1) {
    const aceSize = buf.readUInt16LE(pos + 2);
    aces.push(Buffer.from(buf.subarray(pos, pos + aceSize)));
    pos += aceSize;
  }
  return { revision: buf.readUInt8(offset), size, aces };
}

function writeAcl(revision, aces) {
  const body = Buffer.concat(aces);
  const header = Buffer.alloc(8);
  header.writeUInt8(revision, 0);
  header.writeUInt16LE(8 + body.length, 2);
  header.writeUInt16LE(aces.length, 4);
  return Buffer.concat([header, body]);
}

function parseSecurityDescriptor(buf) {
  const control = buf.readUInt16LE(2);
  const ownerOff = buf.readUInt32LE(4);
  const groupOff = buf.readUInt32LE(8);
  const saclOff = buf.readUInt32LE(12);
  const daclOff = buf.readUInt32LE(16);
  const slice = (off, len) => (off ? Buffer.from(buf.subarray(off, off + len)) : null);
  const sacl = saclOff ? slice(saclOff, buf.readUInt16LE(saclOff + 2)) : null;
  return {
    revision: buf.readUInt8(0),
    control,
    owner: ownerOff ? slice(ownerOff, sidLength(buf, ownerOff)) : null,
    group: groupOff ? slice(groupOff, sidLength(buf, groupOff)) : null,
    sacl,
    dacl: readAcl(buf, daclOff)
  };
}

function buildSecurityDescriptor(sd) {
  const parts = [];
  let offset = 20;
  const place = (blob) => {
    if (!blob) return 0;
    const at = offset;
    parts.push(blob);
    offset += blob.length;
    return at;
  };
  const daclBlob = sd.dacl ? writeAcl(sd.dacl.revision, sd.dacl.aces) : null;
  const saclOff = place(sd.sacl);
  const daclOff = place(daclBlob);
  const ownerOff = place(sd.owner);
  const groupOff = place(sd.group);
  const header = Buffer.alloc(20);
  header.writeUInt8(sd.revision || 1, 0);
  header.writeUInt16LE(sd.control | SE_SELF_RELATIVE | (daclBlob ? SE_DACL_PRESENT : 0), 2);
  header.writeUInt32LE(ownerOff, 4);
  header.writeUInt32LE(groupOff, 8);
  header.writeUInt32LE(saclOff, 12);
  header.writeUInt32LE(daclOff, 16);
  return Buffer.concat([header, ...parts]);
}

function describeObjectAce(ace) {
  const type = ace.readUInt8(0);
  if (type !== ACE_ALLOWED_OBJECT && type !== ACE_DENIED_OBJECT) return null;
  const flags = ace.readUInt8(1);
  const objFlags = ace.readUInt32LE(8);
  let pos = 12;
  let objectType = null;
  if (objFlags & ACE_OBJECT_TYPE_PRESENT) {
    objectType = ace.subarray(pos, pos + 16);
    pos += 16;
  }
  if (objFlags & ACE_INHERITED_OBJECT_TYPE_PRESENT) pos += 16;
  return { type, inherited: Boolean(flags & ACE_INHERITED), objectType, sid: ace.subarray(pos) };
}

function buildObjectAce(type, sid, guid) {
  const sidBuf = sidToBuffer(sid);
  const ace = Buffer.alloc(12 + 16 + sidBuf.length);
  ace.writeUInt8(type, 0);
  ace.writeUInt8(0, 1);
  ace.writeUInt16LE(ace.length, 2);
  ace.writeUInt32LE(ADS_RIGHT_DS_CONTROL_ACCESS, 4);
  ace.writeUInt32LE(ACE_OBJECT_TYPE_PRESENT, 8);
  guidToBuffer(guid).copy(ace, 12);
  sidBuf.copy(ace, 28);
  return ace;
}

const CHANGE_PWD_GUID_BUF = guidToBuffer(CHANGE_PASSWORD_GUID);
const TARGET_SIDS = [sidToBuffer(SID_SELF), sidToBuffer(SID_EVERYONE)];

function isChangePasswordAce(info) {
  return info
    && info.objectType
    && info.objectType.equals(CHANGE_PWD_GUID_BUF)
    && TARGET_SIDS.some((sid) => sid.equals(info.sid));
}

function getCannotChangePassword(sdBuffer) {
  const { dacl } = parseSecurityDescriptor(sdBuffer);
  if (!dacl) return false;
  const selfSid = TARGET_SIDS[0];
  return dacl.aces.some((ace) => {
    const info = describeObjectAce(ace);
    return isChangePasswordAce(info) && info.type === ACE_DENIED_OBJECT && info.sid.equals(selfSid);
  });
}

// Returns a new security descriptor with the explicit Change Password ACEs
// for SELF and Everyone replaced by deny (enabled) or allow (disabled) ACEs,
// keeping canonical order: explicit deny, explicit allow, inherited.
function setCannotChangePassword(sdBuffer, enabled) {
  const sd = parseSecurityDescriptor(sdBuffer);
  const existing = sd.dacl ? sd.dacl.aces : [];
  const kept = existing.filter((ace) => {
    const info = describeObjectAce(ace);
    return !(isChangePasswordAce(info) && !info.inherited);
  });
  const newAces = [SID_SELF, SID_EVERYONE].map((sid) => buildObjectAce(enabled ? ACE_DENIED_OBJECT : ACE_ALLOWED_OBJECT, sid, CHANGE_PASSWORD_GUID));

  let aces;
  if (enabled) {
    aces = [...newAces, ...kept];
  } else {
    const firstInherited = kept.findIndex((ace) => Boolean(ace.readUInt8(1) & ACE_INHERITED));
    const at = firstInherited === -1 ? kept.length : firstInherited;
    aces = [...kept.slice(0, at), ...newAces, ...kept.slice(at)];
  }
  sd.dacl = { revision: Math.max(sd.dacl?.revision || 0, ACL_REVISION_DS), aces };
  return buildSecurityDescriptor(sd);
}

module.exports = {
  SdFlagsControl,
  getCannotChangePassword,
  setCannotChangePassword,
  // exported for tests
  parseSecurityDescriptor,
  buildSecurityDescriptor,
  sidToBuffer,
  guidToBuffer
};

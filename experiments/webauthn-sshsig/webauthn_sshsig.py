"""Make an SSHSIG signature in OpenSSH's webauthn-sk-ecdsa format with a
software P-256 key, as a browser passkey assertion would produce it.
usage: webauthn_sshsig.py <outdir> <message-file> <flags-hex> [rp_id]"""
import sys, os, hashlib, base64, struct, json
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature

def s(b): b = b.encode() if isinstance(b, str) else b; return struct.pack(">I", len(b)) + b
def mpint(n):
    b = n.to_bytes((n.bit_length() + 8) // 8 or 1, "big")  # leading zero when high bit set
    return s(b)
b64u = lambda b: base64.urlsafe_b64encode(b).rstrip(b"=").decode()

out, msg_file, flags = sys.argv[1], sys.argv[2], int(sys.argv[3], 16)
rp_id = sys.argv[4] if len(sys.argv) > 4 else "passkeys.example.org"
os.makedirs(out, exist_ok=True)
kp = os.path.join(out, "key.pem")
if os.path.exists(kp):
    key = serialization.load_pem_private_key(open(kp, "rb").read(), None)
else:
    key = ec.generate_private_key(ec.SECP256R1())
    open(kp, "wb").write(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
Q = key.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
ktype = "sk-ecdsa-sha2-nistp256@openssh.com"
pub = s(ktype) + s("nistp256") + s(Q) + s(rp_id)
open(os.path.join(out, "key.pub"), "w").write(f"{ktype} {base64.b64encode(pub).decode()}\n")

msg = open(msg_file, "rb").read()
ns, halg = "git", "sha512"
to_sign = b"SSHSIG" + s(ns) + s("") + s(halg) + s(hashlib.sha512(msg).digest())
origin = f"https://{rp_id}"
client = '{"type":"webauthn.get","challenge":"%s","origin":"%s","crossOrigin":false}' % (b64u(to_sign), origin)
counter = 1
auth_data = hashlib.sha256(rp_id.encode()).digest() + bytes([flags]) + struct.pack(">I", counter)
der = key.sign(auth_data + hashlib.sha256(client.encode()).digest(), ec.ECDSA(hashes.SHA256()))
r, s_ = decode_dss_signature(der)
sig = (s("webauthn-sk-ecdsa-sha2-nistp256@openssh.com") + s(mpint(r) + mpint(s_))
       + bytes([flags]) + struct.pack(">I", counter) + s(origin) + s(client) + s(b""))
blob = b"SSHSIG" + struct.pack(">I", 1) + s(pub) + s(ns) + s("") + s(halg) + s(sig)
b = base64.b64encode(blob).decode()
armored = "-----BEGIN SSH SIGNATURE-----\n" + "\n".join(b[i:i+70] for i in range(0, len(b), 70)) + "\n-----END SSH SIGNATURE-----\n"
sys.stdout.write(armored)

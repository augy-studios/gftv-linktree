// The browser half of passkeys: turning the server's JSON options into what
// navigator.credentials expects, and the result back into JSON. Written out
// by hand rather than vendoring a library; it is two conversions.

export function passkeysSupported() {
  return typeof window.PublicKeyCredential === 'function' && typeof navigator.credentials?.create === 'function';
}

function fromBase64url(value) {
  const padded = String(value).replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function toBase64url(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function createPasskey(options) {
  const credential = await navigator.credentials.create({
    publicKey: {
      ...options,
      challenge: fromBase64url(options.challenge),
      user: { ...options.user, id: fromBase64url(options.user.id) },
      excludeCredentials: (options.excludeCredentials ?? []).map((item) => ({ ...item, id: fromBase64url(item.id) })),
    },
  });
  if (!credential) throw new Error('no credential');
  return {
    id: credential.id,
    rawId: toBase64url(credential.rawId),
    type: credential.type,
    clientExtensionResults: credential.getClientExtensionResults(),
    authenticatorAttachment: credential.authenticatorAttachment ?? undefined,
    response: {
      clientDataJSON: toBase64url(credential.response.clientDataJSON),
      attestationObject: toBase64url(credential.response.attestationObject),
      transports: credential.response.getTransports?.() ?? [],
    },
  };
}

export async function usePasskey(options) {
  const assertion = await navigator.credentials.get({
    publicKey: {
      ...options,
      challenge: fromBase64url(options.challenge),
      allowCredentials: (options.allowCredentials ?? []).map((item) => ({ ...item, id: fromBase64url(item.id) })),
    },
  });
  if (!assertion) throw new Error('no assertion');
  return {
    id: assertion.id,
    rawId: toBase64url(assertion.rawId),
    type: assertion.type,
    clientExtensionResults: assertion.getClientExtensionResults(),
    authenticatorAttachment: assertion.authenticatorAttachment ?? undefined,
    response: {
      clientDataJSON: toBase64url(assertion.response.clientDataJSON),
      authenticatorData: toBase64url(assertion.response.authenticatorData),
      signature: toBase64url(assertion.response.signature),
      userHandle: assertion.response.userHandle ? toBase64url(assertion.response.userHandle) : undefined,
    },
  };
}

// The person closed the prompt, or it timed out, or the browser refused to
// show it. Browsers report all three as NotAllowedError.
export function wasCancelled(error) {
  return error?.name === 'NotAllowedError' || error?.name === 'AbortError';
}

// The error code to show for a failed passkey prompt, so the page always says
// what happened rather than going quiet. An error already carrying a server
// code is passed through. The browser's own reason goes to the console, which
// is the first thing to look at when a passkey will not work on a device.
export function passkeyErrorCode(error) {
  if (error?.code) return error.code;
  console.warn('[passkey]', error?.name, error?.message);
  if (wasCancelled(error)) return 'passkey_cancelled';
  if (error?.name === 'InvalidStateError') return 'passkey_exists';
  return 'passkey_failed';
}

// The browser half of passkeys: turning the server's JSON options into what
// navigator.credentials expects, and the result back into JSON. Written out
// by hand rather than vendoring a library; it is two conversions.

export function passkeysSupported() {
  if (typeof window.PublicKeyCredential !== 'function') {
    return false;
  }
  const credentials = navigator.credentials;
  if (credentials === null || credentials === undefined) {
    return false;
  }
  return typeof credentials.create === 'function';
}

function fromBase64url(value) {
  const padded = String(value).replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function toBase64url(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Make a new passkey from the server's creation options, and return the
// result in the JSON shape the server reads.
export async function createPasskey(options) {
  // No list from the server means nothing to exclude.
  let excludeCredentials = options.excludeCredentials;
  if (excludeCredentials === null || excludeCredentials === undefined) {
    excludeCredentials = [];
  }
  const credential = await navigator.credentials.create({
    publicKey: {
      ...options,
      challenge: fromBase64url(options.challenge),
      user: { ...options.user, id: fromBase64url(options.user.id) },
      excludeCredentials: excludeCredentials.map((item) => ({ ...item, id: fromBase64url(item.id) })),
    },
  });
  if (!credential) {
    throw new Error('no credential');
  }
  // A null attachment becomes undefined, so the key is left out of the JSON.
  let authenticatorAttachment = credential.authenticatorAttachment;
  if (authenticatorAttachment === null) {
    authenticatorAttachment = undefined;
  }
  // Some browsers have no getTransports, or return nothing: an empty list then.
  let transports = [];
  if (credential.response.getTransports !== null && credential.response.getTransports !== undefined) {
    const reported = credential.response.getTransports();
    if (reported !== null && reported !== undefined) {
      transports = reported;
    }
  }
  return {
    id: credential.id,
    rawId: toBase64url(credential.rawId),
    type: credential.type,
    clientExtensionResults: credential.getClientExtensionResults(),
    authenticatorAttachment,
    response: {
      clientDataJSON: toBase64url(credential.response.clientDataJSON),
      attestationObject: toBase64url(credential.response.attestationObject),
      transports,
    },
  };
}

// Sign in with a passkey from the server's request options, and return the
// result in the JSON shape the server reads.
export async function usePasskey(options) {
  // No list from the server means any passkey for this site may answer.
  let allowCredentials = options.allowCredentials;
  if (allowCredentials === null || allowCredentials === undefined) {
    allowCredentials = [];
  }
  const assertion = await navigator.credentials.get({
    publicKey: {
      ...options,
      challenge: fromBase64url(options.challenge),
      allowCredentials: allowCredentials.map((item) => ({ ...item, id: fromBase64url(item.id) })),
    },
  });
  if (!assertion) {
    throw new Error('no assertion');
  }
  // A null attachment becomes undefined, so the key is left out of the JSON.
  let authenticatorAttachment = assertion.authenticatorAttachment;
  if (authenticatorAttachment === null) {
    authenticatorAttachment = undefined;
  }
  let userHandle;
  if (assertion.response.userHandle) {
    userHandle = toBase64url(assertion.response.userHandle);
  } else {
    userHandle = undefined;
  }
  return {
    id: assertion.id,
    rawId: toBase64url(assertion.rawId),
    type: assertion.type,
    clientExtensionResults: assertion.getClientExtensionResults(),
    authenticatorAttachment,
    response: {
      clientDataJSON: toBase64url(assertion.response.clientDataJSON),
      authenticatorData: toBase64url(assertion.response.authenticatorData),
      signature: toBase64url(assertion.response.signature),
      userHandle,
    },
  };
}

// The person closed the prompt, or it timed out, or the browser refused to
// show it. Browsers report all three as NotAllowedError.
export function wasCancelled(error) {
  if (error === null || error === undefined) {
    return false;
  }
  if (error.name === 'NotAllowedError' || error.name === 'AbortError') {
    return true;
  }
  return false;
}

// The error code to show for a failed passkey prompt, so the page always says
// what happened rather than going quiet. An error already carrying a server
// code is passed through. The browser's own reason goes to the console, which
// is the first thing to look at when a passkey will not work on a device.
export function passkeyErrorCode(error) {
  // error can be null or undefined; then it has no code, name or message.
  let code;
  let name;
  let message;
  if (error !== null && error !== undefined) {
    code = error.code;
    name = error.name;
    message = error.message;
  }
  if (code) {
    return code;
  }
  console.warn('[passkey]', name, message);
  if (wasCancelled(error)) {
    return 'passkey_cancelled';
  }
  if (name === 'InvalidStateError') {
    return 'passkey_exists';
  }
  return 'passkey_failed';
}

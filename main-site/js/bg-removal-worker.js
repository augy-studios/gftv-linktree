// Background removal, off the main thread so the page stays responsive.
//
// Runs IS-Net (assets/models/, Apache-2.0) with onnxruntime-web (MIT), both
// served from this site. The picture never leaves the device.
//
// Messages in:   { type: 'remove', id, bitmap }   an ImageBitmap, transferred
// Messages out:  { type: 'progress', id, stage: 'download' | 'run', loaded, total }
//                { type: 'done', id, mask }        Uint8ClampedArray, 1024 x 1024 alpha
//                { type: 'error', id, message }

import * as ort from '/assets/vendor/ort/ort.wasm.bundle.min.mjs';

const MODEL_URL = '/assets/models/isnet-general-use-int8.onnx';
// Kept in its own cache, so it survives service worker updates and is fetched
// once per device rather than once per visit. Rename with the model file.
const MODEL_CACHE = 'onelink-models-v1';
const SIZE = 1024;

ort.env.wasm.wasmPaths = '/assets/vendor/ort/';
// Threads need cross-origin isolation, which this site does not enable.
ort.env.wasm.numThreads = 1;
ort.env.wasm.proxy = false;
// Errors only: the runtime's start-up notices mean nothing to a visitor.
ort.env.logLevel = 'error';

let session = null;

// The model's bytes: the cached copy when there is one, otherwise a download
// that reports its progress and then keeps a copy in the cache.
async function loadModel(id) {
  const cache = await caches.open(MODEL_CACHE).catch(() => null);
  let response;
  if (cache) {
    response = await cache.match(MODEL_URL);
  } else {
    response = null;
  }
  if (!response) {
    response = await fetch(MODEL_URL);
    if (!response.ok) {
      throw new Error(`model ${response.status}`);
    }
    // Report download progress, then keep a copy.
    let total = Number(response.headers.get('content-length'));
    if (!total) {
      total = 0;
    }
    const reader = response.body.getReader();
    const chunks = [];
    let loaded = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      chunks.push(value);
      loaded += value.length;
      self.postMessage({ type: 'progress', id, stage: 'download', loaded, total });
    }
    const blob = new Blob(chunks);
    if (cache) {
      await cache.put(MODEL_URL, new Response(blob)).catch(() => {});
    }
    return new Uint8Array(await blob.arrayBuffer());
  }
  return new Uint8Array(await response.arrayBuffer());
}

async function getSession(id) {
  if (!session) {
    session = await ort.InferenceSession.create(await loadModel(id), { executionProviders: ['wasm'] });
  }
  return session;
}

// The bitmap at 1024 x 1024, as a planar float tensor with IS-Net's
// normalisation: (x / 255 - 0.5) / 1.
function toTensor(bitmap) {
  const canvas = new OffscreenCanvas(SIZE, SIZE);
  const context = canvas.getContext('2d');
  context.drawImage(bitmap, 0, 0, SIZE, SIZE);
  const { data } = context.getImageData(0, 0, SIZE, SIZE);
  const plane = SIZE * SIZE;
  const input = new Float32Array(3 * plane);
  // RGBA pixels in, three planes out: all the red, then the green, then the blue.
  for (let pixel = 0; pixel < plane; pixel += 1) {
    input[pixel] = data[pixel * 4] / 255 - 0.5;
    input[plane + pixel] = data[pixel * 4 + 1] / 255 - 0.5;
    input[2 * plane + pixel] = data[pixel * 4 + 2] / 255 - 0.5;
  }
  return new ort.Tensor('float32', input, [1, 3, SIZE, SIZE]);
}

// Min-max normalise the prediction, then a gentle levels step: faint haze
// near zero goes fully clear and near-certain subject goes fully solid,
// while everything between stays soft, so fur, hair and whiskers keep their
// edges instead of being cut along a hard line.
function toMask(prediction) {
  let min = Infinity;
  let max = -Infinity;
  for (const value of prediction) {
    if (value < min) {
      min = value;
    }
    if (value > max) {
      max = value;
    }
  }
  let range = max - min;
  if (!range) {
    range = 1;
  }
  const LOW = 0.06;
  const HIGH = 0.94;
  const mask = new Uint8ClampedArray(prediction.length);
  for (let index = 0; index < prediction.length; index += 1) {
    const level = ((prediction[index] - min) / range - LOW) / (HIGH - LOW);
    mask[index] = level * 255;
  }
  return mask;
}

self.addEventListener('message', async (event) => {
  let data = event.data;
  if (!data) {
    data = {};
  }
  const { type, id, bitmap } = data;
  if (type !== 'remove') {
    return;
  }
  try {
    const inferenceSession = await getSession(id);
    self.postMessage({ type: 'progress', id, stage: 'run' });
    const output = await inferenceSession.run({ [inferenceSession.inputNames[0]]: toTensor(bitmap) });
    const prediction = output[inferenceSession.outputNames[0]].data;
    if (bitmap.close !== null && bitmap.close !== undefined) {
      bitmap.close();
    }
    const mask = toMask(prediction);
    self.postMessage({ type: 'done', id, mask }, [mask.buffer]);
  } catch (error) {
    // The error's message, or the thrown value itself when it has none.
    let detail;
    if (error !== null && error !== undefined) {
      detail = error.message;
    }
    if (detail === null || detail === undefined) {
      detail = error;
    }
    self.postMessage({ type: 'error', id, message: String(detail) });
  }
});

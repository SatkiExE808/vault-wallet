// QR camera scanner — opens a fullscreen video, decodes frames with jsQR,
// resolves with the decoded string (or rejects on Cancel / camera denied).
//
// Many wallet QRs encode an address inside a URI like "bitcoin:bc1q..." or
// "ethereum:0x...". extractAddress() strips that prefix so the recipient
// input gets a clean address.
const QrScanner = (() => {
  // Strip any "<scheme>:" prefix and any "?amount=..." query so we hand back
  // a bare address. Works for bitcoin: / litecoin: / dogecoin: / ethereum: /
  // monero: / tron: / solana: and the otpauth: case (we just leave that
  // alone since otpauth isn't an address).
  function extractAddress(text) {
    if (!text) return '';
    const cleaned = String(text).trim();
    const m = cleaned.match(/^([a-z][a-z0-9+.-]*):([^?]+)/i);
    if (m && m[1].toLowerCase() !== 'otpauth') return m[2].trim();
    return cleaned;
  }

  async function open() {
    if (typeof jsQR === 'undefined') {
      throw new Error('QR scanner library not loaded');
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('Camera not available on this device');
    }
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' },
        audio: false,
      });
    } catch (e) {
      throw new Error('Camera permission denied');
    }

    return new Promise((resolve, reject) => {
      const root = document.createElement('div');
      root.className = 'qr-scanner-overlay';
      root.innerHTML = `
        <video id="qrs-video" autoplay playsinline muted></video>
        <canvas id="qrs-canvas" style="display:none"></canvas>
        <div class="qrs-frame">
          <div class="qrs-corner qrs-tl"></div>
          <div class="qrs-corner qrs-tr"></div>
          <div class="qrs-corner qrs-bl"></div>
          <div class="qrs-corner qrs-br"></div>
        </div>
        <div class="qrs-hint">Align a QR code inside the frame</div>
        <button class="btn btn-outline qrs-cancel" id="qrs-cancel">Cancel</button>
      `;
      document.body.appendChild(root);

      const video = root.querySelector('#qrs-video');
      const canvas = root.querySelector('#qrs-canvas');
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      video.srcObject = stream;

      let stopped = false;
      const teardown = () => {
        stopped = true;
        try { stream.getTracks().forEach(t => t.stop()); } catch {}
        root.remove();
      };

      root.querySelector('#qrs-cancel').onclick = () => {
        teardown();
        reject(new Error('Cancelled'));
      };

      function scan() {
        if (stopped) return;
        if (video.readyState >= video.HAVE_ENOUGH_DATA && video.videoWidth > 0) {
          if (canvas.width !== video.videoWidth)  canvas.width = video.videoWidth;
          if (canvas.height !== video.videoHeight) canvas.height = video.videoHeight;
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
          const code = jsQR(img.data, img.width, img.height, { inversionAttempts: 'attemptBoth' });
          if (code && code.data) {
            teardown();
            resolve(code.data);
            return;
          }
        }
        requestAnimationFrame(scan);
      }
      video.addEventListener('loadedmetadata', scan, { once: true });
    });
  }

  return { open, extractAddress };
})();

window.QrScanner = QrScanner;
